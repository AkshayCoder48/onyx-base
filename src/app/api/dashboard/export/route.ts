import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { exportData } from '@/lib/kv'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** GET /api/dashboard/export?collection= — download the full database as JSON. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const collection = req.nextUrl.searchParams.get('collection') || undefined
  const data = await exportData(user, collection)
  await logAction(user, 'export', undefined, collection ? `collection=${collection}` : 'all', 'dashboard')
  void sendEventMessage({
    owner: user.userId,
    event: 'export',
    detail: collection ? `collection=${collection}` : 'all',
    source: 'dashboard',
    ts: Math.floor(Date.now() / 1000),
  })

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="cloudkv-export-${Date.now()}.json"`,
    },
  })
}
