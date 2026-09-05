/**
 * Onyx Base — $VAR_NAME$ email template variable engine.
 *
 * Automation emails need variables that can be substituted WITHOUT editing
 * the email structure itself. A user keeps ONE template:
 *
 *   Hello $NAME$,
 *   Your verification code is $OTP$.
 *   Regards, $SENDER_NAME$
 *
 * …and supplies different variables per request:
 *
 *   { "variables": { "NAME": "Akshay", "OTP": "483921", "SENDER_NAME": "Onyx" } }
 *
 * Design rules (privacy-first Email Automation PRD §9–§11):
 *   - Pattern is EXACTLY `\$([A-Za-z_][A-Za-z0-9_]*)\$` — a dollar-delimited
 *     identifier. `$CODE`, `$NAME!`, `$` alone are NOT variables (the old OTP
 *     system used bare `$CODE`; the new engine requires the closing `$`).
 *   - The engine processes subject, plain-text body AND HTML body.
 *   - Unknown variables are NEVER silently replaced with empty strings —
 *     the send FAILS with `missing_variable` so malformed emails can never
 *     go out (e.g. "Your code is " with the OTP missing).
 *   - Values are substituted as plain strings; variable NAMES are matched
 *     case-sensitively ($OTP$ ≠ $otp$) so typos surface as missing_variable
 *     errors rather than silently dropping content.
 *   - No template rebuilding: rendering is a pure string transform; the
 *     stored template is never modified.
 */

/** The canonical $VAR_NAME$ pattern (PRD §10). */
export const VARIABLE_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g

/** Fields of an email that participate in variable substitution. */
export type VariableField = 'subject' | 'body' | 'htmlBody'

/**
 * Extract every distinct variable name used in a text, in order of first
 * appearance. Repeated variables are reported once. Pure function — safe on
 * the client (composer preview) and server (validation).
 */
export function extractVariables(...texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    VARIABLE_PATTERN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = VARIABLE_PATTERN.exec(text)) !== null) {
      seen.add(m[1])
    }
  }
  return [...seen]
}

/** Validate the shape of a user-supplied variables map (string/number values). */
export function sanitizeVariables(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue // ignore malformed keys
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v)
    else if (typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

export interface RenderedEmail {
  subject: string
  body?: string
  htmlBody?: string
  /** Variables that were substituted (for logs/metadata — names only, never values). */
  appliedVariables: string[]
}

export type RenderResult =
  | { ok: true; rendered: RenderedEmail }
  | { ok: false; code: 'missing_variable'; variable: string; field: VariableField }

/**
 * Substitute `$VAR_NAME$` occurrences in subject / body / htmlBody.
 *
 * Returns `{ok:false, code:'missing_variable', variable, field}` when a
 * variable used in the template has no entry in `variables` — the caller
 * MUST abort the send (fail closed, never send a half-rendered email).
 */
export function renderTemplate(
  template: { subject: string; body?: string | null; htmlBody?: string | null },
  variables: Record<string, string>,
): RenderResult {
  const applied: string[] = []
  const substitute = (text: string): string =>
    text.replace(VARIABLE_PATTERN, (whole, name: string) => {
      if (Object.prototype.hasOwnProperty.call(variables, name)) {
        if (!applied.includes(name)) applied.push(name)
        return variables[name]
      }
      // Marked by the caller via a sentinel — see below.
      return `\u0000MISSING:${name}`
    })

  const outSubject = substitute(template.subject)
  const outBody = template.body != null ? substitute(template.body) : undefined
  const outHtml = template.htmlBody != null ? substitute(template.htmlBody) : undefined

  // Detect any unresolved variable and fail with its name + field.
  // The sentinel is `\u0000MISSING:<name>` where <name> is [A-Za-z0-9_]+ —
  // the character right after the sentinel name is whatever followed the
  // closing `$` in the original text (a period, a space, …), so the name
  // must be extracted with a strict identifier regex, not a split.
  const fields: Array<[string | undefined, VariableField]> = [
    [outSubject, 'subject'],
    [outBody, 'body'],
    [outHtml, 'htmlBody'],
  ]
  for (const [text, field] of fields) {
    if (text == null) continue
    const m = /\u0000MISSING:([A-Za-z0-9_]+)/.exec(text)
    if (m) {
      return { ok: false, code: 'missing_variable', variable: m[1], field }
    }
  }

  // Strip any leftover sentinel artifacts (defensive — should not happen).
  const clean = (s: string): string => s.replace(/\u0000MISSING:[A-Za-z0-9_]*\$/g, '')
  return {
    ok: true,
    rendered: {
      subject: clean(outSubject),
      body: outBody != null ? clean(outBody) : undefined,
      htmlBody: outHtml != null ? clean(outHtml) : undefined,
      appliedVariables: applied,
    },
  }
}
