// db.js
// 사용자별 학습 진행 상황 + 방문 기록을 저장하는 저장소 (PostgreSQL).
//
// 이전에는 서버 안의 data.json 파일에 저장했는데, Render 무료 서버는
// 재시작/재배포 때 파일이 초기화될 수 있어서 데이터가 사라질 위험이 있었습니다.
// 이제 서버 바깥(Neon 등)의 Postgres에 저장하므로 서버가 재시작되어도 유지됩니다.
//
// 필요한 환경변수: DATABASE_URL  (postgresql://... 형태의 접속 주소)
//
// 함수 이름과 반환 형태는 이전 버전과 같고, 전부 async(Promise)로 바뀌었습니다.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 환경변수가 없습니다. Neon 접속 주소를 설정해주세요.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});
// 유휴 연결이 끊겨도 서버가 죽지 않도록
pool.on('error', (err) => console.error('DB 풀 오류:', err.message));

const LEGACY_FILE = path.join(__dirname, 'data.json');

// ===== 테이블 준비 + (있다면) 기존 data.json 1회 이전 =====
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email       TEXT PRIMARY KEY,
      data        JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      restored    BOOLEAN NOT NULL DEFAULT FALSE,
      consent_at  TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS visits (
      id     BIGSERIAL PRIMARY KEY,
      email  TEXT NOT NULL,
      ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
      hour   SMALLINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_email_idx ON visits (email);
  `);
  await importLegacyFileOnce();
}

// 서버 폴더에 예전 data.json이 남아 있고, DB가 비어 있을 때만 한 번 옮깁니다.
async function importLegacyFileOnce() {
  if (!fs.existsSync(LEGACY_FILE)) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf-8'));
  } catch (e) {
    console.error('data.json 이전 실패(읽기 오류):', e.message);
    return;
  }

  const client = await pool.connect();
  let u = 0, v = 0;
  try {
    await client.query('BEGIN');
    for (const [email, user] of Object.entries(legacy.users || {})) {
      await client.query(
        `INSERT INTO users (email, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
        [email, user.data ?? null, user.createdAt || new Date().toISOString(), user.updatedAt || new Date().toISOString()]
      );
      u++;
    }
    for (const visit of legacy.visits || []) {
      await client.query(
        'INSERT INTO visits (email, ts, hour) VALUES ($1, $2, $3)',
        [visit.email, visit.ts, visit.hour]
      );
      v++;
    }
    await client.query('COMMIT');
    console.log(`기존 data.json 이전 완료: 사용자 ${u}명, 방문 ${v}건`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('data.json 이전 실패(롤백):', e.message);
  } finally {
    client.release();
  }
}

// ===== 사용자 데이터 (진행 상황) =====
async function loadUserData(email) {
  const { rows } = await pool.query('SELECT data FROM users WHERE email = $1', [email]);
  return rows[0] ? rows[0].data : null;
}

