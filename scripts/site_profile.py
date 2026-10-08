"""Apply server-local public settings; never export server configuration to GitHub."""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

KEYS = {'NODEMAIL_SITE_ORIGIN', 'NODEMAIL_PUBLIC_ORIGIN', 'NODEMAIL_CONTACT_EMAIL', 'NODEMAIL_EMAIL_DOMAIN', 'NODEMAIL_GMPAY_ORIGIN'}

def render(profile, previous):
    if set(profile) != KEYS or any(not isinstance(v, str) or not v or any(ord(c)<32 for c in v) for v in profile.values()):
        raise ValueError('Invalid site profile')
    for key in ['NODEMAIL_SITE_ORIGIN','NODEMAIL_PUBLIC_ORIGIN','NODEMAIL_GMPAY_ORIGIN']:
        u=urlsplit(profile[key])
        if u.scheme!='https' or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment:
            raise ValueError('Invalid site origin')
    if not re.fullmatch(r'[A-Za-z0-9.-]+',profile['NODEMAIL_EMAIL_DOMAIN']):raise ValueError('Invalid mail domain')
    lines=['    environment:']
    # Retain the existing operator-generated gateway settings, including .env substitutions.
    for line in previous.splitlines():
        if re.match(r'^      GMPAY_[A-Z_]+:',line):lines.append(line)
    for key in sorted(KEYS):
        lines.append('      '+key+': '+json.dumps(profile[key].replace('$','$$')))
    return '\n'.join(lines)+'\n'

if __name__=='__main__':
    target, profile, active=map(Path,sys.argv[1:])
    if profile.is_symlink() or (active.exists() and active.is_symlink()):raise ValueError('Symlink profile refused')
    previous=active.read_text() if active.exists() else ''
    with target.open('a') as stream:stream.write(render(json.loads(profile.read_text()),previous))
