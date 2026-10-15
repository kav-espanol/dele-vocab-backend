// scripts/import-emails.js
// 복구한 이메일 목록(예: Resend 로그에서 모은 수신자)을 DB에 "복구된 계정"으로 등록합니다.
//  - 학습 기록은 비어 있고(data = NULL), restored = TRUE 로 표시됩니다.
//  - 이미 있는 이메일은 건드리지 않습니다 (기존 학습 기록 보호).
//  - 가입일(created_at)은 --since 로 준 날짜(기본: 지금)로 들어갑니다. 실제 가입일을 모르면 추정치임을 의미해요.
//
// 사용법:
//   DATABASE_URL="postgresql://..." node scripts/import-emails.js emails.txt [--since 2026-09-20] [--dry-run]
//
// emails.txt: 한 줄에 이메일 하나 (CSV처럼 쉼표가 섞여 있어도 이메일 형태만 골라냅니다)

const fs = require('fs');
const db = require('../db');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && a !== sinceVal());
function sinceVal() {
  const i = args.indexOf('--since');
  return i >= 0 ? args[i + 1] : undefined;
}
const dryRun = args.includes('--dry-run');
const since = sinceVal() ? new Date(sinceVal()) : new Date();

if (!file) { console.error('사용법: node scripts/import-emails.js emails.txt [--since YYYY-MM-DD] [--dry-run]'); process.exit(1); }
if (isNaN(since.getTime())) { console.error('--since 날짜 형식이 올바르지 않아요 (예: 2026-09-20)'); process.exit(1); }

const found = fs.readFileSync(file, 'utf-8').match(/[^\s@,;"<>]+@[^\s@,;"<>]+\.[^\s@,;"<>]+/g) || [];
const emails = [...new Set(found.map(e => e.toLowerCase()))];

(async () => {
  console.log(`읽은 이메일: ${found.length}개 (중복 제거 후 ${emails.length}개)`);
  if (dryRun) { console.log('[dry-run] DB에는 쓰지 않았어요.'); emails.forEach(e => console.log(' ', e)); process.exit(0); }

  await db.init();
  let added = 0, skipped = 0;
  for (const email of emails) {
    const r = await db.pool.query(
      `INSERT INTO users (email, data, created_at, updated_at, restored)
       VALUES ($1, NULL, $2, $2, TRUE) ON CONFLICT (email) DO NOTHING`,
      [email, since.toISOString()]
    );
    if (r.rowCount === 1) added++; else skipped++;
  }
  console.log(`새로 등록: ${added}개 / 이미 있어서 건너뜀: ${skipped}개`);
  await db.pool.end();
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
