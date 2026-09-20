// server.js
// DELE Planner 단어장 앱 - 이메일 인증번호 발송/검증 백엔드
//
// 로컬 실행:
//   1. npm install
//   2. .env.example 을 .env 로 복사하고 RESEND_API_KEY 채우기
//   3. npm start
//
// 배포는 README.md 참고 (Render / Railway 등 무료 플랜으로 충분)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
}));

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

// ===== 인증번호 저장소 =====
// 프로토타입이라 메모리(Map)에 저장합니다. 서버가 재시작되면 초기화되고,
// 여러 인스턴스로 배포하면(예: 오토스케일링) 공유되지 않습니다.
// 실 서비스로 가면 Redis나 DB 테이블(email, code, expires_at)로 옮기는 걸 권장합니다.
const codeStore = new Map(); // email(소문자) -> { code, expiresAt, attempts }

// 같은 이메일로 너무 자주 요청하는 것을 막는 아주 기본적인 제한
// (분당 1회). 실 서비스에서는 IP 기준 제한도 함께 두는 게 좋습니다.
const lastSentAt = new Map(); // email -> timestamp

const CODE_TTL_MS = 10 * 60 * 1000; // 인증번호 유효시간: 10분
const RESEND_COOLDOWN_MS = 60 * 1000; // 재발송 최소 간격: 60초
const MAX_ATTEMPTS = 5; // 인증번호 오입력 허용 횟수

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6자리
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ===== 1) 인증번호 발송 =====
app.post('/api/send-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: '올바른 이메일 주소를 입력해주세요.' });
  }

  const last = lastSentAt.get(email);
  if (last && Date.now() - last < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return res.status(429).json({ ok: false, error: 'TOO_SOON', message: `${waitSec}초 후에 다시 시도해주세요.` });
  }

  const code = generateCode();
  codeStore.set(email, { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
  lastSentAt.set(email, Date.now());

  try {
    await resend.emails.send({
      from: `DELE Planner 단어장 <${FROM_EMAIL}>`,
      to: email,
      subject: `[DELE Planner] 인증번호 ${code}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto; padding: 32px 24px;">
          <p style="color:#6B7280; font-size:13px; letter-spacing:0.02em; margin-bottom:6px;">DELE PLANNER · 단어장</p>
          <h2 style="margin:0 0 16px; color:#111827;">이메일 인증번호</h2>
          <p style="color:#6B7280; font-size:14.5px; line-height:1.6;">아래 6자리 번호를 앱 화면에 입력해주세요. 10분 동안 유효합니다.</p>
          <div style="background:#EEF2FF; border-radius:12px; padding:20px; text-align:center; margin:20px 0;">
            <span style="font-family: 'Courier New', monospace; font-size:32px; font-weight:700; letter-spacing:8px; color:#1E40AF;">${code}</span>
          </div>
          <p style="color:#9CA3AF; font-size:12.5px;">본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('Resend 발송 실패:', err);
    return res.status(502).json({ ok: false, error: 'SEND_FAILED', message: '메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }

  return res.json({ ok: true, message: '인증번호를 발송했습니다.' });
});

// ===== 2) 인증번호 확인 =====
app.post('/api/verify-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const inputCode = String(req.body.code || '').trim();

  const entry = codeStore.get(email);
  if (!entry) {
    return res.status(400).json({ ok: false, error: 'NO_CODE', message: '먼저 인증번호를 요청해주세요.' });
  }
  if (Date.now() > entry.expiresAt) {
    codeStore.delete(email);
    return res.status(400).json({ ok: false, error: 'EXPIRED', message: '인증번호가 만료됐어요. 다시 요청해주세요.' });
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    codeStore.delete(email);
    return res.status(429).json({ ok: false, error: 'TOO_MANY_ATTEMPTS', message: '시도 횟수를 초과했어요. 다시 요청해주세요.' });
  }

  if (inputCode !== entry.code) {
    entry.attempts += 1;
    return res.status(400).json({ ok: false, error: 'WRONG_CODE', message: '인증번호가 일치하지 않아요.' });
  }

  codeStore.delete(email); // 성공하면 즉시 폐기 (재사용 방지)
  lastSentAt.delete(email);
  return res.json({ ok: true, message: '인증되었습니다.' });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ===== 3) 진행 상황 저장 (학습 완료 단어, 출석 기록) =====
// 프론트엔드가 saveProgress() 할 때마다 통째로 덮어씁니다.
app.post('/api/sync/save', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  }
  db.saveUserData(email, req.body.data || {});
  res.json({ ok: true });
});

// ===== 4) 진행 상황 불러오기 =====
app.get('/api/sync/load', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  }
  const data = db.loadUserData(email);
  res.json({ ok: true, data }); // data는 처음 로그인이면 null
});

// ===== 5) 방문 기록 (로그인할 때마다 호출) =====
app.post('/api/log-visit', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  }
  db.logVisit(email);
  res.json({ ok: true });
});

// ===== 6) 방문 통계 + DELE Planner 제안 여부 =====
// 방문 횟수/활동 일수를 보고 서버가 직접 판단합니다.
// (지금은 간단한 규칙이지만, 나중에 더 정교한 조건으로 바꿔도
//  프론트엔드는 이 엔드포인트만 그대로 호출하면 됩니다.)
app.get('/api/stats', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  }
  const stats = db.getVisitStats(email);
  const shouldSuggestPlanner = stats.visitCount >= 3 || stats.activeDayCount >= 3;
  res.json({ ok: true, ...stats, shouldSuggestPlanner });
});

// ===== 7) 관리자 페이지: 가입자 · 방문 데이터 확인 =====
// 브라우저에서 [배포주소]/admin?key=[ADMIN_KEY 환경변수 값] 으로 접속하면 됩니다.
// 아무나 못 보게 비밀키로 막아뒀어요 — Render 환경변수에 ADMIN_KEY를 꼭 설정하세요.
// ===== 8) CSV 내보내기: 구글시트에서 IMPORTDATA로 불러올 수 있는 주소 =====
// 구글시트 셀에 이렇게 입력하면 이 데이터를 그대로 가져와서 표로 만들어줍니다:
//   =IMPORTDATA("https://[배포주소]/admin/export.csv?key=[ADMIN_KEY]")
// 구글시트가 몇 시간마다 자동으로 새로고침하고, 시트 메뉴에서 수동 새로고침도 가능합니다.
app.get('/admin/export.csv', (req, res) => {
  const key = String(req.query.key || '');
  const expected = process.env.ADMIN_KEY;

  if (!expected || key !== expected) {
    return res.status(401).send('unauthorized');
  }

  const users = db.getAllUsersOverview();

  const escapeCsv = (val) => {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['이메일', '가입일', '방문횟수', '학습완료단어수', '마지막방문'];
  const lines = [header.join(',')];
  for (const u of users) {
    lines.push([
      escapeCsv(u.email),
      escapeCsv(u.createdAt ? u.createdAt.slice(0, 16).replace('T', ' ') : ''),
      escapeCsv(u.visitCount),
      escapeCsv(u.completedTotal),
      escapeCsv(u.lastVisit ? u.lastVisit.slice(0, 16).replace('T', ' ') : ''),
    ].join(','));
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.send('\uFEFF' + lines.join('\n')); // BOM 추가: 한글 깨짐 방지
});

app.get('/admin', (req, res) => {
  const key = String(req.query.key || '');
  const expected = process.env.ADMIN_KEY;

  if (!expected) {
    return res.status(500).send('서버에 ADMIN_KEY 환경변수가 설정되어 있지 않습니다. Render Environment에 추가해주세요.');
  }
  if (key !== expected) {
    return res.status(401).send(`
      <div style="font-family:sans-serif; max-width:400px; margin:60px auto; text-align:center;">
        <h3>관리자 페이지</h3>
        <p style="color:#888;">비밀키를 URL 뒤에 붙여서 접속하세요.<br>예: /admin?key=여기에비밀키</p>
      </div>
    `);
  }

  const totals = db.getTotalStats();
  const users = db.getAllUsersOverview();

  const rows = users.map(u => `
    <tr>
      <td>${u.email}</td>
      <td>${u.visitCount}</td>
      <td>${u.completedTotal}</td>
      <td>${u.createdAt ? u.createdAt.slice(0, 16).replace('T', ' ') : '-'}</td>
      <td>${u.lastVisit ? u.lastVisit.slice(0, 16).replace('T', ' ') : '-'}</td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <title>단어장 관리자</title>
      <style>
        body{ font-family:-apple-system,sans-serif; max-width:900px; margin:40px auto; padding:0 20px; color:#111; }
        h1{ font-size:20px; }
        .stats{ display:flex; gap:16px; margin:20px 0 30px; }
        .stat-box{ background:#EEF2FF; border-radius:12px; padding:16px 20px; }
        .stat-num{ font-size:24px; font-weight:700; color:#1E40AF; }
        .stat-label{ font-size:13px; color:#666; }
        table{ width:100%; border-collapse:collapse; font-size:14px; }
        th, td{ text-align:left; padding:10px 12px; border-bottom:1px solid #eee; }
        th{ background:#f5f5f4; font-weight:600; }
      </style>
    </head>
    <body>
      <h1>📚 단어장 관리자 페이지</h1>
      <p style="margin:-10px 0 20px;"><a href="/admin/export.csv?key=${key}" style="color:#2563EB;">CSV로 내보내기 (구글시트 연결용)</a></p>
      <div class="stats">
        <div class="stat-box"><div class="stat-num">${totals.totalUsers}</div><div class="stat-label">총 가입자</div></div>
        <div class="stat-box"><div class="stat-num">${totals.totalVisits}</div><div class="stat-label">총 방문 횟수</div></div>
      </div>
      <table>
        <thead>
          <tr><th>이메일</th><th>방문 횟수</th><th>학습 완료 단어 수</th><th>가입일</th><th>마지막 방문</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5" style="text-align:center; color:#999;">아직 가입자가 없습니다</td></tr>'}</tbody>
      </table>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
