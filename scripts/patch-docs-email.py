#!/usr/bin/env python3
"""Task 10: rewrite the /docs page email sections (marker-anchored, robust
to invisible whitespace). Replaces:
  1. EMAIL_ENDPOINTS const array
  2. The Email OTP <Section> render block
  3. The limits-table email row
Idempotent — skips already-applied parts."""

from pathlib import Path

TARGET = Path('/home/z/my-project/src/app/docs/page.tsx')

NEW_ENDPOINTS = '''const EMAIL_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/credentials/connect",
    title: "Connect a NAMED MCPEmail credential (one-time setup)",
    auth: true,
    description:
      "Store YOUR mcpe_ key under a name you choose (personal_email, work_email…). testConnection (default true) validates it with a live mcpemails.com handshake before saving. The credential lives in YOUR account and is mirrored to YOUR private pinned Telegram manifest — the platform never pools user keys, and the response returns only the MASKED key (mcpe_4c7b1e9a…1f3a). Set rateLimitPerMin for a custom MCPEmail send-rate cap per credential.",
    body: "{ name, apiKey, label?, fromName?, rateLimitPerMin?, testConnection? }",
    example: `curl -X POST ${BASE}/api/credentials/connect \\\\
  -H "Authorization: Bearer kv_live_…" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"name":"personal_email","apiKey":"mcpe_4c7b1e9a0d5f…","label":"Personal inbox","rateLimitPerMin":30}'`,
  },
  {
    method: "POST",
    path: "/api/email/send",
    title: "Send an automated email (generic engine)",
    auth: true,
    description:
      "The core automation endpoint. Reference the credential BY NAME — the platform resolves it from your private store and forwards the send to MCPEmail with YOUR key (the platform kv_live_* key is never forwarded upstream). $VAR_NAME$ placeholders in subject/body/htmlBody are substituted from variables; a missing variable aborts the send with 400 missing_variable (never half-rendered). No credential → 404 credential_not_found — the system FAILS CLOSED, there is no project-wide fallback key. Every response carries a request_id.",
    body: "{ credential, to, subject, body?, htmlBody?, variables?, fromName? }",
    example: `curl -X POST ${BASE}/api/email/send \\\\
  -H "Authorization: Bearer kv_live_…" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"credential":"personal_email",
       "to":"user@example.com",
       "subject":"Welcome $NAME$",
       "body":"Hello $NAME$,\\\\n\\\\nYour verification code is $OTP$.",
       "variables":{"NAME":"Akshay","OTP":"483921"}}'`,
  },
  {
    method: "POST",
    path: "/api/email/template/send",
    title: "Send with a stored template — one structure, many variables",
    auth: true,
    description:
      "Save an email structure once (name + subject + body [+ htmlBody]), then vary the variables per request. The template is never modified on send. template may also be an inline { subject, body, htmlBody? } object for one-off structures.",
    body: "{ credential, template: name | {subject, body, htmlBody?}, to, variables?, fromName? }",
    example: `curl -X POST ${BASE}/api/email/template/send \\\\
  -H "Authorization: Bearer kv_live_…" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"credential":"personal_email","template":"welcome",
       "to":"user@example.com","variables":{"NAME":"Akshay","OTP":"483921"}}'`,
  },
  {
    method: "GET",
    path: "/api/email/status/{requestId}",
    title: "Check a request by ID (metadata only)",
    auth: true,
    description:
      "Debug by request_id: returns ts, endpoint, credential name, status (sent|failed), latency_ms, upstream_status and error_code. Never email content, recipients or credentials. 7-day retention, tenant-scoped. GET /api/email/requests lists recent sends.",
  },
  {
    method: "GET",
    path: "/api/credentials",
    title: "List / manage credentials (masked)",
    auth: true,
    description:
      "Lists every credential as a masked view with its label, sender name, custom rate limit and last-used time. DELETE /api/credentials/{name} disconnects one — sends then fail closed. GET /api/credentials/{name} fetches a single view. Raw keys are never returned by any endpoint.",
  },
  {
    method: "POST",
    path: "/api/telegram/connect",
    title: "Connect your private Telegram configuration channel",
    auth: true,
    description:
      "Point the credential bridge at YOUR OWN bot + chat ({ chatId, label?, botToken? }) — the pair is validated live against Telegram before saving. Your named credentials are mirrored to this private pinned manifest (durable across cold boots). GET /api/telegram/config shows the masked status; DELETE reverts to server defaults. For private work, use your own credentials — never another person's.",
  },
  {
    method: "POST",
    path: "/api/email-otp/send",
    title: "DEPRECATED — returns 410 with a migration guide",
    auth: false,
    description:
      "The retired Email OTP endpoints (/api/email-otp/send and /api/email-otp/verify) now return 410 Gone with a machine-readable migration body — nothing is processed and no credential is used. Migrate by generating the code in YOUR app and delivering it via POST /api/email/send with the $OTP$ variable.",
  },
];
'''

