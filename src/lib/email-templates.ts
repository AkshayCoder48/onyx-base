/**
 * Onyx Base — named email templates (Email Automation PRD §11–§12).
 *
 * Templates let automation keep ONE email structure and vary the content:
 *
 *   POST /api/email/template/send
 *   { "credential": "personal_email",
 *     "template": "welcome",
 *     "to": "user@example.com",
 *     "variables": { "NAME": "Akshay", "OTP": "483921" } }
 *
 * Template bodies use the `$VAR_NAME$` engine (see email-variables.ts).
 * Rendering NEVER modifies the stored template — variables are substituted
 * per-request, so the same template serves every automation run.
 *
 * Storage: records in the user's own account, collection
 * `__email_templates__`, key = template name (rides cloudkv.json + the
 * Telegram manifest mirror, same as credentials).
 */

import { upsertRecord, findRecord, deleteRecord, listRecords } from '@/lib/data-store'
import { extractVariables } from '@/lib/email-variables'

const COLLECTION = '__email_templates__'

/** Max templates per user. */
export const MAX_TEMPLATES = 50

/** Same naming rules as credentials. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

export function isValidTemplateName(name: string): boolean {
  return NAME_RE.test(name)
}

export function templateNameError(name: string): string {
  return `Template name "${name}" is invalid. Use 1–64 characters: letters, digits, "_" or "-", starting with a letter/digit/underscore (e.g. welcome).`
}

export interface EmailTemplateValue {
  subject: string
  body: string
  htmlBody: string | null
  createdAt: string
  updatedAt: string
}

/** Public view — templates contain no secrets, but variable NAMES are listed
 *  so clients can build forms without re-parsing. */
export interface EmailTemplatePublicView extends EmailTemplateValue {
  name: string
  variables: string[]
}

function toView(name: string, value: EmailTemplateValue): EmailTemplatePublicView {
  return {
    name,
    subject: value.subject,
    body: value.body,
    htmlBody: value.htmlBody,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    variables: extractVariables(value.subject, value.body, value.htmlBody),
  }
}

function parseValue(raw: string): EmailTemplateValue | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EmailTemplateValue>
    if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') return null
    if (!parsed.subject.trim() && !parsed.body.trim()) return null
    return {
      subject: parsed.subject,
      body: parsed.body,
      htmlBody: typeof parsed.htmlBody === 'string' && parsed.htmlBody.trim() ? parsed.htmlBody : null,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function listTemplateViews(dbUserId: string): EmailTemplatePublicView[] {
  return listRecords(dbUserId, COLLECTION)
    .map((rec) => {
      const value = parseValue(rec.value)
      return value ? toView(rec.key, value) : null
    })
    .filter((v): v is EmailTemplatePublicView => v !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function getRawTemplate(dbUserId: string, name: string): EmailTemplateValue | null {
  const rec = findRecord(dbUserId, COLLECTION, name)
  if (!rec) return null
  return parseValue(rec.value)
}

export function getTemplateView(dbUserId: string, name: string): EmailTemplatePublicView | null {
  const value = getRawTemplate(dbUserId, name)
  return value ? toView(name, value) : null
}

export interface SaveTemplateOpts {
  name: string
  subject: string
  body: string
  htmlBody?: string | null
}

/** Create or update a named template. Throws on invalid input. */
export function saveTemplate(
  dbUserId: string,
  publicUserId: string,
  opts: SaveTemplateOpts,
): EmailTemplatePublicView {
  const name = opts.name.trim()
  if (!isValidTemplateName(name)) throw new Error(templateNameError(name))

  const subject = opts.subject
  const body = opts.body
  if (typeof subject !== 'string' || !subject.trim()) {
    throw new Error('Template subject is required.')
  }
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('Template body is required (plain text). HTML body is optional.')
  }
  if (subject.length > 998) throw new Error('Template subject is too long (max 998 chars).')
  if (body.length > 1_000_000) throw new Error('Template body is too large (max 1 MB).')

  const existing = getRawTemplate(dbUserId, name)
  const now = new Date().toISOString()
  const value: EmailTemplateValue = {
    subject: subject.trim(),
    body,
    htmlBody: opts.htmlBody?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: name,
    value: JSON.stringify(value),
    valueType: 'object',
  })
  return toView(name, value)
}

/** Delete a template. Returns true when removed. */
export function deleteTemplate(dbUserId: string, name: string): boolean {
  const removed = deleteRecord(dbUserId, COLLECTION, name)
  return removed !== null
}
