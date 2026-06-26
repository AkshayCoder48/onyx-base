'use client'

import { useState } from 'react'
import { BookOpen, Copy, Check, Terminal, Code2, Globe, Server, Key, ShieldCheck, HardDrive, Database, Sparkles } from 'lucide-react'
import { PageHeader } from './shell'
import { useOnyxBase } from '@/lib/store'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'

// ─────────────────────────────────────────────────────────────────────────────
// Code block with copy button + language label
// ─────────────────────────────────────────────────────────────────────────────

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success('Copied')
    } catch {
      toast.error('Copy failed')
    }
  }
  return (
    <div className="relative rounded-lg border border-border/60 bg-stone-900 group">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-mono uppercase tracking-wider text-stone-400">{lang}</span>
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[11px] text-stone-300 hover:text-white hover:bg-white/10 opacity-70 group-hover:opacity-100" onClick={copy}>
          {copied ? <><Check className="size-3 mr-1" /> Copied</> : <><Copy className="size-3 mr-1" /> Copy</>}
        </Button>
      </div>
      <pre className="font-mono text-[12px] leading-relaxed text-stone-100 px-4 py-3 overflow-x-auto scroll-slim max-h-[420px]">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Multi-language tabs for a single operation
function MultiLangCode({ samples }: { samples: { lang: string; label: string; code: string }[] }) {
  return (
    <Tabs defaultValue={samples[0].lang}>
      <div className="overflow-x-auto scroll-slim pb-1 -mx-1 px-1">
        <TabsList className="inline-flex h-9 w-max gap-0.5">
          {samples.map((s) => (
            <TabsTrigger key={s.lang} value={s.lang} className="text-[11px] px-3 py-1.5 whitespace-nowrap">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {samples.map((s) => (
        <TabsContent key={s.lang} value={s.lang} className="mt-2">
          <CodeBlock code={s.code} lang={s.lang} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint card
// ─────────────────────────────────────────────────────────────────────────────

function EndpointCard({
  method,
  path,
  title,
  description,
  auth,
  children,
}: {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  title: string
  description: string
  auth?: string
  children: React.ReactNode
}) {
  const methodColor =
    method === 'GET' ? 'bg-primary/15 text-primary border-primary/30'
    : method === 'POST' ? 'bg-amber-100 text-amber-800 border-amber-300'
    : 'bg-rose-100 text-rose-700 border-rose-300'
  return (
    <div className="rounded-xl border border-border/60 bg-card/30 overflow-hidden">
      <div className="p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${methodColor}`}>{method}</span>
          <code className="font-mono text-sm text-foreground">{path}</code>
        </div>
        <div>
          <h3 className="font-semibold text-[15px]">{title}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
        {auth && (
          <div className="flex items-start gap-1.5 text-[12px] text-muted-foreground bg-muted/30 rounded-md px-2.5 py-1.5">
            <Key className="size-3.5 mt-0.5 shrink-0 text-primary" />
            <span><code className="font-mono text-primary">Authorization: Bearer kv_live_…</code> — {auth}</span>
          </div>
        )}
      </div>
      <div className="px-4 sm:px-5 pb-5 space-y-3">{children}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Section wrapper
// ─────────────────────────────────────────────────────────────────────────────

function Section({ id, icon, title, description, children }: { id: string; icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 space-y-4">
      <div className="flex items-start gap-3">
        <div className="size-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
          {icon}
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Docs view
// ─────────────────────────────────────────────────────────────────────────────

export function DocsView() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const userId = useOnyxBase((s) => s.user?.userId)
  const maskedKey = apiKey ? `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}` : 'kv_live_xxxxxxxx'
  const keyForCode = apiKey || 'kv_live_YOUR_API_KEY'
  // Use the actual hosted origin — never localhost. Falls back to a relative
  // path (empty string) during SSR; the browser always has window.location.
  const apiBase = typeof window !== 'undefined' ? window.location.origin : ''

  // "Copy for LLMs" — fetches /llms.txt (the llmstxt.org convention) and writes
  // the markdown to the clipboard so a user can paste it straight into an LLM.
  const [llmCopied, setLlmCopied] = useState(false)
  async function copyForLlms() {
    try {
      const r = await fetch('/llms.txt')
      if (!r.ok) throw new Error(`/llms.txt returned ${r.status}`)
      const text = await r.text()
      await navigator.clipboard.writeText(text)
      setLlmCopied(true)
      setTimeout(() => setLlmCopied(false), 2000)
      toast.success('Copied — paste into your favourite LLM')
    } catch (e) {
      toast.error('Copy failed — try fetching /llms.txt directly')
    }
  }

  return (
    <div className="space-y-10">
      <PageHeader
        title="Docs"
        description="Everything you need to use Onyx Base — REST API, CLI, and drop-in SDKs for every language."
        actions={
          <Button variant="outline" size="sm" onClick={copyForLlms} className="gap-1.5">
            {llmCopied
              ? <><Check className="size-3.5 text-emerald-600" /> Copied for LLMs</>
              : <><Sparkles className="size-3.5 text-primary" /> Copy for LLMs</>}
          </Button>
        }
      />

      {/* Quick nav */}
      <div className="rounded-lg border border-border/60 bg-card/30 p-3 flex flex-wrap gap-2 text-[12px]">
        <span className="text-muted-foreground/70 mr-1 self-center font-medium">Jump to:</span>
        {[
          ['#quickstart', 'Quickstart'],
          ['#auth', 'Authentication'],
          ['#set', 'Set a key'],
          ['#get', 'Get a key'],
          ['#delete', 'Delete a key'],
          ['#list', 'List keys'],
          ['#export', 'Export'],
          ['#cli', 'CLI'],
          ['#html', 'HTML SDK'],
          ['#share', 'Public Share'],
          ['#events', 'Telegram events'],
          ['#features', 'Features'],
        ].map(([href, label]) => (
          <a key={href} href={href} className="px-2 py-0.5 rounded border border-border/50 hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-colors">
            {label}
          </a>
        ))}
      </div>

      {/* ── Quickstart ── */}
      <Section id="quickstart" icon={<Globe className="size-4" />} title="Quickstart" description="Store your first value in 30 seconds — pick whichever language you like.">
        <MultiLangCode
          samples={[
            {
              lang: 'curl',
              label: 'cURL',
              code: `# 1. Create an account (one-time) — returns your API key
curl -X POST ${apiBase}/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Ada","email":"ada@example.com","source":"cli"}'

# → {"ok":true,"userId":"usr_xxx","apiKey":"kv_live_xxx", ...}

# 2. Set a key
curl -X POST ${apiBase}/v1/set \\
  -H "Authorization: Bearer ${keyForCode}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"greeting","value":"hello world"}'

# 3. Read it back
curl ${apiBase}/v1/get/greeting \\
  -H "Authorization: Bearer ${keyForCode}"`,
            },
            {
              lang: 'cli',
              label: 'CLI',
              code: `# Create an account
onyx login --name "Ada" --email ada@example.com

# Set + get
onyx set greeting "hello world"
onyx get greeting
# → hello world

# List + export
onyx list -v
onyx export --output backup.json`,
            },
            {
              lang: 'html',
              label: 'HTML',
              code: `<!-- Drop-in: works in any static HTML page -->
<script>
const API = '${apiBase}';
const KEY = '${keyForCode}';

async function setKV(key, value) {
  const r = await fetch(API + '/v1/set', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  });
  return r.json();
}

async function getKV(key) {
  const r = await fetch(API + '/v1/get/' + key, {
    headers: { 'Authorization': 'Bearer ' + KEY }
  });
  return r.json();
}

setKV('greeting', 'hello from HTML').then(console.log);
getKV('greeting').then(d => console.log(d.value));
</script>`,
            },
            {
              lang: 'javascript',
              label: 'JavaScript',
              code: `const API = '${apiBase}';
const KEY = '${keyForCode}';

async function setKV(key, value, collection = 'default') {
  const r = await fetch(\`\${API}/v1/set\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key, value, collection }),
  });
  return r.json();
}

async function getKV(key, collection = 'default') {
  const r = await fetch(
    \`\${API}/v1/get/\${encodeURIComponent(key)}?collection=\${collection}\`,
    { headers: { 'Authorization': \`Bearer \${KEY}\` } },
  );
  if (!r.ok) throw new Error('Key not found');
  return r.json();
}

await setKV('score', 9001);
const { value } = await getKV('score');
console.log(value); // 9001`,
            },
            {
              lang: 'python',
              label: 'Python',
              code: `import requests

API = "${apiBase}"
KEY = "${keyForCode}"
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# Set
requests.post(f"{API}/v1/set", headers=HEADERS,
              json={"key": "score", "value": 9001})

# Get
r = requests.get(f"{API}/v1/get/score", headers=HEADERS)
print(r.json()["value"])  # 9001

# List
r = requests.get(f"{API}/v1/list", headers=HEADERS)
print(r.json()["keys"])  # ["score", ...]

# Delete
requests.delete(f"{API}/v1/delete/score", headers=HEADERS)`,
            },
            {
              lang: 'react',
              label: 'React',
              code: `'use client';
import { useState, useEffect } from 'react';

const API = '${apiBase}';
const KEY = '${keyForCode}';

export function useKV(key) {
  const [value, setValue] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(\`\${API}/v1/get/\${key}\`, {
      headers: { Authorization: \`Bearer \${KEY}\` },
    })
      .then(r => r.json())
      .then(d => setValue(d.value))
      .finally(() => setLoading(false));
  }, [key]);

  async function update(newValue) {
    await fetch(\`\${API}/v1/set\`, {
      method: 'POST',
      headers: { Authorization: \`Bearer \${KEY}\`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: newValue }),
    });
    setValue(newValue);
  }

  return { value, loading, set: update };
}

// Usage:
// const { value, set } = useKV('theme');
// <button onClick={() => set('dark')}>Dark</button>`,
            },
            {
              lang: 'node',
              label: 'Node.js',
              code: `import { request } from 'undici';

const API = '${apiBase}';
const KEY = '${keyForCode}';

async function kv(method, path, body) {
  const r = await request(\`\${API}\${path}\`, {
    method,
    headers: {
      'Authorization': \`Bearer \${KEY}\`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.body.json();
}

await kv('POST', '/v1/set', { key: 'coins', value: 500 });
const { value } = await kv('GET', '/v1/get/coins');
console.log(value); // 500`,
            },
          ]}
        />
      </Section>

      {/* ── Authentication ── */}
      <Section id="auth" icon={<Key className="size-4" />} title="Authentication" description="Every request (except signup) needs your API key in the Authorization header.">
        <div className="rounded-lg border border-border/60 bg-card/30 p-4 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary">YOUR ACCOUNT</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[12px]">
            <div><span className="text-muted-foreground">User ID:</span> <span className="text-sky-600">{userId || 'usr_xxxxx'}</span></div>
            <div><span className="text-muted-foreground">API Key:</span> <span className="text-primary font-semibold">{maskedKey}</span></div>
          </div>
        </div>
        <CodeBlock lang="http" code={`# Every request carries the Bearer header
Authorization: Bearer ${keyForCode}`} />
        <p className="text-[13px] text-muted-foreground">
          Your API key is the only credential — there is no password. Treat it like a password: never commit it to git,
          never put it in client-side code that ships to production. The key grants full read/write access to your data.
        </p>
      </Section>

      {/* ── POST /v1/set ── */}
      <Section id="set" icon={<Server className="size-4" />} title="Set a key" description="Create or update a value. Values are auto-typed (string / number / boolean / JSON).">
        <EndpointCard method="POST" path="/v1/set" title="Store or update a value" auth="required" description="Upserts a key in a collection. If the key already exists, the value (and the Telegram backup message) is updated in place.">
          <div className="text-[13px] text-muted-foreground">
            <strong className="text-foreground">Body:</strong> <code className="font-mono text-primary">{'{ "key": string, "value": any, "collection"?: string }'}</code>
          </div>
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl -X POST ${apiBase}/v1/set \\
  -H "Authorization: Bearer ${keyForCode}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"coins","value":500,"collection":"default"}'` },
              { lang: 'javascript', label: 'JS', code: `await fetch('${apiBase}/v1/set', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ${keyForCode}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ key: 'coins', value: 500, collection: 'default' }),
}).then(r => r.json());` },
              { lang: 'python', label: 'Python', code: `import requests
r = requests.post('${apiBase}/v1/set',
    headers={'Authorization': 'Bearer ${keyForCode}', 'Content-Type': 'application/json'},
    json={'key': 'coins', 'value': 500, 'collection': 'default'})
print(r.json())` },
              { lang: 'cli', label: 'CLI', code: `onyx set coins 500
onyx set theme "dark"
onyx set premium true
onyx set user '{"name":"alice","age":30}'
onyx set counter 1 --collection metrics` },
            ]}
          />
          <CodeBlock lang="json" code={`// Response · 200
{
  "ok": true,
  "key": "coins",
  "value": 500,
  "type": "number",
  "collection": "default",
  "updatedAt": "2026-06-25T07:36:01.588Z"
}`} />
        </EndpointCard>
      </Section>

      {/* ── GET /v1/get ── */}
      <Section id="get" icon={<Server className="size-4" />} title="Get a key" description="Read a single value. Returns 404 when the key doesn't exist.">
        <EndpointCard method="GET" path="/v1/get/:key?collection=default" title="Read a value" auth="required" description="Returns the stored value with its detected type. Use ?collection= to read from a non-default collection.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl ${apiBase}/v1/get/coins \\
  -H "Authorization: Bearer ${keyForCode}"` },
              { lang: 'javascript', label: 'JS', code: `const r = await fetch(
  '${apiBase}/v1/get/coins?collection=default',
  { headers: { 'Authorization': 'Bearer ${keyForCode}' } },
);
const data = await r.json();
console.log(data.value); // 500` },
              { lang: 'python', label: 'Python', code: `import requests
r = requests.get('${apiBase}/v1/get/coins',
    headers={'Authorization': 'Bearer ${keyForCode}'})
print(r.json()['value'])  # 500` },
              { lang: 'cli', label: 'CLI', code: `onyx get coins
# → 500  (stdout, pipe-friendly)
# # (number) collection=default  (stderr)` },
            ]}
          />
          <CodeBlock lang="json" code={`// Response · 200
{
  "ok": true,
  "key": "coins",
  "value": 500,
  "type": "number",
  "collection": "default",
  "updatedAt": "2026-06-25T07:36:01.588Z"
}

// Response · 404 (key missing)
{ "ok": false, "error": "Key not found." }`} />
        </EndpointCard>
      </Section>

      {/* ── DELETE /v1/delete ── */}
      <Section id="delete" icon={<Server className="size-4" />} title="Delete a key" description="Remove a key permanently. Also deletes the Telegram backup message.">
        <EndpointCard method="DELETE" path="/v1/delete/:key?collection=default" title="Delete a value" auth="required" description="Returns 404 when the key doesn't exist. The corresponding Telegram backup message is also deleted.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl -X DELETE ${apiBase}/v1/delete/coins \\
  -H "Authorization: Bearer ${keyForCode}"` },
              { lang: 'javascript', label: 'JS', code: `await fetch('${apiBase}/v1/delete/coins', {
  method: 'DELETE',
  headers: { 'Authorization': 'Bearer ${keyForCode}' },
}).then(r => r.json());` },
              { lang: 'python', label: 'Python', code: `import requests
r = requests.delete('${apiBase}/v1/delete/coins',
    headers={'Authorization': 'Bearer ${keyForCode}'})
print(r.json())` },
              { lang: 'cli', label: 'CLI', code: `onyx delete coins
# ✓ Deleted coins` },
            ]}
          />
        </EndpointCard>
      </Section>

      {/* ── GET /v1/list ── */}
      <Section id="list" icon={<Server className="size-4" />} title="List keys" description="List all keys in a collection (or all collections).">
        <EndpointCard method="GET" path="/v1/list?collection=default" title="List keys" auth="required" description="Returns just the key names. Use /v1/export if you need the values too.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl "${apiBase}/v1/list?collection=default" \\
  -H "Authorization: Bearer ${keyForCode}"` },
              { lang: 'javascript', label: 'JS', code: `const r = await fetch('${apiBase}/v1/list',
  { headers: { 'Authorization': 'Bearer ${keyForCode}' } });
const { keys } = await r.json();
console.log(keys); // ["coins", "theme", "user"]` },
              { lang: 'python', label: 'Python', code: `import requests
r = requests.get('${apiBase}/v1/list',
    headers={'Authorization': 'Bearer ${keyForCode}'})
print(r.json()['keys'])` },
              { lang: 'cli', label: 'CLI', code: `onyx list        # keys only (stdout)
onyx list -v     # KEY/TYPE/COLLECTION table` },
            ]}
          />
          <CodeBlock lang="json" code={`// Response · 200
{
  "ok": true,
  "keys": ["coins", "premium", "theme", "user"],
  "count": 4,
  "collection": "default"
}`} />
        </EndpointCard>
      </Section>

      {/* ── GET /v1/export ── */}
      <Section id="export" icon={<Server className="size-4" />} title="Export" description="Dump the whole database (or one collection) as a JSON object.">
        <EndpointCard method="GET" path="/v1/export?collection=default" title="Export as JSON" auth="required" description="Returns { key: value, … }. Non-default collections are prefixed with the collection name and a dot.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl "${apiBase}/v1/export" \\
  -H "Authorization: Bearer ${keyForCode}"` },
              { lang: 'javascript', label: 'JS', code: `const r = await fetch('${apiBase}/v1/export',
  { headers: { 'Authorization': 'Bearer ${keyForCode}' } });
const { data } = await r.json();
console.log(data);` },
              { lang: 'python', label: 'Python', code: `import requests, json
r = requests.get('${apiBase}/v1/export',
    headers={'Authorization': 'Bearer ${keyForCode}'})
data = r.json()['data']
print(json.dumps(data, indent=2))` },
              { lang: 'cli', label: 'CLI', code: `onyx export
onyx export --output backup.json
onyx export --collection metrics` },
            ]}
          />
          <CodeBlock lang="json" code={`// Response · 200
{
  "ok": true,
  "data": {
    "coins": 500,
    "premium": true,
    "theme": "dark",
    "user": { "name": "alice", "age": 30 },
    "metrics.counter": 1
  }
}`} />
        </EndpointCard>
      </Section>

      {/* ── File storage ── */}
      <Section id="files" icon={<HardDrive className="size-4" />} title="File storage" description="Store files via the standard Telegram Bot API — up to 50 MB on upload and 20 MB on download. Any extension (exe, txt, png, jpg, zip, video, audio, anything). Every file gets a permanent download link that proxies through this server; the Telegram URL is never exposed.">
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3.5 text-[13px] text-muted-foreground space-y-1.5">
          <p className="font-medium text-foreground/90">File-size limits (Telegram Bot API)</p>
          <p>
            <strong className="text-foreground">Upload:</strong> up to <strong>50 MB</strong> via the cloud Bot API
            (<code className="font-mono">sendDocument</code> / <code className="font-mono">sendVideo</code> / …).
            <br/>
            <strong className="text-foreground">Download:</strong> up to <strong>20 MB</strong> via <code className="font-mono">getFile</code>
            (Telegram only returns a <code className="font-mono">file_path</code> for files ≤ 20 MB).
          </p>
          <p>
            <strong className="text-foreground">Need bigger?</strong> A self-hosted
            <a href="https://github.com/tdlib/telegram-bot-api" target="_blank" rel="noreferrer" className="text-primary hover:underline"> Local Bot API Server</a>
            {' '}raises both limits to <strong>2 GB</strong>. Onyx Base does not currently support this — it is a
            roadmap item (operator-configurable <code className="font-mono">TELEGRAM_BOT_API_URL</code>).
          </p>
        </div>
        <EndpointCard method="POST" path="/v1/files" title="Upload a file" auth="required" description="multipart/form-data with a `file` field. Optional: `label` (string), `public` ('true'|'false', default true). Returns a permanent /f/<fileId> link.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl -X POST "${apiBase}/v1/files" \\
  -H "Authorization: Bearer ${keyForCode}" \\
  -F "file=@./report.pdf" \\
  -F "label=Q3 report"` },
              { lang: 'javascript', label: 'JS', code: `const form = new FormData();
form.append('file', fileInput.files[0]);
form.append('label', 'Q3 report');
const r = await fetch('${apiBase}/v1/files', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ${keyForCode}' },
  body: form,
});
const { file } = await r.json();
console.log(file.downloadUrl);` },
              { lang: 'python', label: 'Python', code: `import requests
r = requests.post('${apiBase}/v1/files',
    headers={'Authorization': 'Bearer ${keyForCode}'},
    files={'file': open('report.pdf', 'rb')},
    data={'label': 'Q3 report'})
print(r.json()['file']['downloadUrl'])` },
              { lang: 'cli', label: 'CLI', code: `onyx upload ./report.pdf --label "Q3 report"
onyx upload ./movie.mp4
onyx upload ./setup.exe --private` },
            ]}
          />
          <CodeBlock lang="json" code={`// Response · 200
{
  "ok": true,
  "file": {
    "id": "ckxyz",
    "fileId": "f_a1b2c3...",
    "fileName": "report.pdf",
    "mimeType": "application/pdf",
    "size": 482103,
    "label": "Q3 report",
    "isPublic": true,
    "downloads": 0,
    "downloadUrl": "${typeof window !== 'undefined' ? window.location.origin : apiBase}/f/f_a1b2c3..."
  }
}`} />
        </EndpointCard>

        <EndpointCard method="GET" path="/f/:fileId" title="Download a file (public proxy)" auth="none" description="The permanent link. Our server calls Telegram's getFile behind the scenes, downloads the stream, and pipes it straight back to you. Add ?inline=1 to render in-browser instead of forcing a download.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl -L -o report.pdf "${apiBase}/f/f_a1b2c3..."
# or render inline:
curl -L "${apiBase}/f/f_a1b2c3...?inline=1"` },
              { lang: 'cli', label: 'CLI', code: `onyx download f_a1b2c3...
onyx download "${apiBase}/f/f_a1b2c3..."` },
            ]}
          />
        </EndpointCard>

        <EndpointCard method="GET" path="/v1/files" title="List files" auth="required" description="List all stored files with their permanent links and download counts.">
          <MultiLangCode
            samples={[
              { lang: 'curl', label: 'cURL', code: `curl "${apiBase}/v1/files" \\
  -H "Authorization: Bearer ${keyForCode}"` },
              { lang: 'cli', label: 'CLI', code: `onyx files` },
            ]}
          />
        </EndpointCard>

        <div className="rounded-md border border-primary/20 bg-primary/5 p-3.5 text-[13px] text-muted-foreground">
          <p className="font-medium text-foreground/90 mb-1">Where do uploads go?</p>
          <p>
            When you haven’t set up a custom Bot Token + Chat ID in Settings, uploads are stored
            <strong className="text-foreground"> automatically on the server-side Telegram bot</strong> — no
            configuration needed. Set up your own Telegram bot in Settings to route new uploads to your
            private chat instead. Each file records which backend it used, so downloads and deletes always
            hit the correct bot even if you change your config later.
          </p>
        </div>
      </Section>

      {/* ── CLI reference ── */}
      <Section id="cli" icon={<Terminal className="size-4" />} title="CLI reference" description="The onyx CLI is a zero-dependency Node.js tool. Install it globally, or run it directly with node.">
        <CodeBlock lang="bash" code={`# Install
npm i -g onyx-base

# Point the CLI at this hosted server (one-time setup)
export ONYX_URL=${apiBase}

# All commands
onyx login                              # create an account (uses ONYX_URL)
onyx login --name "Ada" --email a@x.com # create with profile
onyx login --key kv_live_xxx            # connect an existing account
onyx login --server ${apiBase} --key kv_live_xxx  # explicit server override
onyx set <key> <value> [--collection X] # store a value (auto-typed)
onyx get <key>      [--collection X]    # read a value (stdout = value only)
onyx delete <key>   [--collection X]    # remove a value (alias: rm)
onyx list           [--collection X] [-v]  # list keys (alias: ls)
onyx export         [--collection X] [--output FILE]
onyx whoami                              # show current credentials
onyx health                              # service + Telegram status
onyx logout                              # clear saved credentials

# Environment
ONYX_URL=${apiBase} onyx set k v   # override server`} />
        <p className="text-[13px] text-muted-foreground">
          Config is stored at <code className="font-mono text-primary">~/.onyx/config.json</code> with 0600 permissions.
          <code className="font-mono text-primary"> get</code> and <code className="font-mono text-primary">list</code> keep stdout clean for piping; type hints go to stderr.
        </p>
      </Section>

      {/* ── HTML SDK ── */}
      <Section id="html" icon={<Code2 className="size-4" />} title="HTML / vanilla JS SDK" description="A drop-in snippet for static sites — no build step, no framework.">
        <CodeBlock lang="html" code={`<!DOCTYPE html>
<html>
<head><title>Onyx Base demo</title></head>
<body>
  <h1>Visitor counter</h1>
  <p>Visits: <span id="count">…</span></p>
  <button onclick="increment()">+1</button>

  <script>
  const API = '${apiBase}';
  const KEY = '${keyForCode}';
  const HEADERS = { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  async function getKV(key) {
    const r = await fetch(API + '/v1/get/' + key, { headers: HEADERS });
    if (!r.ok) return null;
    return (await r.json()).value;
  }

  async function setKV(key, value) {
    await fetch(API + '/v1/set', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ key, value })
    });
  }

  async function increment() {
    const current = (await getKV('visits')) || 0;
    await setKV('visits', current + 1);
    document.getElementById('count').textContent = current + 1;
  }

  // Load on page open
  getKV('visits').then(v => {
    document.getElementById('count').textContent = v || 0;
  });
  </script>
</body>
</html>`} />
        <p className="text-[13px] text-muted-foreground">
          ⚠️ The API key above is visible to anyone who opens devtools on your page. For public HTML
          (CodePen, static sites, browser extensions) use{' '}
          <a href="#share" className="text-primary hover:underline">Public Share Tokens</a> instead —
          scoped, revocable, and safe to leak.
        </p>
      </Section>

      {/* ── Public Share Tokens (source-safe) ── */}
      <Section id="share" icon={<ShieldCheck className="size-4" />} title="Public Share Tokens (public HTML, CodePen, static sites)" description="Expose one key to public HTML without leaking your master API key. Scoped, revocable, rate-limited, and safe to embed in source-visible platforms.">
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
          <p className="text-[13px] text-foreground">
            <strong>The problem:</strong> Platforms like CodePen, JSFiddle, and
            static-site hosts show your full HTML/JS source to everyone. If you paste your
            <code className="font-mono"> kv_live_…</code> API key into the file, anyone can copy it and wipe your data.
          </p>
          <p className="text-[13px] text-muted-foreground">
            <strong className="text-foreground">The solution:</strong> Create a <em>share token</em> — a public,
            scoped credential bound to ONE key. It can be read-only or write-only, has a per-IP rate
            limit, an optional expiry, and can be revoked instantly. If it leaks, the worst case is
            one value gets exposed. Revoke and rotate.
          </p>
        </div>

        <EndpointCard
          method="GET"
          path="/v1/share/{token}"
          title="Public read (no auth)"
          description="Read the single key this token is scoped to. Safe to call from any browser, any origin."
          auth="None — the token in the URL IS the credential."
        >
          <MultiLangCode samples={[
            {
              lang: 'html',
              label: 'HTML',
              code: `<!-- ✅ SAFE — only a scoped, revocable token is exposed -->
<script>
// 1. Create a read token in Dashboard → Public Share → New share token
//    (mode: read-only, key: "announcement", rate limit: 60/min)
const READ_URL = '${apiBase}/v1/share/st_YOUR_TOKEN_HERE';

fetch(READ_URL)
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      document.getElementById('msg').textContent = data.value;
    }
  });
</script>

<p id="msg">Loading…</p>`,
            },
            {
              lang: 'curl',
              label: 'cURL',
              code: `# No auth header needed — the token is in the URL
curl ${apiBase}/v1/share/st_YOUR_TOKEN_HERE
# → {"ok":true,"key":"announcement","value":"Hello world","type":"string"}`,
            },
          ]} />
        </EndpointCard>

        <EndpointCard
          method="POST"
          path="/v1/write/{token}"
          title="Public write (no auth) — counters, guestbooks, leaderboards"
          description="Write to the single key this token is scoped to. Supports set, incr (with min/max clamps), and append."
          auth="None — the token in the URL IS the credential."
        >
          <MultiLangCode samples={[
            {
              lang: 'html',
              label: 'HTML (vote button)',
              code: `<!-- ✅ Source-safe "I visited" counter -->
<script>
// Create a write token in the dashboard:
//   mode: write-only, key: "visits", allowedOps: ["incr"],
//   incrMin: 0, incrMax: 1000000, rate limit: 30/min
const WRITE_URL = '${apiBase}/v1/write/st_YOUR_WRITE_TOKEN';
const READ_URL  = '${apiBase}/v1/share/st_YOUR_READ_TOKEN';

// Increment the counter when someone clicks the button
async function vote() {
  const r = await fetch(WRITE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'incr', amount: 1 })
  });
  const d = await r.json();
  if (d.ok) document.getElementById('count').textContent = d.value;
}

// Load current count on page open
fetch(READ_URL).then(r => r.json()).then(d => {
  if (d.ok) document.getElementById('count').textContent = d.value ?? 0;
});
</script>

<button onclick="vote()">👍 Vote (<span id="count">0</span>)</button>`,
            },
            {
              lang: 'curl',
              label: 'cURL',
              code: `# Increment
 curl -X POST ${apiBase}/v1/write/st_YOUR_WRITE_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"op":"incr","amount":1}'
# → {"ok":true,"op":"incr","value":1,"previous":0,"type":"number"}

# Overwrite (if 'set' is in allowedOps)
 curl -X POST ${apiBase}/v1/write/st_YOUR_WRITE_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"op":"set","value":"new content"}'

# Append (if 'append' is in allowedOps)
 curl -X POST ${apiBase}/v1/write/st_YOUR_WRITE_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"op":"append","value":"\\nnew line"}'`,
            },
          ]} />
        </EndpointCard>

        <div className="rounded-lg border border-border/60 bg-card/30 p-4 space-y-2">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" /> Security model
          </h4>
          <ul className="text-[13px] text-muted-foreground space-y-1.5 list-disc pl-5">
            <li><strong className="text-foreground">Scoped</strong> — each token is bound to exactly one <code className="font-mono">(collection, key)</code> pair. It cannot touch any other key.</li>
            <li><strong className="text-foreground">Mode-restricted</strong> — a read token can&apos;t write; a write token can&apos;t read. Even if both leak, damage is limited to that one key.</li>
            <li><strong className="text-foreground">Op-restricted</strong> — write tokens list allowed ops (<code className="font-mono">set</code>, <code className="font-mono">incr</code>, <code className="font-mono">append</code>). An incr-only token can&apos;t overwrite the value.</li>
            <li><strong className="text-foreground">Rate-limited</strong> — per-IP, per-minute. Stops a malicious visitor from hammering your token.</li>
            <li><strong className="text-foreground">Bounded</strong> — <code className="font-mono">maxValueLength</code> caps set/append size; <code className="font-mono">incrMin/incrMax</code> clamp counters so they can&apos;t runaway.</li>
            <li><strong className="text-foreground">Expiring</strong> — optional TTL auto-disables the token.</li>
            <li><strong className="text-foreground">Revocable</strong> — revoke instantly from the dashboard. The public URL returns 404 immediately.</li>
          </ul>
        </div>
      </Section>

      {/* ── Telegram events ── */}
      <Section id="events" icon={<BookOpen className="size-4" />} title="Telegram storage events" description="Telegram IS the database. Every operation is persisted as a structured message in your private Telegram channel — your full data and audit log live in Telegram.">
        <div className="grid sm:grid-cols-2 gap-3">
          {[
            { op: 'SET', emoji: '🗂', desc: 'Key created/updated — full JSON value mirrored, message edited on update' },
            { op: 'DELETE', emoji: '🗑️', desc: 'Key removed — backup message deleted from Telegram' },
            { op: 'signup', emoji: '🎉', desc: 'New account created (web or CLI)' },
            { op: 'login', emoji: '🔐', desc: 'Dashboard session started' },
            { op: 'apikey.create', emoji: '🗝️', desc: 'New API key minted' },
            { op: 'apikey.revoke', emoji: '🚫', desc: 'API key revoked' },
            { op: 'collection.create', emoji: '📁', desc: 'New collection created' },
            { op: 'export', emoji: '📤', desc: 'Database exported' },
          ].map((e) => (
            <div key={e.op} className="rounded-lg border border-border/60 bg-card/30 p-3 flex items-start gap-2.5">
              <span className="text-lg leading-none mt-0.5">{e.emoji}</span>
              <div>
                <div className="font-mono text-[12px] text-primary">{e.op}</div>
                <div className="text-[12px] text-muted-foreground mt-0.5">{e.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <CodeBlock lang="text" code={`🗂 Onyx Base · SET
owner: usr_txyb1d
collection: default
key: coins
type: number
updatedAt: 1782372961
─────────────────
500

🎉 Onyx Base · signup
owner: usr_txyb1d
source: cli
detail: CLI Telegram Test · cli-tg@example.com
at: 2026-06-25T07:40:12.000Z`} />
        <p className="text-[13px] text-muted-foreground">
          Channel: <strong className="text-foreground">{process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL_NAME ?? 'your-channel'}</strong>{' '}
          (@{process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL_HANDLE ?? 'your_channel'}). Bot:{' '}
          <strong className="text-foreground">@{process.env.NEXT_PUBLIC_TELEGRAM_BOT_HANDLE ?? 'your_bot'}</strong>. Check the{' '}
          <strong>Settings → Storage backend</strong> panel for live connection status.
        </p>
      </Section>

      {/* ── Feature inventory (Supabase-style mapping) ── */}
      <Section
        id="features"
        icon={<Sparkles className="size-4" />}
        title="Feature inventory"
        description="How Onyx Base maps to the Supabase-style platform primitives — what's implemented, what's an equivalent, and what's on the roadmap."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
          <FeatureLegend />
        </div>

        {/* ─── Security ─── */}
        <FeatureCard
          icon={<ShieldCheck className="size-4" />}
          title="Security"
          subtitle="Per-user isolation, signed tokens, audit trail — defence in depth, no shared surface."
          features={[
            { name: 'Row Level Security (RLS)', status: 'equivalent', desc: 'Per-userId data isolation on every query — no user can read another user\'s records.' },
            { name: 'Policies', status: 'equivalent', desc: 'API-key scoping + share-token scope field (read/write) bound to a single (collection, key).' },
            { name: 'JWT Verification', status: 'equivalent', desc: 'Signed download tokens (HMAC-SHA256, constant-time verify) for private-file access.' },
            { name: 'SSL Connections', status: 'equivalent', desc: 'HTTPS terminated at the Caddy gateway; HSTS enforced.' },
            { name: 'Network Restrictions', status: 'roadmap', desc: 'Env-configurable allow/deny list of source IPs at the gateway.' },
            { name: 'IP Allow Lists', status: 'roadmap', desc: 'Per-API-key IP allowlist (reject calls from unlisted addresses).' },
            { name: 'Vault (Secrets)', status: 'equivalent', desc: 'All secrets in .env (gitignored). BOOTSTRAP_ADMIN_KEY, CLOUDKV_SECRET, TELEGRAM_BOT_TOKEN never in source.' },
            { name: 'Audit Logs', status: 'implemented', desc: 'Every write / login / admin action recorded in the logs table + mirrored to Telegram.' },
          ]}
        />

        {/* ─── Database ─── */}
        <FeatureCard
          icon={<Database className="size-4" />}
          title="Database"
          subtitle="SQLite is the fast local index; Telegram is the durable mirror. No connection pool, no replicas — reads are local and instant."
          features={[
            { name: 'Managed PostgreSQL', status: 'different', desc: 'N/A — Onyx Base uses SQLite + Telegram. PostgreSQL is not the model.' },
            { name: 'SQL Editor', status: 'implemented', desc: 'Read-only SQL console in the dashboard — run SELECT queries against virtual tables (records, collections, api_keys, logs, users) pre-filtered to your account. 1000-row cap, API keys masked, ⌘+Enter to run.' },
            { name: 'Database Branching', status: 'roadmap', desc: 'Per-environment SQLite snapshots with optional Telegram replay.' },
            { name: 'Point-in-Time Recovery (PITR)', status: 'equivalent', desc: 'Telegram mirror is an append-only durable backup — manifest + record messages can be replayed.' },
            { name: 'Backups', status: 'implemented', desc: 'Every record mirrored to Telegram; identity manifest is pinned after every write.' },
            { name: 'Read Replicas', status: 'different', desc: 'N/A — single-node SQLite; reads are local and instant.' },
            { name: 'Connection Pooling', status: 'different', desc: 'N/A — embedded SQLite, no connections to pool.' },
            { name: 'Extensions (PostGIS, pgvector, pg_cron)', status: 'different', desc: 'N/A — SQLite has no equivalent extension ecosystem. Roadmap: FTS5 for full-text search.' },
            { name: 'Triggers', status: 'equivalent', desc: 'Event system — every write fires a record:changed event (WebSocket + Telegram mirror).' },
            { name: 'Functions (PL/pgSQL)', status: 'roadmap', desc: 'Server-side JS/TS handlers (webhook-style) callable from /v1/*.' },
            { name: 'Views', status: 'roadmap', desc: 'Named, server-defined projections over collections.' },
            { name: 'Materialized Views', status: 'roadmap', desc: 'Pre-computed aggregations refreshed on write.' },
            { name: 'Foreign Data Wrappers (FDW)', status: 'different', desc: 'N/A — not applicable to the SQLite+Telegram model.' },
          ]}
        />

        {/* ─── Data API ─── */}
        <FeatureCard
          icon={<Server className="size-4" />}
          title="Data API"
          subtitle="Every collection auto-exposes /v1/* with per-userId isolation by default — no schema publishing step, no RLS toggle to forget."
          features={[
            { name: 'Enable Data API (REST API)', status: 'implemented', desc: '/v1/* is the auto-generated REST surface for KV + files.' },
            { name: 'Auto-generated RESTful API', status: 'implemented', desc: 'Every collection auto-exposes /v1/set, /v1/get, /v1/delete, /v1/list.' },
            { name: 'GraphQL API', status: 'roadmap', desc: 'Single /v1/graphql endpoint with per-userId scoping.' },
            { name: 'OpenAPI documentation', status: 'roadmap', desc: '/api/openapi.json + /api/docs (Swagger UI).' },
            { name: 'Realtime API', status: 'implemented', desc: 'WebSocket mini-service on port 3003 pushes record:changed events.' },
            { name: 'RPC (Database Functions)', status: 'roadmap', desc: 'Invoke server-side JS/TS handlers via /v1/rpc/:name.' },
            { name: 'API Keys', status: 'implemented', desc: 'kv_live_* keys — per-user, revocable, named, multiple per account.' },
            { name: 'JWT Authentication', status: 'equivalent', desc: 'Signed download tokens (short-lived, HMAC-SHA256).' },
            { name: 'Auto-expose new tables / RLS-by-default', status: 'equivalent', desc: 'Every new collection is immediately accessible via /v1/* with automatic per-userId isolation.' },
          ]}
        />
      </Section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature inventory helpers (Security / Database / Data API)
// ─────────────────────────────────────────────────────────────────────────────

type FeatureStatus = 'implemented' | 'equivalent' | 'roadmap' | 'different'

const STATUS_BADGE_CLASS: Record<FeatureStatus, string> = {
  implemented: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  equivalent:  'bg-primary/15 text-primary border-primary/30',
  roadmap:     'bg-muted text-muted-foreground border-border/60',
  different:   'bg-stone-100 text-stone-600 border-stone-300',
}

const STATUS_LABEL: Record<FeatureStatus, string> = {
  implemented: 'Implemented',
  equivalent:  'Equivalent',
  roadmap:     'Roadmap',
  different:   'Different',
}

function FeatureLegend() {
  const items: FeatureStatus[] = ['implemented', 'equivalent', 'roadmap', 'different']
  return (
    <>
      {items.map((s) => (
        <div key={s} className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Badge variant="outline" className={STATUS_BADGE_CLASS[s]}>{STATUS_LABEL[s]}</Badge>
          <span className="truncate">
            {s === 'implemented' && 'shipped today'}
            {s === 'equivalent' && 'different primitive, same outcome'}
            {s === 'roadmap' && 'planned, not yet shipped'}
            {s === 'different' && 'not the Onyx Base model'}
          </span>
        </div>
      ))}
    </>
  )
}

function FeatureCard({
  icon,
  title,
  subtitle,
  features,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  features: { name: string; status: FeatureStatus; desc: string }[]
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/30 overflow-hidden">
      <div className="p-4 sm:p-5 border-b border-border/40 bg-primary/[0.03]">
        <div className="flex items-center gap-2.5">
          <div className="size-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
            {icon}
          </div>
          <div>
            <h3 className="font-semibold text-[15px]">{title}</h3>
            <p className="text-[12px] text-muted-foreground mt-0.5 leading-snug">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="divide-y divide-border/40">
        {features.map((f) => (
          <div
            key={f.name}
            className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] gap-1.5 sm:gap-4 px-4 sm:px-5 py-3 items-start sm:items-center"
          >
            <div className="font-medium text-[13px] text-foreground/90">{f.name}</div>
            <div>
              <Badge variant="outline" className={STATUS_BADGE_CLASS[f.status]}>
                {STATUS_LABEL[f.status]}
              </Badge>
            </div>
            <div className="text-[12.5px] text-muted-foreground leading-snug">{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
