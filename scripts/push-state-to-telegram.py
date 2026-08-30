#!/usr/bin/env python3
"""
Push the dev server's full local state to Telegram as the pinned manifest.

The Vercel cold-boot `seedExternalAdminKeys` sync clobbered the pinned
manifest with an admin-only snapshot, leaving Akshay's regular user/apiKey
out of the durable backend. This script reads the dev server's
db/cloudkv.json (which has the full state: Akshay's user + apiKey + the
admin keys) and uploads it as a new pinned manifest, overwriting the
admin-only one.
"""
import json, time, urllib.request, urllib.parse, mimetypes, os, sys

BOT = "0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
CHAT = "-1001234567890"
LOCAL_STATE = "/home/z/my-project/db/cloudkv.json"

def tg(method, **params):
    url = f"https://api.telegram.org/bot{BOT}/{method}"
    if params.get("file"):
        # multipart upload
        boundary = "----onyxbase-boundary-" + str(int(time.time()))
        path = params.pop("file")
        with open(path, "rb") as f:
            file_data = f.read()
        body_parts = []
        for k, v in params.items():
            if v is None: continue
            body_parts.append(f"--{boundary}\r\n".encode())
            body_parts.append(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
            body_parts.append(str(v).encode() + b"\r\n")
        # document part
        body_parts.append(f"--{boundary}\r\n".encode())
        body_parts.append(
            f'Content-Disposition: form-data; name="document"; filename="onyxbase-state.json"\r\n'.encode()
        )
        body_parts.append(b"Content-Type: application/json\r\n\r\n")
        body_parts.append(file_data)
        body_parts.append(b"\r\n")
        body_parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(body_parts)
        req = urllib.request.Request(url, data=body, method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        data = json.dumps(params).encode()
        req = urllib.request.Request(url, data=data, method="POST",
            headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

# 1. Read local state
with open(LOCAL_STATE) as f:
    state = json.load(f)
print(f"Local store: {len(state.get('users',[]))} users, {len(state.get('apiKeys',[]))} apiKeys, {len(state.get('adminKeys',[]))} adminKeys, {len(state.get('records',[]))} records")

# 2. Build the full-state manifest
manifest = {
    "cloudkv": True,
    "version": "v3-full-state",
    "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "users": state.get("users", []),
    "apiKeys": state.get("apiKeys", []),
    "records": state.get("records", []),
    "logs": state.get("logs", []),
    "files": state.get("files", []),
    "shareTokens": state.get("shareTokens", []),
    "collectionNames": state.get("collectionNames", []),
    "telegramConfigs": state.get("telegramConfigs", []),
    "adminKeys": state.get("adminKeys", []),
}
manifest_json = json.dumps(manifest, indent=2).encode()
print(f"Manifest size: {len(manifest_json)} bytes")

# 3. Save to a temp file
tmp = "/tmp/onyxbase-state.json"
with open(tmp, "wb") as f:
    f.write(manifest_json)

# 4. Get the old pinned message id (to unpin later)
chat_resp = tg("getChat", chat_id=CHAT)
old_pinned = chat_resp["result"].get("pinned_message", {})
old_pinned_id = old_pinned.get("message_id")
print(f"Old pinned message id: {old_pinned_id}")

# 5. Upload the new manifest as a document with the manifest marker caption
caption = "CLOUDKV_IDENTITY_MANIFEST_V1\nfull-state"
send_resp = tg("sendDocument", chat_id=CHAT, caption=caption, file=tmp)
if not send_resp.get("ok"):
    print("sendDocument failed:", send_resp)
    sys.exit(1)
new_msg_id = send_resp["result"]["message_id"]
print(f"New manifest uploaded: message_id={new_msg_id}")

# 6. Pin the new message (and disable notifications)
pin_resp = tg("pinChatMessage", chat_id=CHAT, message_id=new_msg_id, disable_notification=True)
print(f"pinChatMessage: ok={pin_resp.get('ok')} {pin_resp.get('description','')}")

# 7. Unpin the old pinned message (so only the new one is pinned)
if old_pinned_id and old_pinned_id != new_msg_id:
    unpin_resp = tg("unpinChatMessage", chat_id=CHAT, message_id=old_pinned_id)
    print(f"unpinChatMessage (old): ok={unpin_resp.get('ok')} {unpin_resp.get('description','')}")

# 8. Verify
verify_resp = tg("getChat", chat_id=CHAT)
new_pinned = verify_resp["result"].get("pinned_message", {})
print(f"\nVerified pinned message: id={new_pinned.get('message_id')}")
print(f"  file: {new_pinned.get('document',{}).get('file_name')} ({new_pinned.get('document',{}).get('file_size')} bytes)")
print(f"  caption: {new_pinned.get('caption','')[:80]}")
