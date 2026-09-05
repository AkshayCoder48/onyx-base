#!/usr/bin/env python3
"""Task 10: update README.md and /llms.txt for the Email Automation API.
Marker-anchored replacements. Idempotent."""

from pathlib import Path

README = Path('/home/z/my-project/README.md')
LLMS = Path('/home/z/my-project/src/app/llms.txt/route.ts')

README_EMAIL_SECTION = '''<!-- ───────────────────────── EMAIL AUTOMATION ───────────────────────── -->
## Email Automation API — privacy-first (MCPEmail + Telegram bridge)

A generic email automation engine (OTP codes, welcome mails, notifications,
reports — anything), built around **credential ownership**:

> **Privacy disclaimer.** For private or sensitive email automation, use your
> own Telegram credentials and your own MCPEmail API key — never credentials
> belonging to another person. Your `mcpe_*` key is a user-owned credential
> used only to execute requests on your behalf; it is never exposed, logged,
> or reused for other users.

Two completely different credentials, never confused:

- **Platform API key** (`kv_live_*`) — authenticates *you → this API*. Never forwarded upstream.
- **MCPEmail key** (`mcpe_*`) — resolved *by name* from your private store and used only for the *API → MCPEmail* hop.

```bash
# 1. Connect YOUR MCPEmail key under a name (live handshake on save;
#    mirrored to YOUR private pinned Telegram manifest):
curl -X POST /api/credentials/connect \\
  -H "Authorization: Bearer kv_live_…" \\
  -d '{"name":"personal_email","apiKey":"mcpe_…","rateLimitPerMin":30}'

# 2. Automate — reference the credential BY NAME; $VAR_NAME$ substitution:
curl -X POST /api/email/send \\
  -H "Authorization: Bearer kv_live_…" \\
  -d '{"credential":"personal_email","to":"user@example.com",
       "subject":"Welcome $NAME$","body":"Hello $NAME$, code: $OTP$.",
       "variables":{"NAME":"Akshay","OTP":"483921"}}'
```

Key rules: unknown `$VARIABLE$` → `400 missing_variable` (send aborted, never
half-rendered) · unknown credential name → `404 credential_not_found` (**fail
closed** — no project-wide fallback key exists anywhere) · every send returns
a `request_id` traceable via `GET /api/email/status/:requestId` (metadata
only) · secrets are redacted from every log line · cross-user credential
access is blocked (tenant-scoped). Old `/api/email-otp/*` endpoints return
`410` with a migration guide. Full docs: **`/docs#email`** (anonymous).

<br/>

'''

README_TABLE_ROWS = '''| `POST` | `/api/email/send` | Send an automated email via a NAMED MCPEmail credential (`$VAR_NAME$` variables, `request_id` in every response) |
| `POST` | `/api/email/template/send` | Send using a stored (or inline) template — one structure, many variables |
| `GET` | `/api/email/status/:requestId` | Email request status by ID (metadata only, tenant-scoped, 7-day retention) |
| `GET` | `/api/email/requests` | Recent email automation requests (metadata only) |
| `GET` · `POST` | `/api/email/templates` | List / save named email templates (variables auto-detected) |
| `GET` · `DELETE` | `/api/email/templates/:name` | Fetch / delete one template |
| `POST` | `/api/credentials/connect` | Connect (or update) a NAMED MCPEmail credential — YOUR `mcpe_*` key, live handshake, masked response |
| `GET` | `/api/credentials` | List credentials (masked views only — raw keys never returned) |
| `GET` · `DELETE` | `/api/credentials/:name` | View (masked) / disconnect a credential (sends then fail closed) |
| `POST` | `/api/telegram/connect` | Connect your private Telegram configuration channel (validated live) |
| `GET` · `PUT` · `DELETE` | `/api/telegram/config` | Telegram bridge status (masked) / update / reset |
| `POST` | `/api/email-otp/send` · `/api/email-otp/verify` | **DEPRECATED (410)** — retired OTP system; returns a machine-readable migration guide |
'''

LLMS_FEATURE_ROWS = '''| **Email Automation** | Privacy-first email automation API. Connect YOUR MCPEmail key as a NAMED credential (\\`personal_email\\`, \\`work_email\\`… — live handshake on save, mirrored to your private pinned Telegram manifest), then send via \\`/api/email/send\\` referencing the name. \\`$VAR_NAME$\\` variable engine (missing variables abort the send), stored templates, per-credential custom rate limits, request-ID status tracking, and a strict two-credential boundary: the platform \\`kv_live_*\\` key authenticates you to this API; your \\`mcpe_*\\` key authenticates the MCPEmail hop. No project-wide fallback — fail closed. |
'''

