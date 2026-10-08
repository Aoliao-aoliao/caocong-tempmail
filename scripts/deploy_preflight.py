"""Layout checks plus narrowly approved additive 013/014 preparation. Never print secrets."""
import json
import re
import subprocess
import sys


def validate_layout(live, config, root):
    labels = live['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project.working_dir') != root:
        raise ValueError('Existing container is not managed from /opt/nodemail')
    config_files = labels.get('com.docker.compose.project.config_files', '')
    base = root + '/docker-compose.yml'
    allowed_override = re.fullmatch(re.escape(base) + ',' + re.escape(root)
                                   + r'/\.deploy/(?:active\.yml|previous\.yml|transaction\.[A-Za-z0-9]+/(?:candidate|rollback)\.yml)', config_files)
    if config_files != base and not allowed_override:
        raise ValueError('Existing Compose has overrides; reconcile them before enabling deployment')
    service = config['services']['nodemail']
    if service.get('container_name') != 'nodemail':
        raise ValueError('Unexpected service/container identity')
    desired = {}
    for mount in service.get('volumes', []):
        kind = mount['type']
        source = mount.get('source', '')
        if kind == 'volume':
            source = config['volumes'][source]['name']
        elif kind != 'bind':
            raise ValueError('Unsupported storage mount')
        desired[mount['target']] = (kind, source, not mount.get('read_only', False))
    actual = {m['Destination']: (m['Type'], m.get('Name') if m['Type'] == 'volume' else m['Source'], m['RW'])
              for m in live.get('Mounts', [])}
    if desired != actual or '/app/data/mail-attachments' not in actual:
        raise ValueError('Compose storage differs from live container; refusing to change data mounts')
    environment = dict(item.split('=', 1) for item in live['Config']['Env'])
    proposed = service.get('environment', {})
    keys = {k for k in environment.keys() | proposed.keys()
            if k.startswith('MYSQL_') or k in ('GUEST_SESSION_SECRET', 'MAIL_ATTACHMENT_DIR')}
    if any(str(environment.get(k, '')) != str(proposed.get(k, '')) for k in keys):
        raise ValueError('Database/session/storage configuration differs from live container')
    health = service.get('healthcheck', {})
    test = str(health.get('test', ''))
    if health.get('disable') or '/api/health' not in test or '2525' not in test:
        raise ValueError('Compose needs the HTTP/database and SMTP healthcheck')
    state = live.get('State', {})
    if state.get('Running') is not True or state.get('Restarting') is True:
        raise ValueError('Existing container must be running and stable before deployment')
    if state.get('Health', {}).get('Status') != 'healthy':
        raise ValueError('Existing container must be healthy before deployment')


# Executed in both old and new containers; SQL contents never leave the container.
MIGRATION_HASHES = """
const fs=require('node:fs'),crypto=require('node:crypto');
const dir='/app/server/db/migrations';
const files=fs.readdirSync(dir).filter(n=>n.endsWith('.sql')).sort();
console.log(JSON.stringify(Object.fromEntries(files.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(dir+'/'+n)).digest('hex')]))));
"""


def read_json(args):
    result = subprocess.run(args, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def main():
    image, project = sys.argv[1:]
    root = '/opt/nodemail'
    live = read_json(['docker', 'inspect', 'nodemail'])[0]
    config = read_json(['docker', 'compose', '--project-directory', root, '--env-file', root + '/.env',
                        '-p', project, '-f', root + '/docker-compose.yml', 'config', '--format', 'json'])
    validate_layout(live, config, root)
    arch = subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Architecture}}'], text=True).strip()
    if arch != 'amd64':
        raise ValueError('This release workflow targets linux/amd64 only')
    old = read_json(['docker', 'exec', 'nodemail', 'node', '-e', MIGRATION_HASHES])
    new = read_json(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', MIGRATION_HASHES])
    if not old or old != new:
        raise ValueError('Migration files changed; an explicitly reviewed migration is required')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError):
        # Docker errors or resolved config can contain credentials. Do not echo their output.
        print('Deployment preflight failed: check container health, Compose layout, data bindings and migration compatibility', file=sys.stderr)
        sys.exit(1)
