#!/usr/bin/env node
/** End-to-end test of the chunked upload system (any-size file fix).
 * Usage: node scripts/test-chunked-upload.js [sizeMB]
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000'
const KEY = process.env.ONYX_KEY || 'kv_live_XXXXXXXXXXXXXXXXXXX'
const SIZE_MB = Number(process.argv[2] || 12)

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function jfetch(url, init) {
  const res = await fetch(BASE + url, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function main() {
  console.log(`\n=== Chunked upload test — ${SIZE_MB} MB ===`)
  const size = SIZE_MB * 1024 * 1024
  const buf = Buffer.alloc(size, 7)

  // 1. init
  let r = await jfetch('/api/files/upload/init', {
    method: 'POST', headers: H,
    body: JSON.stringify({ fileName: `chunk-test-${SIZE_MB}mb.bin`, mimeType: 'application/octet-stream', size, chunkSize: 4 * 1024 * 1024 }),
  })
  console.log('init →', r.status, JSON.stringify(r.body).slice(0, 160))
  if (r.status !== 200) process.exit(1)
  const { uploadId, chunkSize, chunkCount } = r.body

  // 2. chunks
  const t0 = Date.now()
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, size)
    const blob = buf.subarray(start, end)
    const res = await fetch(`${BASE}/api/files/upload/chunk?uploadId=${uploadId}&index=${i}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start) },
      body: blob,
    })
    const body = await res.json().catch(() => ({}))
    if (res.status !== 200) {
      console.log(`chunk ${i} → FAIL ${res.status}`, JSON.stringify(body).slice(0, 200))
      process.exit(1)
    }
    process.stdout.write(`chunk ${i + 1}/${chunkCount} ok (${end - start} B)\r`)
  }
  console.log(`\nchunks done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // 3. status
  r = await jfetch(`/api/files/upload/status?uploadId=${uploadId}`, { headers: H })
  console.log('status →', r.status, 'complete:', r.body.complete, 'missing:', r.body.missingChunks?.length)

  // 4. complete
  r = await jfetch('/api/files/upload/complete', {
    method: 'POST', headers: H, body: JSON.stringify({ uploadId }),
  })
  console.log('complete →', r.status, JSON.stringify(r.body).slice(0, 220))
  if (r.status !== 200) process.exit(1)
  console.log(`\n✓ UPLOAD SUCCEEDED — fileId ${r.body.file?.fileId}, download ${r.body.file?.downloadUrl}`)

  // 5. memory report
  const mem = process.memoryUsage ? null : null
  console.log('\nServer health after upload:')
  const h = await jfetch('/api/health', { headers: H })
  console.log(' →', h.status, h.body.status, JSON.stringify(h.body.components))
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
