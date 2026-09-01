#!/usr/bin/env python3
"""
Onyx Base — restore the account state from the recovered orphaned manifest
(message 672, exported 2026-08-31T12:02:37Z, 1334 records — the latest
recoverable state before the destructive 07:14 sync).

Steps:
  1. Download the orphan manifest from Telegram by file_id.
  2. Stop trusting the current (emptied) db/cloudkv.json.
  3. Rebuild db/cloudkv.json = manifest account data + current adminKeys.
  4. (Restart + sync happen outside this script.)
"""
import json
import re as _re
import urllib.request

_env = open("/home/z/my-project/.env").read()
TOKEN = _re.search(r"TELEGRAM_BOT_TOKEN=(\S+)", _env).group(1)
# The orphaned account manifest (msg 672, exported 2026-08-31T12:02:37Z).
FILE_ID = "BQACAgUAAyEGAAMBC4-FtwACAqBqlW1mDlXsIvxHESEv46va7zEhhgAC2CQAAuqVsVQcuQEVXSNx0T0E"
STORE = "/home/z/my-project/db/cloudkv.json"

# 1. Download the orphan manifest (msg 672).
f = json.load(urllib.request.urlopen(f"https://api.telegram.org/bot{TOKEN}/getFile?file_id={FILE_ID}", timeout=25))
path = f["result"]["file_path"]
with urllib.request.urlopen(f"https://api.telegram.org/file/bot{TOKEN}/{path}", timeout=60) as r:
    data = r.read()
manifest = json.loads(data)
print(f"downloaded manifest: {len(data)} bytes, exported {manifest['exportedAt']}")
print(f"records={len(manifest.get('records', []))}, logs={len(manifest.get('logs', []))}, apiKeys={len(manifest.get('apiKeys', []))}")

# 2. Read the current store (keeps adminKeys, which are env-seeded anyway).
cur = json.load(open(STORE))
print(f"current store: records={len(cur.get('records', []))}, adminKeys={len(cur.get('adminKeys', []))}")

# 3. Rebuild the store from the manifest + current adminKeys.
merged = {
    "users": manifest.get("user") and [manifest["user"]] or [],
    "apiKeys": manifest.get("apiKeys", []),
    "records": manifest.get("records", []),
    "logs": manifest.get("logs", []),
    "telegramConfigs": manifest.get("telegramConfigs", []),
    "shareTokens": manifest.get("shareTokens", []),
    "files": manifest.get("files", []),
    "collectionNames": manifest.get("collectionNames", []),
    "adminKeys": cur.get("adminKeys", []),
}
with open(STORE, "w") as fh:
    json.dump(merged, fh)

print("store rebuilt:")
print(f"  users={len(merged['users'])}, apiKeys={len(merged['apiKeys'])}, records={len(merged['records'])},")
print(f"  logs={len(merged['logs'])}, files={len(merged['files'])}, adminKeys={len(merged['adminKeys'])}")
colls = {}
for r0 in merged["records"]:
    colls[r0.get("collection", "?")] = colls.get(r0.get("collection", "?"), 0) + 1
print(f"  collections={colls}")
