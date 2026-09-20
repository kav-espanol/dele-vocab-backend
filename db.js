// db.js
// 사용자별 학습 진행 상황 + 방문 기록을 저장하는 아주 단순한 저장소.
//
// 원래는 better-sqlite3(네이티브 모듈)를 썼는데, Render 서버 환경에서
// 컴파일 불일치로 계속 충돌이 나서 순수 JS(JSON 파일) 방식으로 바꿨습니다.
// 네이티브 모듈이 아니라서 "npm install만 되면 어디서든 100% 동일하게 동작"하는
// 게 장점이에요. 지금 규모(개인 프로젝트)에는 이 정도로 충분합니다.
//
// 데이터는 파일 하나(data.json)에 저장됩니다. 다른 함수 이름은 이전과
// 완전히 동일해서, 이 파일만 바꿔도 server.js는 전혀 손댈 필요가 없습니다.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    return { users: {}, visits: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    console.error('data.json 읽기 실패, 새로 시작합니다:', e.message);
    return { users: {}, visits: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

function nowISO() { return new Date().toISOString(); }

// ===== 사용자 데이터 (진행 상황) =====
function loadUserData(email) {
  const db = loadDB();
  const user = db.users[email];
  return user ? user.data : null;
}

function saveUserData(email, data) {
  const db = loadDB();
  const existing = db.users[email];
  db.users[email] = {
    data,
    createdAt: existing ? existing.createdAt : nowISO(),
    updatedAt: nowISO(),
  };
  saveDB(db);
}

// ===== 방문 기록 =====
function logVisit(email) {
  const db = loadDB();
  const now = new Date();
  db.visits.push({ email, ts: now.toISOString(), hour: now.getHours() });
  saveDB(db);
}

function getVisitStats(email) {
  const db = loadDB();
  const visits = db.visits.filter(v => v.email === email).sort((a, b) => a.ts.localeCompare(b.ts));

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

// ===== 관리자용: 전체 사용자 개요 =====
function getAllUsersOverview() {
  const db = loadDB();
  const emails = Object.keys(db.users).sort((a, b) =>
    (db.users[b].createdAt || '').localeCompare(db.users[a].createdAt || '')
  );

  return emails.map(email => {
    const user = db.users[email];
    const userVisits = db.visits.filter(v => v.email === email);
    const lastVisit = userVisits.length
      ? userVisits.map(v => v.ts).sort().slice(-1)[0]
      : null;

    let completedTotal = 0;
    if (user.data && user.data.completedByLevel) {
      completedTotal = Object.values(user.data.completedByLevel)
        .reduce((sum, arr) => sum + (arr?.length || 0), 0);
    }

    return {
      email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      visitCount: userVisits.length,
      lastVisit,
      completedTotal,
    };
  });
}

function getTotalStats() {
  const db = loadDB();
  return {
    totalUsers: Object.keys(db.users).length,
    totalVisits: db.visits.length,
  };
}

module.exports = { loadUserData, saveUserData, logVisit, getVisitStats, getAllUsersOverview, getTotalStats };