LLMS_DIAGNOSTICS_ROW = '''| **Diagnostics** | System health, storage queue depth, and error triage — liveness of the Telegram durable layer at a glance. |
'''

LLMS_EMAIL_SECTION = '''### 4.10 · Email Automation API (privacy-first)

Every call carries the **platform** key. The **MCPEmail** hop is authenticated
with YOUR own named credential — resolved from your account, never echoed,
never a project-wide key.

| Method | Path | Purpose |
|:---|:---|:---|
| \\`POST\\` | \\`/api/credentials/connect\\` | Connect YOUR \\`mcpe_*\\` key under a name (live handshake, masked response, optional per-credential \\`rateLimitPerMin\\`). Mirrored to your private Telegram manifest. |
| \\`GET\\` | \\`/api/credentials\\` | List credentials (masked views only). \\`DELETE /api/credentials/:name\\` disconnects. |
| \\`POST\\` | \\`/api/email/send\\` | Send an email: \\`{ credential, to, subject, body?, htmlBody?, variables?, fromName? }\\`. \\`$VAR_NAME$\\` substitution — a missing variable aborts the send (\\`missing_variable\\`). Unknown credential → \\`404 credential_not_found\\` (fail closed). Returns \\`request_id\\`. |
| \\`POST\\` | \\`/api/email/template/send\\` | Send via a stored template name or inline \\`{ subject, body, htmlBody? }\\`. Template never rebuilt. |
| \\`GET\\` | \\`/api/email/status/:requestId\\` | Request status (ts, credential name, sent/failed, latency, upstream status) — metadata only. \\`GET /api/email/requests\\` lists recent. |
| \\`GET\\` · \\`POST\\` | \\`/api/email/templates\\` | List / save named templates; \\`GET\\`·\\`DELETE /api/email/templates/:name\\` for one. |
| \\`POST\\` | \\`/api/telegram/connect\\` | Connect your private Telegram config channel (\\`{ chatId, label?, botToken? }\\`, validated live). \\`GET\\`·\\`PUT\\`·\\`DELETE /api/telegram/config\\` for status/update/reset. |
| \\`POST\\` | \\`/api/email-otp/send\\` · \\`verify\\` | **DEPRECATED (410)** — returns a machine-readable migration guide; nothing is processed. |

Rate limits: per platform key · per IP (30/min) · per-credential custom cap
(≤120/min hard ceiling). Secrets (\\`mcpe_*\\`, \\`kv_live_*\\`, bot tokens,
Bearer headers) are redacted from all logs. \\`/docs#email\\` renders the full
guide anonymously.

'''

def insert_before(src: str, marker: str, insertion: str) -> str:
    lines = src.split('\n')
    for i, line in enumerate(lines):
        if marker in line:
            return '\n'.join(lines[:i]) + '\n' + insertion + '\n'.join(lines[i:])
    raise SystemExit(f'marker not found: {marker[:50]!r}')

def main() -> None:
    # ── README ──
    r = README.read_text(encoding='utf-8')
    if '## Email Automation API' not in r:
        r = insert_before(
            r,
            '## Authentication & recovery',
            README_EMAIL_SECTION.rstrip('\n') + '\n',
        )
    api_surface = r.split('## API surface')
    if len(api_surface) > 1 and '/api/email/send' not in api_surface[1]:
        r = insert_before(
            r,
            '| `GET` | `/llms.txt` |',
            README_TABLE_ROWS,
        )
    README.write_text(r, encoding='utf-8')
    print('README updated')

    # ── llms.txt ──
    t = LLMS.read_text(encoding='utf-8')
    if 'Email Automation API' not in t:
        # 1. Feature-table rows.
        t = insert_before(t, '| **Public Share** |', LLMS_FEATURE_ROWS.rstrip('\n') + '\n')
        t = insert_before(t, '| **Settings** |', LLMS_DIAGNOSTICS_ROW.rstrip('\n') + '\n')
        t = t.replace('## 3 · Features (thirteen dashboard tabs)', '## 3 · Features (fifteen dashboard tabs)')
        # 2. REST section 4.10 before the "---" + section 5.
        t = insert_before(t, '## 5 · Quick start in any language', LLMS_EMAIL_SECTION.rstrip('\n') + '\n---\n\n')
    LLMS.write_text(t, encoding='utf-8')
    print('llms.txt updated')

if __name__ == '__main__':
    main()
