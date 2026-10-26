// 백업 JSON(/admin/backup.json 으로 받은 파일)에서 사용자 기록을 되돌립니다.
// 사용:  DATABASE_URL=... node tools/restore-backup.js backup-2026-10-26.json [--email a@b.com] [--overwrite]
//  - 기본: DB에 없는 사용자만 추가합니다(기존 기록은 건드리지 않음).
//  - --overwrite: 같은 이메일이 있으면 백업 내용으로 덮어씁니다.
//  - --email: 한 명만 복구합니다.
const fs = require('fs');
const { Pool } = require('pg');
const args = process.argv.slice(2);
const ei = args.indexOf('--email');
const only = ei >= 0 ? args[ei + 1] : null;
const file = args.find((a, i) => !a.startsWith('--') && i !== (ei >= 0 ? ei + 1 : -1));
const overwrite = args.includes('--overwrite');
if (!file || !process.env.DATABASE_URL) { console.error('사용법: DATABASE_URL=... node tools/restore-backup.js <백업파일> [--email x] [--overwrite]'); process.exit(1); }
const b = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(b.users)) { console.error('백업 파일 형식이 맞지 않습니다.'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  let added = 0, replaced = 0, skipped = 0;
  for (const u of b.users) {
    if (only && u.email !== only) continue;
    const conflict = overwrite
      ? 'ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, restored = TRUE'
      : 'ON CONFLICT (email) DO NOTHING';
    const r = await pool.query(
      `INSERT INTO users (email, data, created_at, updated_at, consent_at) VALUES ($1, $2, $3, $4, $5) ${conflict} RETURNING (xmax = 0) AS inserted`,
      [u.email, u.data, u.created_at, u.updated_at, u.consent_at]);
    if (!r.rowCount) skipped++; else if (r.rows[0].inserted) added++; else replaced++;
  }
  for (const q of b.quizDaily || []) {
    if (only && q.email !== only) continue;
    await pool.query(`INSERT INTO quiz_daily (email, day, level, n, c) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (email, day, level) DO UPDATE SET n = GREATEST(quiz_daily.n, EXCLUDED.n), c = GREATEST(quiz_daily.c, EXCLUDED.c)`, [q.email, q.day, q.level, q.n, q.c]);
  }
  console.log(`추가 ${added}명, 덮어씀 ${replaced}명, 건너뜀 ${skipped}명`);
  await pool.end();
})().catch(e => { console.error('복구 실패:', e.message); process.exit(1); });
