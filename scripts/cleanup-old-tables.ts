import { db } from '../src/lib/db'
const rows = await db.$queryRawUnsafe<{name:string}[]>(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usr_%'`)
console.log('Old usr_* tables:', JSON.stringify(rows))
for (const r of rows) {
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${r.name}\``)
  console.log('Dropped', r.name)
}
process.exit(0)
