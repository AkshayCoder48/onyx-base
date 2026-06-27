#!/usr/bin/env python3
"""Push env vars to GitHub as encrypted repository secrets.

GitHub repository secrets are stored encrypted-at-rest and are NEVER part of
the cloned git repo (they are only injected into GitHub Actions workflows).
This satisfies "push the env to GitHub such that it won't be cloned when cloning."

Usage:
    python3 scripts/push-gh-secrets.py

Reads secret VALUES from the local gitignored `.env` file (so this script
itself contains NO secrets and is safe to commit). Public-facing vars that
are not in `.env` fall back to the defaults below.

Requires: pynacl  (pip install pynacl)
Requires: the git remote `origin` to embed a GH token:
    https://<user>:<ghp_token>@github.com/<owner>/<repo>.git
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

from nacl import public, encoding

OWNER = "AkshayCoder48"
REPO = "onyx-base"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# Keys to push. Values come from .env when present; otherwise the default
# shown here is used. Defaults are for non-secret public vars only.
DEFAULTS = {
    "NEXT_PUBLIC_APP_URL": "https://onyxbase.vercel.app",
    "NEXT_PUBLIC_APP_NAME": "Onyx Base",
    "DATABASE_URL": "file:/tmp/cloudkv.json",
}
# Secrets that MUST exist in .env (no safe default).
REQUIRED_FROM_ENV = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "BOOTSTRAP_ADMIN_KEY",
    "CLOUDKV_SECRET",
    "RESET_PASSWORD_SECRET",
]


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def gh_token() -> str:
    url = subprocess.check_output(
        ["git", "remote", "get-url", "origin"], text=True
    ).strip()
    if "https://" not in url or "@" not in url:
        sys.exit("[FAIL] origin remote must embed a token: https://<user>:<token>@github.com/...")
    return url.split("https://")[1].split("@")[0].split(":", 1)[1]


def api(method, path, token, body=None):
    url = f"https://api.github.com/repos/{OWNER}/{REPO}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read()
            return r.status, json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    env = load_env(ENV_FILE)
    print(f"[env] loaded {len(env)} keys from {ENV_FILE.name}")

    secrets: dict[str, str] = {}
    for k in REQUIRED_FROM_ENV:
        if k not in env:
            sys.exit(f"[FAIL] {k} missing from {ENV_FILE}")
        secrets[k] = env[k]
    for k, default in DEFAULTS.items():
        secrets[k] = env.get(k, default)

    token = gh_token()
    print(f"[token] len={len(token)} prefix={token[:4]}...")

    status, pk = api("GET", "actions/secrets/public-key", token)
    if status != 200:
        sys.exit(f"[FAIL] public-key {status}: {pk}")
    print(f"[pubkey] key_id={pk['key_id']}")

    pk_obj = public.PublicKey(pk["key"].encode(), encoder=encoding.Base64Encoder())
    sealed = public.SealedBox(pk_obj)

    ok = 0
    for key, value in secrets.items():
        enc = sealed.encrypt(value.encode())
        body = {
            "encrypted_value": base64.b64encode(enc).decode(),
            "key_id": pk["key_id"],
        }
        status, resp = api("PUT", f"actions/secrets/{key}", token, body)
        if status in (201, 204):
            print(f"  [OK]   {key}  -> pushed (HTTP {status})")
            ok += 1
        else:
            print(f"  [FAIL] {key}  -> HTTP {status}: {resp}", file=sys.stderr)

    status, listing = api("GET", "actions/secrets", token)
    if status == 200:
        names = sorted(s["name"] for s in listing.get("secrets", []))
        print(f"\n[list] {len(names)} secrets now in repo:")
        for n in names:
            print(f"    - {n}")
    print(f"\n[DONE] pushed {ok}/{len(secrets)} secrets")


if __name__ == "__main__":
    main()
