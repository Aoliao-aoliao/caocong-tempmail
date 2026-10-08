import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { posix } from 'node:path';
import { safeAttachmentName } from './mail-utils.mjs';

function assertChildPath(root, candidate) {
  const relation = relative(root, candidate);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error('Unsafe attachment storage path.');
  }
}

export class AttachmentStore {
  constructor(root) {
    this.root = resolve(root);
    this.cleanupQueue = resolve(this.root, '.cleanup-pending');
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.cleanupQueue, { recursive: true, mode: 0o700 });
  }

  async persist(messagePublicId, attachments, receivedAt = new Date()) {
    if (!attachments.length) return { records: [], cleanup: async () => {} };
    if (!/^MSG-[0-9a-f-]{36}$/i.test(messagePublicId)) throw new Error('Invalid message storage identifier.');

    const year = String(receivedAt.getUTCFullYear());
    const month = String(receivedAt.getUTCMonth() + 1).padStart(2, '0');
    const directory = resolve(this.root, year, month, messagePublicId);
    assertChildPath(this.root, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const records = [];
    try {
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const fileName = safeAttachmentName(attachment.filename, index);
        const diskName = `${String(index + 1).padStart(3, '0')}-${fileName}`;
        const filePath = resolve(directory, diskName);
        assertChildPath(this.root, filePath);
        await writeFile(filePath, attachment.content, { flag: 'wx', mode: 0o600 });
        records.push({
          fileName,
          contentType: String(attachment.contentType || 'application/octet-stream').slice(0, 255),
          sizeBytes: Number(attachment.size || attachment.content?.length || 0),
          storageKey: posix.join(year, month, messagePublicId, diskName),
        });
      }
    } catch (error) {
      try {
        await this.removeDirectory(directory);
      } catch (cleanupError) {
        await this.queueDirectories([directory]).catch((queueError) => {
          console.error('[smtp] attachment cleanup could not be queued', queueError);
        });
      }
      throw error;
    }

    return {
      records,
      cleanup: () => this.removeStorageKeys(records.map((record) => record.storageKey)),
    };
  }

  async removeDirectory(directory) {
    const target = resolve(directory);
    assertChildPath(this.root, target);
    await rm(target, { recursive: true, force: true, maxRetries: 2 });
  }

  async removeStorageKeys(storageKeys) {
    const directories = new Set();
    for (const value of storageKeys) {
      const key = String(value || '').replace(/\\/g, '/');
      const match = /^(\d{4})\/(\d{2})\/(MSG-[0-9a-f-]{36})\//i.exec(key);
      if (!match) continue;
      const directory = resolve(this.root, match[1], match[2], match[3]);
      assertChildPath(this.root, directory);
      directories.add(directory);
    }
    const directoryList = [...directories];
    const results = await Promise.allSettled(directoryList.map((directory) => this.removeDirectory(directory)));
    const failed = directoryList.filter((_directory, index) => results[index].status === 'rejected');
    if (failed.length) {
      await this.queueDirectories(failed).catch((error) => {
        console.error('[smtp] attachment cleanup could not be queued', error);
      });
    }
    return failed.length;
  }

  async queueDirectories(directories) {
    if (!directories.length) return;
    const relativeDirectories = [...new Set(directories.map((directory) => {
      const target = resolve(directory);
      assertChildPath(this.root, target);
      const key = relative(this.root, target).replace(/\\/g, '/');
      if (!/^\d{4}\/\d{2}\/MSG-[0-9a-f-]{36}$/i.test(key)) {
        throw new Error('Unsafe attachment cleanup queue path.');
      }
      return key;
    }))];
    const id = randomUUID();
    const temporary = resolve(this.cleanupQueue, `.${id}.tmp`);
    const destination = resolve(this.cleanupQueue, `${Date.now()}-${id}.json`);
    assertChildPath(this.root, temporary);
    assertChildPath(this.root, destination);
    await writeFile(temporary, JSON.stringify({ directories: relativeDirectories }), {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  async retryPendingCleanup(limit = 100) {
    const entries = (await readdir(this.cleanupQueue))
      .filter((name) => /^[0-9]+-[0-9a-f-]{36}\.json$/i.test(name))
      .sort()
      .slice(0, limit);
    let completed = 0;
    let pending = 0;
    for (const entry of entries) {
      const manifest = resolve(this.cleanupQueue, entry);
      assertChildPath(this.root, manifest);
      try {
        const payload = JSON.parse(await readFile(manifest, 'utf8'));
        if (!Array.isArray(payload.directories) || !payload.directories.length) {
          throw new Error('Invalid attachment cleanup manifest.');
        }
        const directories = payload.directories.map((key) => {
          if (!/^\d{4}\/\d{2}\/MSG-[0-9a-f-]{36}$/i.test(String(key))) {
            throw new Error('Invalid attachment cleanup directory.');
          }
          const directory = resolve(this.root, ...String(key).split('/'));
          assertChildPath(this.root, directory);
          return directory;
        });
        const results = await Promise.allSettled(directories.map((directory) => this.removeDirectory(directory)));
        if (results.some((result) => result.status === 'rejected')) {
          pending += 1;
          continue;
        }
        await unlink(manifest);
        completed += 1;
      } catch (error) {
        pending += 1;
        console.error('[mail-cleanup] invalid or failed cleanup manifest', {
          file: entry,
          message: error?.message || String(error),
        });
      }
    }
    return { completed, pending };
  }
}
