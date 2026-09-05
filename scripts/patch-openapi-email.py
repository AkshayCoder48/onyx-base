#!/usr/bin/env python3
"""Task 10: replace the OpenAPI email-otp section with the Email Automation
paths. Anchors on the section comment markers so invisible whitespace can't
break the match. Idempotent: skips if already applied."""

from pathlib import Path

TARGET = Path('/home/z/my-project/src/app/api/openapi.json/route.ts')
NEW_SECTION = """    // ─── Email Automation API (privacy-first, MCPEmail) ───────────────────
    '/api/email/send': {
      post: {
        summary: 'Send an automated email via YOUR named MCPEmail credential',
        description:
          'Privacy-first email automation. Auth = YOUR Onyx Base platform key (kv_live_*) — it authenticates you to THIS API and is never forwarded upstream. The "credential" field names an MCPEmail credential stored in your account (see POST /api/credentials/connect); the send hop to MCPEmail uses YOUR mcpe_* key. $VAR_NAME$ placeholders in subject/body/htmlBody are substituted from "variables"; a missing variable aborts the send with 400 missing_variable (never half-rendered). If the credential does not exist the API FAILS CLOSED (404 credential_not_found) — there is no project-wide fallback key. Responses carry a request_id traceable via GET /api/email/status/{requestId}.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credential: { type: 'string', example: 'personal_email', description: 'Name of the MCPEmail credential to use.' },
                  to: { type: 'string', example: 'user@example.com', description: 'Recipient address (or array of up to 20).' },
                  subject: { type: 'string', example: 'Welcome $NAME$' },
                  body: { type: 'string', example: 'Hello $NAME$, your code is $OTP$.' },
                  htmlBody: { type: 'string', description: 'Optional HTML body (variables apply).' },
                  variables: { type: 'object', example: { NAME: 'Akshay', OTP: '483921' }, description: 'Values for every $VAR_NAME$ used.' },
                  fromName: { type: 'string', description: 'Optional per-send sender name override.' },
                },
                required: ['credential', 'to', 'subject'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Sent', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, success: { type: 'boolean' }, request_id: { type: 'string', example: 'req_83f2a91' }, credential: { type: 'string' }, variables_applied: { type: 'array', items: { type: 'string' } }, latency_ms: { type: 'integer' } } } } } },
          '400': { description: 'bad_request / bad_recipient / missing_variable { variable, field }' },
          '401': { description: 'invalid_api_key — platform key required' },
          '404': { description: 'credential_not_found — fail closed, no fallback' },
          '429': { description: 'rate_limited (per-IP, per-key or per-credential custom limit)' },
          '502': { description: 'upstream_authentication_failed / upstream_error / upstream_rate_limited' },
          '504': { description: 'upstream_timeout' },
        },
      },
    },
    '/api/email/template/send': {
      post: {
        summary: 'Send using a stored template (name) or an inline template',
        description:
          'One template, different variables per request — the stored template is never modified. Body { credential, template: "welcome" | { subject, body, htmlBody? }, to, variables, fromName? }. Unknown template name → 404 template_not_found. Optional subject/body/htmlBody fields on the request override the template fields.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credential: { type: 'string', example: 'personal_email' },
                  template: { type: 'string', example: 'welcome', description: 'Stored template name, or an inline { subject, body, htmlBody? } object.' },
                  to: { type: 'string', example: 'user@example.com' },
                  variables: { type: 'object', example: { NAME: 'Akshay', OTP: '483921' } },
                  fromName: { type: 'string' },
                },
                required: ['credential', 'template', 'to'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Sent (same shape as /api/email/send)' },
          '404': { description: 'template_not_found / credential_not_found' },
          '400': { description: 'missing_variable { variable, field } / bad_request' },
        },
      },
    },
    '/api/email/status/{requestId}': {
      get: {
        summary: 'Status of a previous email request (metadata only)',
        description:
          'Debug by request ID — returns ts, endpoint, credential NAME, status (sent|failed), latency_ms, upstream_status?, error_code?. Never email content, recipients or credentials. Tenant-scoped (you can only see your own requests); 7-day retention; cross-instance entries appear once the metadata snapshot syncs.',
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', example: 'req_83f2a91' } }],
        responses: { '200': { description: 'Request metadata' }, '404': { description: 'request_not_found' } },
      },
    },
    '/api/email/requests': {
      get: { summary: 'Recent email requests for your account (metadata only, newest first)', responses: { '200': { description: 'OK' } } },
    },
    '/api/email/templates': {
      get: { summary: 'List your stored email templates (with detected $VAR_NAME$ variables)', responses: { '200': { description: 'OK' } } },
      post: {
        summary: 'Create or update a named template',
        description: 'Body { name, subject, body, htmlBody? }. Max 50 templates. Templates contain no secrets.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'welcome' }, subject: { type: 'string', example: 'Welcome, $NAME$' }, body: { type: 'string', example: 'Hello $NAME$, your code is $OTP$.' }, htmlBody: { type: 'string' } }, required: ['name', 'subject', 'body'] } } } },
        responses: { '200': { description: 'Saved' }, '400': { description: 'bad_template' } },
      },
    },
    '/api/email/templates/{name}': {
      get: { summary: 'Fetch one template', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'template_not_found' } } },
      delete: { summary: 'Delete a template', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'template_not_found' } } },
    },
    '/api/credentials': {
      get: { summary: 'List your named MCPEmail credentials (masked views only)', description: 'Every entry shows the masked key (mcpe_4c7b1e9a…1f3a) — raw keys are never returned to any client.', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Alias of POST /api/credentials/connect', responses: { '200': { description: 'OK' } } },
    },
    '/api/credentials/connect': {
      post: {
        summary: 'Connect (or update) a NAMED MCPEmail credential',
        description:
          'One-time setup. Body { name, apiKey (mcpe_<64-hex>), label?, fromName?, rateLimitPerMin?, testConnection? }. testConnection defaults to true — the key is validated with a live mcpemails.com initialize handshake before it is stored. The credential is stored in YOUR account (cloudkv + your private pinned Telegram manifest) and mirrored durably; the platform never pools user keys. rateLimitPerMin sets a CUSTOM rate limit for MCPEmail sends through this credential (null/omitted = unlimited up to the platform hard cap).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'personal_email', description: '1–64 chars [A-Za-z0-9_-], no leading dash.' },
                  apiKey: { type: 'string', example: 'mcpe_4c7b1e9a0d5f38a2b6e04d17c9f2a58b3d6e0f1a2b4c6d8e0f2a4b6c8d0e1f3a' },
                  label: { type: 'string', example: 'Personal inbox' },
                  fromName: { type: 'string', example: 'My App' },
                  rateLimitPerMin: { type: 'integer', example: 30, nullable: true },
                  testConnection: { type: 'boolean', example: true },
                },
                required: ['name', 'apiKey'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Connected — response carries ONLY the masked view + connection test result' },
          '400': { description: 'bad_key / bad_name / limit_reached' },
          '401': { description: 'invalid_api_key' },
          '502': { description: 'network_error reaching mcpemails.com' },
        },
      },
    },
    '/api/credentials/{name}': {
      get: { summary: 'Masked view of one credential', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'credential_not_found' } } },
      delete: { summary: 'Disconnect a credential (sends then fail closed)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'credential_not_found' } } },
    },
    '/api/telegram/connect': {
      post: {
        summary: 'Connect your private Telegram configuration channel',
        description:
          'PRIVACY: for private/sensitive automation use YOUR OWN Telegram bot + channel. Body { chatId?, label?, botToken? } — the chat is pinged with the effective bot token BEFORE saving. Your named MCPEmail credentials are mirrored to this private pinned manifest (the durable credential bridge).',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { chatId: { type: 'string', example: '-1001234567890' }, label: { type: 'string' }, botToken: { type: 'string', description: 'Your own bot token; omit to keep, null to clear.' } } } } } },
        responses: { '200': { description: 'Connected (masked response — chat ID never echoed in full)' }, '400': { description: 'Telegram rejected the chat/bot pair' } },
      },
    },
    '/api/telegram/config': {
      get: { summary: 'Telegram bridge status (masked chat ID, never the bot token)', responses: { '200': { description: 'OK' } } },
      put: { summary: 'Same as POST /api/telegram/connect', responses: { '200': { description: 'OK' } } },
      delete: { summary: 'Revert to server-default Telegram config', responses: { '200': { description: 'OK' } } },
    },
    '/api/email-otp/send': {
      post: {
        summary: 'DEPRECATED (410) — replaced by POST /api/email/send',
        deprecated: true,
        description:
          'The Email OTP system was retired. This endpoint returns 410 Gone with a machine-readable migration body and processes NOTHING (no credential is used — there is no project-wide fallback). Migration: connect a named credential (POST /api/credentials/connect), generate the 6-digit code in YOUR app, and deliver it via POST /api/email/send with the $OTP$ variable.',
        responses: { '410': { description: 'Gone — see the migration field in the response body' } },
      },
    },
    '/api/email-otp/verify': {
      post: {
        summary: 'DEPRECATED (410) — verify codes in your application',
        deprecated: true,
        description: 'OTP verification is now application-level. Returns 410 Gone with a migration body; nothing is processed.',
        responses: { '410': { description: 'Gone — see the migration field in the response body' } },
      },
    },
    '/api/dashboard/mcpemail-config': {
      get: { summary: 'LEGACY (deprecated) — read the retired single-config state', responses: { '200': { description: 'Legacy view + deprecation notice' } } },
      put: { summary: 'DEPRECATED (410) — use POST /api/credentials/connect', deprecated: true, responses: { '410': { description: 'Gone' } } },
      delete: { summary: 'DEPRECATED (410) — use DELETE /api/credentials/{name}', deprecated: true, responses: { '410': { description: 'Gone' } } },
    },

"""

def main() -> None:
    src = TARGET.read_text(encoding='utf-8')
    if "'/api/email/send'" in src:
        print('openapi.json already migrated — skipping')
        return
    lines = src.split('\n')
    start = end = None
    for i, line in enumerate(lines):
        if 'Email OTP / automated email service' in line:
            start = i
        if start is not None and 'Chunked file upload (any file size)' in line:
            end = i  # keep the chunked marker line onwards
            break
    if start is None or end is None:
        raise SystemExit(f'anchors not found: start={start}, end={end}')
    new_lines = lines[:start] + NEW_SECTION.split('\n') + lines[end:]
    TARGET.write_text('\n'.join(new_lines), encoding='utf-8')
    print(f'replaced lines {start + 1}..{end} (email-otp section → email automation)')

if __name__ == '__main__':
    main()
