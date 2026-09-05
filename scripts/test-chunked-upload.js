#!/usr/bin/env node
/** End-to-end test of the chunked upload system, protocol v2 (stateless,
 * Telegram-staged — multi-instance safe).
 * Usage: node scripts/test-chunked-upload.js [sizeMB]
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000'
const KEY = process.env.ONYX_KEY || ''
const SIZE_MB = Number(process.argv[2] || 12)

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function jfetch(url, init) {
  const res = await fetch(BASE + url, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function main() {
  console.log(`\n=== Chunked upload v2 test — ${SIZE_MB} MB → ${BASE} ===`)
  const size = SIZE_MB * 1024 * 1024
  const buf = Buffer.alloc(size, 7)

  // 1. init — mints the plan (stateless).
  let r = await jfetch('/api/files/upload/init', {
    method: 'POST', headers: H,
    body: JSON.stringify({ fileName: `chunk2-test-${SIZE_MB}mb.bin`, mimeType: 'application/octet-stream', size, chunkSize: 4 * 1024 * 1024 }),
  })
  console.log('init →', r.status, JSON.stringify(r.body).slice(0, 160))
  if (r.status !== 200) process.exit(1)
  const { uploadId, chunkSize, chunkCount } = r.body

  // 2. chunks — each staged as a Telegram document; collect refs.
  const refs = []
  const t0 = Date.now()
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, size)
    const blob = buf.subarray(start, end)
    const res = await fetch(
      `${BASE}/api/files/upload/chunk?uploadId=${uploadId}&index=${i}&chunkCount=${chunkCount}&chunkSize=${chunkSize}&size=${size}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/octet-stream' },
        body: blob,
      },
    )
    const body = await res.json().catch(() => ({}))
    if (res.status !== 200 || !body.ok) {
      console.log(`chunk ${i} → FAIL ${res.status}`, JSON.stringify(body).slice(0, 200))
      process.exit(1)
    }
    refs.push({ index: i, messageId: body.messageId, fileId: body.fileId, storageMode: body.storageMode, botApiBaseUrl: body.botApiBaseUrl })
    process.stdout.write(`chunk ${i + 1}/${chunkCount} ok (${end - start} B)\r`)
  }
  console.log(`\nchunks done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // 3. status — verify the staged set via getFile metadata.
  r = await jfetch('/api/files/upload/status', {
    method: 'POST', headers: H,
    body: JSON.stringify({ uploadId, chunkCount, chunkSize, size, chunks: refs }),
  })
  console.log('status →', r.status, 'complete:', r.body.complete, 'verified:', r.body.verified, 'missing:', JSON.stringify(r.body.missing), 'mismatched:', JSON.stringify(r.body.mismatched))

  // 4. complete — server downloads, assembles, registers, cleans up.
  r = await jfetch('/api/files/upload/complete', {
    method: 'POST', headers: H, body: JSON.stringify({
      uploadId, fileName: `chunk2-test-${SIZE_MB}mb.bin`, mimeType: 'application/octet-stream',
      size, chunkSize, chunkCount, label: null, isPublic: true, chunks: refs,
    }),
  })
  console.log('complete →', r.status, JSON.stringify(r.body).slice(0, 220))
  if (r.status !== 200) process.exit(1)
  console.log(`\n✓ UPLOAD SUCCEEDED — fileId ${r.body.file?.fileId}, download ${r.body.file?.downloadUrl}`)

  // 5. server health after the transfer.
  console.log('\nServer health after upload:')
  const h = await jfetch('/api/health', { headers: H })
  console.log(' →', h.status, h.body.status, JSON.stringify(h.body.components))
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
