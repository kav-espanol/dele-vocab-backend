[README.md](https://github.com/user-attachments/files/32429169/README.md)
# DELE Planner 단어장 - 이메일 인증 백엔드

프론트엔드(vocab-study-app.html)의 "인증번호 받기" 기능을 실제로 작동시키는 서버입니다.

## 1. 로컬에서 먼저 테스트하기

```bash
npm install
cp .env.example .env
```

`.env` 파일을 열어서 `RESEND_API_KEY`를 채워주세요.

1. https://resend.com 가입 (무료, 카드 등록 필요 없음)
2. API Keys 메뉴에서 키 발급 → `.env`에 붙여넣기
3. 도메인 인증 전이라면 `FROM_EMAIL`은 그냥 `onboarding@resend.dev` 그대로 두면 됩니다
   (단, 이 상태에서는 **본인 계정으로 가입한 이메일 주소로만** 발송 테스트가 가능합니다.
   실제 사용자에게 보내려면 아래 "도메인 연결" 단계가 필요해요.)

```bash
npm start
```

`http://localhost:3000/api/health` 접속해서 `{"ok":true}` 뜨면 정상입니다.

## 2. 도메인 연결하기 (실제 서비스용)

`onboarding@resend.dev`는 테스트용이라 아무 이메일에나 보낼 수 없어요.
진짜 사용자에게 발송하려면:

1. 본인 소유의 도메인이 필요합니다 (예: deleplanner.com)
2. Resend 대시보드 → Domains → 도메인 추가 → 안내되는 DNS 레코드(TXT, MX)를 도메인 관리 업체(가비아, Route53 등)에 등록
3. 인증되면 `.env`의 `FROM_EMAIL`을 `noreply@deleplanner.com` 같은 형태로 변경

DNS 전파는 보통 몇 분~1시간 정도 걸립니다.

## 3. 배포하기

로컬 컴퓨터를 계속 켜둘 수는 없으니, 아래 중 하나에 올리면 됩니다. 모두 무료 플랜으로 시작 가능합니다.

**Render (추천 — 가장 간단함)**
1. https://render.com 가입 → New → Web Service
2. 이 폴더를 GitHub 저장소로 올린 뒤 연결 (또는 Render의 "수동 배포"로 zip 업로드)
3. Build Command: `npm install` / Start Command: `npm start`
4. Environment 탭에서 `.env`에 있던 값들을 그대로 등록
5. 배포 완료 후 나오는 주소(예: `https://dele-vocab-backend.onrender.com`)를 기억해두세요

**Railway / Vercel(서버리스 함수로 변형 필요)도 비슷한 방식입니다.**

## 4. 프론트엔드와 연결하기

배포된 서버 주소를 `vocab-study-app.html` 안의 `API_BASE_URL` 상수에 넣으면 끝입니다.
(이 부분은 제가 이미 반영해뒀어요 — 배포 주소만 알려주시면 바로 바꿔드릴게요.)

## 5. 이 서버가 제공하는 API

| 엔드포인트 | 용도 |
|---|---|
| `POST /api/send-code` | 이메일로 인증번호 발송 |
| `POST /api/verify-code` | 인증번호 확인 |
| `POST /api/sync/save` | 학습 진행 상황(완료 단어, 출석) 저장 |
| `GET /api/sync/load?email=...` | 학습 진행 상황 불러오기 (다른 기기에서도 이어서 학습 가능) |
| `POST /api/log-visit` | 로그인할 때마다 방문 시각 기록 |
| `GET /api/stats?email=...` | 방문 횟수·활동일수 집계 + DELE Planner 제안 여부(`shouldSuggestPlanner`) 판단 |
| `GET /admin?key=...` | 가입자 목록 + 방문/학습 통계를 표로 보여주는 관리자 페이지 (비밀키로 보호됨) |

방문 기록과 학습 데이터는 `data.sqlite` 파일 하나에 저장됩니다 (별도 DB 서버 필요 없음).

## 참고: 지금 이 서버의 한계

- 인증번호를 메모리(Map)에 저장합니다 → 서버 재시작되면 진행 중이던 인증이 초기화됩니다.
  트래픽이 늘면 Redis나 DB 테이블로 옮기는 걸 권장해요 (구조는 거의 그대로 유지 가능).
- 학습 데이터·방문 기록은 `data.sqlite` 파일에 저장되는데, 무료 호스팅(Render 무료 플랜 등)은
  재배포하거나 일정 시간 잠자기 상태로 들어갔다 깨어나면 디스크가 초기화될 수 있어요.
  사용자가 늘어나면 Render의 Postgres 무료 플랜이나 Supabase 같은 실제 DB로 옮기는 걸 권장합니다
  (`db.js`의 함수 이름만 유지하면 나머지 서버 코드는 거의 안 건드려도 돼요).
- IP 기준 요청 제한은 걸려있지 않아요. 스팸성 남용이 걱정되면 `express-rate-limit` 같은 패키지를 추가하면 됩니다.
- 이메일 발송량이 많아지면(무료 티어 월 3,000통 초과) Resend 유료 플랜으로 전환하면 됩니다.
- `shouldSuggestPlanner` 판단 기준(방문 3회 또는 활동 3일)은 `server.js`의 `/api/stats` 안에 있는
  한 줄이라 나중에 조건을 얼마든지 정교하게 바꿀 수 있어요.
