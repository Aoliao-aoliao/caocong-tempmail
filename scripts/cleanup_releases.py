"""Best-effort cleanup of NodeMail release objects only, after successful health."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

SHA = re.compile(r'[0-9a-f]{40}')
TAG = re.compile(r'nodemail:(?:[0-9a-f]{40}|rollback-[0-9a-f]{40}-[0-9]+-[0-9]+)')


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout


def cleanup(root, current_sha, rollback_tag, keep=3):
    root = Path(root)
    if not SHA.fullmatch(current_sha) or not TAG.fullmatch(rollback_tag) or keep < 3:
        raise ValueError('Invalid cleanup parameters')
    incoming = root / '.deploy' / 'incoming'
    if (root / '.deploy').is_symlink() or incoming.is_symlink() or root.is_symlink():
        raise ValueError('Unsafe cleanup path')
    # Protect images of ALL containers (including stopped/other-project users),
    # not just the expected live service. Never use force removal.
    ids = docker('ps', '-aq').split()
    protected = {x['Image'] for x in json.loads(docker('inspect', *ids))} if ids else set()
    refs = docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', 'nodemail').splitlines()
    refs = sorted({x for x in refs if TAG.fullmatch(x)})
    images = json.loads(docker('image', 'inspect', *refs)) if refs else []
    objects = sorted(zip(refs, images), key=lambda x: (x[1]['Created'], x[0]), reverse=True)
    retained = {f'nodemail:{current_sha}', rollback_tag}
    # Keep at least three distinct image identities, even if multiple tags point
    # to the same snapshot/base. Pinned and in-use images may retain extra tags.
    retained_ids = {image['Id'] for ref, image in objects if ref in retained}
    for ref, image in objects:
        if len(retained_ids) >= keep:
            break
        retained.add(ref)
        retained_ids.add(image['Id'])
    for ref, image in objects:
        if ref in retained or image['Id'] in retained_ids or image['Id'] in protected:
            continue
        try:
            # Recheck all users immediately before each removal.
            users = docker('ps', '-aq', '--filter', 'ancestor=' + image['Id']).split()
            if users:
                continue
            docker('image', 'rm', ref)
            print('Cleaned NodeMail image tag ' + ref)
        except Exception:
            print('WARNING: could not clean NodeMail image tag ' + ref)
    if not incoming.exists():
        return
    dirs = sorted((p for p in incoming.iterdir() if SHA.fullmatch(p.name) and p.is_dir() and not p.is_symlink() and (p / 'nodemail-image.tar.gz.sha256').is_file()), key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    retained_dirs = {current_sha}
    for path in dirs:
        if len(retained_dirs) >= keep:
            break
        retained_dirs.add(path.name)
    for path in dirs:
        if path.name in retained_dirs:
            continue
        # Require the release archive manifest produced by our transfer helper.
        # Unknown directories or operator recovery material are left alone.
        if not (path / 'nodemail-image.tar.gz.sha256').is_file():
            continue
        try:
            shutil.rmtree(path)
            print('Cleaned NodeMail incoming/' + path.name)
        except Exception:
            print('WARNING: could not clean NodeMail incoming/' + path.name)


if __name__ == '__main__':
    try:
        cleanup('/opt/nodemail', *sys.argv[1:])
    except Exception:
        print('WARNING: NodeMail release cleanup stopped; deployment remains successful')
