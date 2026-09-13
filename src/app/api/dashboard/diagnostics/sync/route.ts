import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { telegramBreakerStatus } from '@/lib/telegram'
import { countRecords } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/diagnostics/sync
 * Telegram sync health for the dashboard: flood-breaker state + local counts.
 * breaker.open=true means Telegram is being rested after repeated floods —
 * writes stay local (durable:false) until the breaker half-opens and a sync
 * succeeds. Cooldowns are 120s windows; any success closes the breaker.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  return ok({
    telegram: telegramBreakerStatus(),
    localRecords: countRecords(user.dbUserId),
  })
}
