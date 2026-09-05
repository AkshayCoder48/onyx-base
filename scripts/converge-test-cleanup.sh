#!/usr/bin/env bash
# Converge the durable manifest to zero test files.
# Each round: fresh deploy (all instances cold-boot from the current manifest,
# so no resurrection of already-deleted files), delete every test file listed,
# then verify the manifest directly via Telegram.
#
# Required env: ONYX_KEY (user API key), VERCEL_TOKEN (deploy token).
set -u
cd "$(dirname "$0")/.."
: "${ONYX_KEY:?Set ONYX_KEY (user API key)}"
: "${VERCEL_TOKEN:?Set VERCEL_TOKEN (Vercel deploy token)}"
KEY="$ONYX_KEY"

for round in 1 2 3 4; do
  echo "── round $round: deploy fresh instances ──"
  npx --yes vercel@latest deploy --prod --yes --token="$VERCEL_TOKEN" 2>&1 | grep -E "Aliased" | tail -1
  sleep 10

  node -e '
  const KEY = process.env.KEY, BASE = "https://onyxbase-phi.vercel.app";
  const H = { Authorization: `Bearer ${KEY}` };
  (async () => {
    const list = await (await fetch(`${BASE}/api/files`, { headers: H })).json();
    const testFiles = (list.files || []).filter(f => /^(chunk2?-test-|plain-|test-)/.test(f.fileName));
    console.log(`  listed ${testFiles.length} test file(s); deleting…`);
    for (const f of testFiles) {
      const d = await fetch(`${BASE}/api/files/${f.id}`, { method: "DELETE", headers: H });
      process.stdout.write(`  ${d.status} `);
    }
    console.log();
  })();' KEY="$KEY"
  sleep 8

  REMAINING=$(bun scripts/inspect-durable.ts 2>/dev/null | grep -E "TEST files" | head -1 | grep -oE '[0-9]+' | head -1)
  echo "  durable manifest test files: ${REMAINING:-unknown}"
  if [ "${REMAINING:-1}" = "0" ]; then echo "✓ CONVERGED after round $round"; break; fi
done