async function saveUserData(email, data) {
  await pool.query(
    `INSERT INTO users (email, data) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [email, data]
  );
}

// ===== 방문 기록 =====
// 시간대/날짜 계산은 모두 한국 시간(KST, UTC+9) 기준입니다.
// 서버(Render)는 UTC로 동작하므로 9시간을 더해서 계산합니다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function kstHour(date) { return new Date(date.getTime() + KST_OFFSET_MS).getUTCHours(); }
function kstDay(date) { return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10); }

async function logVisit(email) {
  const now = new Date();
  await pool.query('INSERT INTO visits (email, ts, hour) VALUES ($1, $2, $3)', [
    email, now.toISOString(), kstHour(now),
  ]);
}

async function getVisitStats(email) {
  const { rows: visits } = await pool.query(
    'SELECT ts FROM visits WHERE email = $1 ORDER BY ts ASC',
    [email]
  );

  // 저장된 hour 값 대신 ts에서 한국 시간 기준으로 다시 계산한다.
  // (이전에 UTC로 저장된 기록도 별도 변환 없이 바르게 집계된다.)
  const buckets = { 아침: 0, 오전: 0, 오후: 0, 저녁: 0, 밤: 0 };
  for (const v of visits) {
    const h = kstHour(v.ts);
    if (h >= 5 && h < 9) buckets['아침']++;
    else if (h >= 9 && h < 12) buckets['오전']++;
    else if (h >= 12 && h < 18) buckets['오후']++;
    else if (h >= 18 && h < 22) buckets['저녁']++;
    else buckets['밤']++;
  }
  let mostActiveTimeBucket = null;
  if (visits.length > 0) {
    mostActiveTimeBucket = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0][0];
  }

  const uniqueDays = new Set(visits.map(v => kstDay(v.ts)));

  return {
    visitCount: visits.length,
    activeDayCount: uniqueDays.size,
    mostActiveTimeBucket,
    firstVisit: visits[0] ? visits[0].ts.toISOString() : null,
    lastVisit: visits.length ? visits[visits.length - 1].ts.toISOString() : null,
  };
}

// ===== 관리자용: 전체 사용자 개요 =====
async function getAllUsersOverview() {
  const { rows } = await pool.query(`
    SELECT u.email, u.created_at, u.updated_at, u.data,
           COALESCE(v.cnt, 0)::int AS visit_count,
           v.last_ts
    FROM users u
    LEFT JOIN (
      SELECT email, COUNT(*) AS cnt, MAX(ts) AS last_ts FROM visits GROUP BY email
    ) v ON v.email = u.email
    ORDER BY u.created_at DESC
  `);

  return rows.map(r => {
    let completedTotal = 0;
    if (r.data && r.data.completedByLevel) {
      completedTotal = Object.values(r.data.completedByLevel)
        .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
    }
    const a = analyzeUserData(r.data, kstDay(new Date()));
    return {
      email: r.email,
      level: a.currentLevel,
      learnedLevels: a.learnedLevels,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      visitCount: r.visit_count,
      lastVisit: r.last_ts ? r.last_ts.toISOString() : null,
      completedTotal,
    };
  });
}


// ===== 레벨/학습 지속성 분석 =====
const LEVEL_LIST = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function addDaysISO(isoDay, delta) {
  const d = new Date(isoDay + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 사용자 한 명의 저장 데이터(data JSON)에서 레벨/학습량/출석 지표를 뽑는다.
// today: 한국 날짜(YYYY-MM-DD). 모든 기준은 이 날짜 기준이다.
function analyzeUserData(data, today) {
  const out = {
    currentLevel: null,          // 마지막으로 고른 레벨 (없으면 null)
    learnedLevels: [],           // 단어를 1개 이상 학습한 레벨들 (중복 가능)
    wordsByLevel: {},            // { A1: 12, ... }
    recentWordsByLevel: {},      // 최근 7일(오늘 포함) 완료 기록이 있는 단어 수
    attendanceDays: 0,
    streak: 0,                   // 오늘 또는 어제까지 이어진 연속 출석일
    activeLast7: false,          // 최근 7일 안에 출석한 적 있는지
  };
  if (!data || typeof data !== 'object') return out;

  if (LEVEL_LIST.includes(data.lastLevel)) out.currentLevel = data.lastLevel;

  const cbl = data.completedByLevel || {};
  for (const l of LEVEL_LIST) {
    const n = Array.isArray(cbl[l]) ? cbl[l].length : 0;
    out.wordsByLevel[l] = n;
    if (n > 0) out.learnedLevels.push(l);
  }

  const from7 = addDaysISO(today, -6);
  const att = new Set(Array.isArray(data.attendance) ? data.attendance.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : []);
  out.attendanceDays = att.size;
  out.activeLast7 = [...att].some(d => d >= from7 && d <= today);
  let cursor = att.has(today) ? today : addDaysISO(today, -1);
  while (att.has(cursor)) { out.streak++; cursor = addDaysISO(cursor, -1); }

  for (const l of LEVEL_LIST) out.recentWordsByLevel[l] = 0;
  const done = data.completedAt && typeof data.completedAt === 'object' ? data.completedAt : {};
  for (const [key, ts] of Object.entries(done)) {
    const lvl = String(key).split('|')[0];
    if (!LEVEL_LIST.includes(lvl)) continue;
    const t = new Date(ts);
    if (isNaN(t.getTime())) continue;
    const day = kstDay(t);
    if (day >= from7 && day <= today) out.recentWordsByLevel[lvl]++;
  }
  return out;
}

// 레벨별 요약: "현재 레벨"은 마지막으로 고른 레벨, "학습 경험"은 그 레벨 단어를 1개 이상 외운 사람.
async function getLevelSummary() {
  const { rows } = await pool.query('SELECT email, data FROM users');
  const today = kstDay(new Date());
  const users = rows.map(r => analyzeUserData(r.data, today));

  const result = [];
  for (const l of LEVEL_LIST) {
    const current = users.filter(u => u.currentLevel === l);
    const learners = users.filter(u => u.wordsByLevel[l] > 0);
    const totalWords = learners.reduce((s, u) => s + u.wordsByLevel[l], 0);
    const recentWords = users.reduce((s, u) => s + (u.recentWordsByLevel[l] || 0), 0);
    const recentActiveLearners = users.filter(u => (u.recentWordsByLevel[l] || 0) > 0).length;
    const avg = (arr, f) => (arr.length ? arr.reduce((s, u) => s + f(u), 0) / arr.length : null);
    result.push({
      level: l,
      currentCount: current.length,
      learnerCount: learners.length,
      totalWords,
      avgWordsPerLearner: learners.length ? totalWords / learners.length : null,
      recentWords,
      recentActiveLearners,
      avgAttendanceDays: avg(learners, u => u.attendanceDays),
      avgStreak: avg(learners, u => u.streak),
      active7Rate: learners.length ? learners.filter(u => u.activeLast7).length / learners.length : null,
    });
  }
  const noLevel = users.filter(u => !u.currentLevel).length;
  return { levels: result, noLevelCount: noLevel, totalUsers: users.length };
}

async function getTotalStats() {
  const u = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  const v = await pool.query('SELECT COUNT(*)::int AS n FROM visits');
  return { totalUsers: u.rows[0].n, totalVisits: v.rows[0].n };
}

module.exports = {
  init, pool,
  loadUserData, saveUserData, logVisit, getVisitStats, getAllUsersOverview, getTotalStats,
  getLevelSummary, analyzeUserData,
};
