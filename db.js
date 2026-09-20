// db.js
// 사용자별 학습 진행 상황 + 방문 기록을 저장하는 아주 단순한 SQLite 저장소.
//
// 파일 하나(data.sqlite)에 전부 저장됩니다. 별도의 DB 서버를 띄울 필요가 없어서
// 프로토타입 단계에는 충분하지만, 무료 호스팅(Render 무료 플랜 등)은
// 재배포할 때 디스크가 초기화될 수 있다는 점은 알아두세요.
// 사용자가 늘어나면 Postgres 같은 실제 DB로 옮기는 걸 권장합니다 —
// 이 파일의 함수 이름(getUser/saveUser/logVisit 등)만 유지하면
// 나머지 서버 코드는 거의 손댈 필요가 없습니다.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    data TEXT NOT NULL,          -- JSON: { attendance: [...], completedByLevel: {...} }
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts TEXT NOT NULL,            -- ISO 타임스탬프
    hour INTEGER NOT NULL        -- 0-23, 시간대 분석용
  );

  CREATE INDEX IF NOT EXISTS idx_visits_email ON visits(email);
`);

function nowISO() { return new Date().toISOString(); }

// ===== 사용자 데이터 (진행 상황) =====
function loadUserData(email) {
  const row = db.prepare('SELECT data FROM users WHERE email = ?').get(email);
  return row ? JSON.parse(row.data) : null;
}

function saveUserData(email, data) {
  const json = JSON.stringify(data);
  const existing = db.prepare('SELECT email FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE users SET data = ?, updated_at = ? WHERE email = ?')
      .run(json, nowISO(), email);
  } else {
    db.prepare('INSERT INTO users (email, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(email, json, nowISO(), nowISO());
  }
}

// ===== 방문 기록 =====
function logVisit(email) {
  const now = new Date();
  db.prepare('INSERT INTO visits (email, ts, hour) VALUES (?, ?, ?)')
    .run(email, now.toISOString(), now.getHours());
}

function getVisitStats(email) {
  const visits = db.prepare('SELECT ts, hour FROM visits WHERE email = ? ORDER BY ts ASC').all(email);

  const buckets = { 아침: 0, 오전: 0, 오후: 0, 저녁: 0, 밤: 0 };
  for (const v of visits) {
    const h = v.hour;
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

  const uniqueDays = new Set(visits.map(v => v.ts.slice(0, 10)));

  return {
    visitCount: visits.length,
    activeDayCount: uniqueDays.size,
    mostActiveTimeBucket,
    firstVisit: visits[0]?.ts || null,
    lastVisit: visits[visits.length - 1]?.ts || null,
  };
}

module.exports = { loadUserData, saveUserData, logVisit, getVisitStats };
