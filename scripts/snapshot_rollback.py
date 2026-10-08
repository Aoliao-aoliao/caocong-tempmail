"""Local-only snapshot with scrubbed Env. Never print resolved configuration."""
import json
import re
import subprocess
import sys

SAFE_IMAGE_KEYS = {'PATH', 'NODE_ENV', 'NODE_VERSION', 'YARN_VERSION'}


def read_json(args):
    return json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)


def snapshot(container, tag, compose_args):
    live = read_json(['docker', 'inspect', container])[0]
    env = dict(item.split('=', 1) for item in live['Config']['Env'])
    config = read_json(['docker', 'compose', *compose_args, 'config', '--format', 'json'])
    desired = config['services']['nodemail'].get('environment', {})
    # Every runtime override must be supplied again on rollback. Reject unknown
    # injected settings instead of silently clearing them and breaking recovery.
    for key, value in env.items():
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            raise ValueError('Invalid environment key')
        if key not in SAFE_IMAGE_KEYS and value != str(desired.get(key, '')):
            raise ValueError('Rollback configuration does not reproduce runtime environment')
    changes = []
    for key in env:
        value = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' if key == 'PATH' else 'production' if key == 'NODE_ENV' else ''
        changes.extend(['--change', f'ENV {key}={value}'])
    subprocess.run(['docker', 'commit', '--pause=true', *changes, container, tag], check=True, capture_output=True, text=True)
    saved = read_json(['docker', 'image', 'inspect', tag])[0]
    # Older daemons may also expose ContainerConfig; never silently accept a
    # secret left in that legacy metadata even if Config itself was scrubbed.
    for section in ('Config', 'ContainerConfig'):
        saved_env = dict(item.split('=', 1) for item in (saved.get(section) or {}).get('Env', []))
        if any(value for key, value in saved_env.items() if key not in {'PATH', 'NODE_ENV'}):
            raise ValueError('Snapshot environment verification failed')


def main():
    tag, project = sys.argv[1:]
    if not re.fullmatch(r'nodemail:rollback-[0-9a-f]{40}-[0-9]+-[0-9]+', tag):
        raise ValueError('Invalid snapshot tag')
    root = '/opt/nodemail'
    live = read_json(['docker', 'inspect', 'nodemail'])[0]
    files = live['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    base = root + '/docker-compose.yml'
    if files[0] != base or len(files) > 2 or (len(files) == 2 and not re.fullmatch(re.escape(root) + r'/\.deploy/(?:active\.yml|previous\.yml|transaction\.[A-Za-z0-9]+/(?:candidate|rollback)\.yml)', files[1])):
        raise ValueError('Invalid rollback Compose files')
    args = ['--project-directory', root, '--env-file', root + '/.env', '-p', project]
    for file in files:
        args.extend(['-f', file])
    snapshot('nodemail', tag, args)
    print('Rollback snapshot environment scrubbed and verified; Compose supplies runtime settings')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Rollback snapshot failed; live container not replaced; no configuration printed', file=sys.stderr)
        sys.exit(1)
