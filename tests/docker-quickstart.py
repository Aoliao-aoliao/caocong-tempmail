"""Run the documented pure-Docker deployment exactly as written in docs-site/content/docker.md.

Each ```bash block preceded by `<!-- docker-ci:NAME -->` is executed verbatim in a copy of
installer/, against a disposable Compose project that is always removed afterwards. Only the
documented image tags are substituted with unique tags of the CI image under test.
"""
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs-site" / "content" / "docker.md"
CURRENT, NEXT = "nodemail-local:0.0.2", "nodemail-local:0.0.3"
STEPS = ["configure", "init", "admin", "start", "backup", "upgrade"]


def documented_blocks():
    text = DOC.read_text(encoding="utf-8")
    blocks = dict(re.findall(r"<!-- docker-ci:([a-z]+) -->\s*```bash\n(.*?)```", text, re.S))
    missing = [step for step in STEPS if step not in blocks]
    if missing:
        raise RuntimeError("docker.md lost tested command blocks: %s" % ", ".join(missing))
    return blocks


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"nodemail-distribution-ci:[A-Za-z0-9_.-]{1,128}", sys.argv[1]):
        raise RuntimeError("Pass a dedicated nodemail-distribution-ci image tag.")
    if os.environ.get("NODEMAIL_ISOLATED_TESTS") != "1":
        raise RuntimeError("The Docker quickstart check only runs in isolated CI.")
    image, suffix = sys.argv[1], uuid.uuid4().hex[:12]
    current, upgraded = "nodemail-local:ci-%s-a" % suffix, "nodemail-local:ci-%s-b" % suffix
    blocks = {name: body.replace(NEXT, upgraded).replace(CURRENT, current) for name, body in documented_blocks().items()}
    password = secrets.token_urlsafe(24)
    work = Path(tempfile.mkdtemp(prefix="nodemail-docker-quickstart-"))
    installer = work / "installer"
    shutil.copytree(ROOT / "installer", installer)
    env = {key: value for key, value in os.environ.items() if not key.startswith(("MYSQL_", "NODEMAIL_", "GUEST_", "SMTP_", "COMPOSE_"))}

    def secrets_in_env_file():
        try:
            return [line.split("=", 1)[1] for line in (installer / ".env").read_text().splitlines() if "=" in line and line.split("=", 1)[1]]
        except FileNotFoundError:
            return []

    def run(args, stdin=None, check=True, timeout=600):
        result = subprocess.run(args, cwd=installer, env=env, input=stdin, text=True, capture_output=True, timeout=timeout)
        if check and result.returncode:
            diagnostic = (result.stdout[-2000:] + "\n" + result.stderr[-3000:])
            for value in secrets_in_env_file() + [password]:
                if len(value) >= 8:
                    diagnostic = diagnostic.replace(value, "<redacted>")
            raise RuntimeError("Documented step failed (exit %s): %s" % (result.returncode, diagnostic))
        return result

    def step(name, stdin=""):
        return run(["bash", "-euo", "pipefail", "-c", blocks[name]], stdin=stdin)

    def compose(*args, check=True):
        return run(["docker", "compose", *args], check=check)

    def users():
        query = "MYSQL_PWD=\"$MYSQL_PASSWORD\" mysql -unodemail -N -e 'SELECT COUNT(*) FROM users' nodemail"
        return compose("exec", "-T", "db", "sh", "-c", query).stdout.strip()

    def healthy():
        with urllib.request.urlopen("http://127.0.0.1:4321/api/health", timeout=5) as response:
            assert response.status == 200 and b'"ok":true' in response.read(), "Health endpoint must report ok."

    run(["docker", "tag", image, current])
    run(["docker", "tag", image, upgraded])
    try:
        step("configure")
        saved = (installer / ".env").read_text()
        assert "NODEMAIL_IMAGE=%s" % current in saved and "GUEST_SESSION_SECRET=" in saved, "configure must write the documented image and generated secrets."
        assert oct((installer / ".env").stat().st_mode & 0o777) == "0o600", ".env must stay private."
        rerun = run(["bash", "-euo", "pipefail", "-c", blocks["configure"]], check=False)
        assert rerun.returncode != 0 and (installer / ".env").read_text() == saved, "Re-running configure must never overwrite .env."

        step("init")
        step("admin", stdin=password + "\n")
        assert users() == "1", "Exactly one administrator must exist after bootstrap."
        step("start")
        healthy()

        step("backup")
        dump = (installer / "nodemail-db.sql").read_text(errors="replace")
        assert "CREATE TABLE `users`" in dump and "admin@example.com" in dump, "Database backup must contain the installation."
        listing = run(["tar", "tzf", "nodemail-attachments.tar.gz"]).stdout
        assert "mail-attachments/" in listing, "Attachment backup must contain the attachment directory."

        step("upgrade")
        assert "NODEMAIL_IMAGE=%s" % upgraded in (installer / ".env").read_text(), "Upgrade must record the new image in .env."
        container = compose("ps", "-q", "app").stdout.strip()
        assert run(["docker", "inspect", "--format", "{{.Config.Image}}", container]).stdout.strip() == upgraded, "app must run the upgraded image."
        assert users() == "1", "Upgrade must keep existing accounts."

        compose("restart", "app")
        deadline = time.monotonic() + 90
        while True:
            try:
                healthy()
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(2)
        print("PASS: documented pure-Docker install, admin, start, backup, upgrade and restart")
    except Exception:
        logs = compose("logs", "--tail", "80", check=False)
        text = logs.stdout[-4000:]
        for value in secrets_in_env_file() + [password]:
            if len(value) >= 8:
                text = text.replace(value, "<redacted>")
        print(text, file=sys.stderr)
        raise
    finally:
        if (installer / ".env").exists():
            compose("down", "-v", "--remove-orphans", check=False)
        run(["docker", "image", "rm", current, upgraded], check=False)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
