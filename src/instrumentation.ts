/**
 * Onyx Base — global process hardening.
 *
 * Catches any unhandled promise rejections or uncaught exceptions so a
 * rogue Telegram fetch (or any other best-effort async operation) can NEVER
 * crash the Next.js server process. The error is logged but the process
 * stays alive.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[unhandledRejection]', reason)
      // Do NOT exit — keep serving requests.
    })
    process.on('uncaughtException', (err) => {
      console.error('[uncaughtException]', err)
      // Do NOT exit — keep serving requests.
    })
  }
}