NEW_SECTION = '''          {/* ── Email Automation ── */}
          <Section
            id="email"
            eyebrow="05 · email automation"
            title="Email Automation API — privacy-first (MCPEmail + Telegram bridge)"
            intro="A generic email automation engine — OTP codes, welcome mails, notifications, reports, transactional messages — built around credential ownership: YOU bring the MCPEmail key, YOU pick the Telegram channel it is mirrored to, and your platform API key (kv_live_*) only authenticates the call to this API. The API resolves your credential by NAME and forwards the send to MCPEmail with YOUR key. It never falls back to a project-wide credential — missing credentials fail closed."
          >
            <div className="glass rounded-3xl p-5 space-y-4">
              <div className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-3.5 flex items-start gap-2.5">
                <span className="text-base leading-none mt-0.5">🛡</span>
                <p className="text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
                  <strong>Privacy disclaimer.</strong> For private or sensitive email automation, use your own Telegram
                  credentials and your own MCPEmail API key — never credentials belonging to another person. Your
                  mcpe_* key is a user-owned credential used only to execute requests on your behalf; it is never
                  exposed, logged, or reused for other users. The platform API key (kv_live_*) only authorizes access
                  to this automation service; the MCPEmail key is what authenticates with MCPEmail. Never confuse the two.
                </p>
              </div>
              <h3 className="text-[15px] font-semibold">Two credentials, two jobs</h3>
              <pre className="rounded-xl bg-[#2a1c14]/92 text-[#ffd9a8] font-mono text-[11.5px] leading-relaxed p-3.5 overflow-x-auto">{`YOUR APP ── Bearer kv_live_… (platform key) ──▶ ONYX EMAIL API
                                                    │ authenticate caller
                                                    │ resolve credential "personal_email"
                                                    ▼
                                       YOUR mcpe_* key (from your store)
                                                    │
                                                    ▼
                                              MCPEmail → 📧 email

# 1. Connect YOUR key once (mirrored to YOUR Telegram manifest):
POST /api/credentials/connect
{ "name": "personal_email", "apiKey": "mcpe_4c7b1e9a0d5f…",
  "rateLimitPerMin": 30 }                    // custom rate limit (optional)

# 2. Automate — reference the credential BY NAME:
POST /api/email/send
{ "credential": "personal_email",
  "to": "user@example.com",
  "subject": "Welcome $NAME$",
  "body": "Hello $NAME$, your code is $OTP$.",
  "variables": { "NAME": "Akshay", "OTP": "483921" } }`}</pre>
              <div className="grid sm:grid-cols-3 gap-3 text-[12.5px]">
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">$VAR_NAME$ engine</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">{"$NAME$ · $OTP$ · $RESET_URL$ — same template, different values per request. Unknown variables abort the send (missing_variable), never blank-replaced. Template never rebuilt."}</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">fail closed</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">No project-wide MCPEmail key exists. Unknown credential name → 404 credential_not_found. Cross-user access is blocked — credentials are tenant-scoped.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">observability</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">Every send returns a request_id; GET /api/email/status/{"{requestId}"} shows metadata only (latency, status, credential name) — never content, recipients or keys.</p>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 text-[12.5px]">
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">rate limits</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">Per platform key (your kv_live_* rateLimitPerMin) · per client IP (30/min) · per-credential custom cap (rateLimitPerMin, up to 120/min hard ceiling). Secrets are never logged for rate limiting.</p>
                </div>
                <div className="glass-soft rounded-2xl p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-primary">error codes</div>
                  <p className="text-muted-foreground text-[11.5px] leading-relaxed">invalid_api_key · credential_not_found · missing_variable {"{ variable, field }"} · template_not_found · rate_limited · upstream_authentication_failed · upstream_timeout · deprecated (410 on old OTP routes).</p>
                </div>
              </div>
            </div>
            {EMAIL_ENDPOINTS.map((e) => (
              <EndpointCard key={e.path} e={e} />
            ))}
          </Section>
'''

NEW_LIMITS_ROW = '''                    ["Email automation", "Per-key, per-IP (30/min), per-credential custom cap", "Custom rateLimitPerMin per credential (≤120/min hard ceiling); missing $VAR_NAME$ aborts the send; request status kept 7 days (metadata only)."],'''

def replace_between(src: str, start_marker: str, end_marker: str, replacement: str, keep_end: bool = True) -> str:
    lines = src.split('\n')
    start = end = None
    for i, line in enumerate(lines):
        if start_marker in line:
            start = i
        if start is not None and end_marker != start_marker and end_marker in line and i > start:
            end = i
            break
    if start is None or end is None:
        raise SystemExit(f'anchors not found for {start_marker[:40]!r}: start={start}, end={end}')
    new_lines = lines[:start] + replacement.split('\n') + (lines[end:] if keep_end else lines[end + 1:])
    return '\n'.join(new_lines)

def main() -> None:
    src = TARGET.read_text(encoding='utf-8')

    if '/api/credentials/connect' in src and 'Email Automation API — privacy-first' in src:
        print('docs page already migrated — skipping')
        return

    # 1. EMAIL_ENDPOINTS const block.
    src = replace_between(
        src,
        'const EMAIL_ENDPOINTS: Endpoint[] = [',
        'const SHARE_ENDPOINTS: Endpoint[] = [',
        NEW_ENDPOINTS,
    )

    # 2. The Email OTP <Section> render block (from its comment to the Share comment).
    src = replace_between(
        src,
        '{/* ── Email OTP ── */}',
        '{/* ── Share tokens ── */}',
        NEW_SECTION,
    )

    # 3. Limits table row.
    lines = src.split('\n')
    for i, line in enumerate(lines):
        if 'Email OTP code' in line and '10 min TTL' in line:
            lines[i] = NEW_LIMITS_ROW
            break
    src = '\n'.join(lines)

    TARGET.write_text(src, encoding='utf-8')
    print('docs page email sections replaced')

if __name__ == '__main__':
    main()
