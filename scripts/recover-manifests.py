#!/usr/bin/env python3
"""
Onyx Base — orphaned-manifest recovery probe.

The 07:14 sync exported an account manifest with 0 records (the dev-server
hot-reload had emptied the in-memory store) and DELETED the previous manifest
(which held 1101 records). Telegram messages are immutable — any manifest
message whose delete failed survives as an orphan.

This script scans a message-id range by forwarding each message within the
SAME chat (forwardMessage returns the document's file_id), immediately
deleting the forward (so the chat is not polluted), then downloading any
CLOUDKV_ACCOUNT_MANIFEST_V4 document and counting its records.

Usage: python3 scripts/recover-manifests.py <start_id> <end_id>
"""
import json
import sys
import time
import urllib.request
import urllib.parse

# Read secrets from the local .env — NEVER hardcode them here.
import re as _re
_env = open("/home/z/my-project/.env").read()
TOKEN = _re.search(r'TELEGRAM_BOT_TOKEN=(\S+)', _env).group(1)
CHAT = _re.search(r'TELEGRAM_CHAT_ID=(\S+)', _env).group(1)
API = f"https://api.telegram.org/bot{TOKEN}"

INDEX_MARKER = "CLOUDKV_ACCOUNT_INDEX_V4"
MANIFEST_MARKER = "CLOUDKV_ACCOUNT_MANIFEST_V4"


def call(method, **params):
    url = f"{API}/{method}?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)


def post(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"{API}/{method}", data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def download(file_id):
    f = call("getFile", file_id=file_id)["result"]
    with urllib.request.urlopen(f"https://api.telegram.org/file/bot{TOKEN}/{f['file_path']}", timeout=30) as r:
        return r.read()


def probe(mid):
    """Forward msg mid in-chat, classify it, delete the forward. Returns a dict."""
    try:
        res = post(
            "forwardMessage", chat_id=CHAT, from_chat_id=CHAT, message_id=mid,
            disable_notification=True,
        )
    except Exception as e:
        return {"id": mid, "type": "error", "err": str(e)[:60]}
    if not res.get("ok"):
        return {"id": mid, "type": "missing"}
    msg = res["result"]
    new_id = msg["message_id"]
    kind, info = "other", None
    caption = msg.get("caption") or ""
    text = msg.get("text") or ""

    if caption.startswith(MANIFEST_MARKER) and msg.get("document"):
        info = {"file_id": msg["document"]["file_id"], "size": msg["document"].get("file_size")}
        kind = "manifest"
    elif text.startswith(INDEX_MARKER):
        kind = "index"
        try:
            idx = json.loads(text[len(INDEX_MARKER):].strip())
            info = {a: {"fileId": e.get("fileId"), "recordCount": e.get("recordCount"),
                        "updatedAt": e.get("updatedAt")}
                    for a, e in idx.get("accounts", {}).items()}
        except Exception:
            info = {"parse_error": True}
    elif msg.get("document"):
        kind = "document-other"
        info = {"file_id": msg["document"]["file_id"]}
    else:
        kind = "text-other"

    # Remove the forward immediately — keep the chat clean.
    try:
        post("deleteMessage", chat_id=CHAT, message_id=new_id)
    except Exception:
        pass
    return {"id": mid, "type": kind, "info": info}


def main():
    start, end = int(sys.argv[1]), int(sys.argv[2])
    found = []
    for mid in range(start, end + 1):
        r = probe(mid)
        if r["type"] in ("manifest", "index"):
            print(json.dumps(r))
            found.append(r)
        elif r["type"] not in ("missing", "other", "error"):
            print(json.dumps(r))
        time.sleep(0.05)

    # Download + inspect every manifest we found.
    print(f"\n=== {len(found)} interesting messages; downloading manifests ===", flush=True)
    best = None
    for f in found:
        if f["type"] != "manifest":
            continue
        try:
            data = download(f["info"]["file_id"])
            m = json.loads(data)
            n = len(m.get("records", []))
            print(f"msg {f['id']}: {n} records, {len(m.get('logs', []))} logs, exported {m.get('exportedAt')}")
            if best is None or n > best[0]:
                best = (n, f, m)
        except Exception as e:
            print(f"msg {f['id']}: download failed: {str(e)[:60]}")
    if best and best[0] > 0:
        n, f, m = best
        out = "/home/z/my-project/db/recovered-manifest.json"
        with open(out, "w") as fh:
            json.dump(m, fh)
        print(f"\nBEST: msg {f['id']} with {n} records → saved to {out}")


if __name__ == "__main__":
    main()
