# PenTalk Backend — 개발 가이드

## 목차
- [프로젝트 개요](#프로젝트-개요)
- [기술 스택](#기술-스택)
- [디렉토리 구조](#디렉토리-구조)
- [환경 설정](#환경-설정)
- [로컬 실행](#로컬-실행)
- [아키텍처 개요](#아키텍처-개요)
- [Redis 사용 구조](#redis-사용-구조)
- [Socket.IO 구조](#socketio-구조)
- [JWT 인증 흐름](#jwt-인증-흐름)
- [개발용 스크립트](#개발용-스크립트)
- [관련 문서](#관련-문서)

---

## 프로젝트 개요

PenTalk 실시간 수업 플랫폼의 백엔드 서버.

- REST API: 세션/수업자료/과목/태그 관리
- Socket.IO: 실시간 판서 스트리밍, 채팅, DM
- Redis: 세션 저장, 판서 상태(Whiteboard) 저장, Pub/Sub DM

---

## 기술 스택

| 분류 | 기술 |
|------|------|
| Runtime | Node.js |
| Framework | Express 5 |
| 실시간 통신 | Socket.IO 4 |
| DB ORM | Prisma 6 |
| DB | PostgreSQL |
| Cache / 메시지 브로커 | Redis (ioredis) |
| 인증 | JWT (jsonwebtoken) |
| 개발 서버 | nodemon |

---

## 디렉토리 구조

```
pentalk-backend/
├── src/
│   ├── server.js          # 앱 진입점 (Express + Socket.IO)
│   ├── lib/
│   │   ├── redis.js        # Redis 일반 클라이언트
│   │   └── redisPubSub.js  # Redis Pub/Sub 전용 클라이언트 (pub/sub 분리)
│   ├── store/
│   │   └── sessionStore.js # 세션 CRUD (Redis 기반)
│   ├── utils/
│   │   ├── jwt.js          # 토큰 서명/검증
│   │   ├── logger.js       # 로거
│   │   └── httpError.js    # HTTP 에러 응답 헬퍼
│   └── config/
│       └── errors.js       # 에러 코드 상수
├── config/
│   ├── appConfig.js        # 서버 설정 (PORT, CORS, TTL 등)
│   ├── socket.events.js    # Socket 이벤트명 상수
│   ├── routes.js           # REST 라우트 경로 상수
│   └── errors.js           # 에러 코드 상수 (공용)
├── prisma/
│   ├── schema.prisma       # DB 스키마
│   ├── seed.js             # 시드 데이터
│   └── migrations/         # 마이그레이션 파일
├── scripts/                # 개발용 유틸 스크립트
├── docs/                   # 문서
└── .env                    # 환경 변수 (git 제외)
```

---

## 환경 설정

`.env` 파일을 프로젝트 루트에 생성한다.

```env
# 서버
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173

# JWT
JWT_SECRET=dev-secret-change-me
JWT_EXPIRES_IN=7d

# PostgreSQL
POSTGRES_USER=pentalk
POSTGRES_PASSWORD=pentalk123
POSTGRES_DB=pentalk_dev
DATABASE_URL="postgresql://pentalk:pentalk123@localhost:5432/pentalk_dev?schema=public"

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
# 또는 REDIS_URL=redis://localhost:6379 (REDIS_URL 우선 적용)

# 세션 TTL (초, 기본 21600 = 6시간)
SESSION_TTL_SECONDS=21600

# 클라이언트 Origin (세션 생성 시 joinUrl 생성에 사용)
CLIENT_ORIGIN=http://localhost:5173
```

---

## 로컬 실행

### 1. 의존성 설치
```bash
npm install
```

PDF 업로드 시 서버 사이드 페이지 래스터화(pdftoppm)를 위해 `poppler-utils`가 필요합니다. Docker로 실행 시 이미지에 자동 설치되어 있으니 별도 조치가 필요 없고, 로컬에서 직접 `node src/server.js`로 실행하는 경우에만 아래처럼 설치하세요.
```bash
sudo apt-get install -y poppler-utils
```

### 2. PostgreSQL 실행 및 DB 마이그레이션
```bash
# DB 마이그레이션 적용
npx prisma migrate dev

# (선택) Prisma Studio로 DB 확인
npx prisma studio
```

### 3. Redis 실행
```bash
# Docker 사용 시
docker run -d -p 6379:6379 redis
```

### 4. 서버 실행
```bash
# 개발 (nodemon, 파일 변경 시 자동 재시작)
npm run dev

# 프로덕션
npm start
```

서버 기본 포트: `http://localhost:3000`

---

## 아키텍처 개요

```
Flutter App
    │
    ├── REST API (HTTP)
    │       └── Express Router → Prisma → PostgreSQL
    │
    └── Socket.IO (WebSocket)
            │
            ├── JWT 미들웨어 (연결 시 토큰 검증)
            ├── join_room → Redis Session 조회 → Room 입장
            ├── draw:append → Room 브로드캐스트 + Redis Whiteboard 저장
            ├── draw:clear  → Room 브로드캐스트 + Redis Whiteboard 삭제
            ├── sync:request → Redis Whiteboard 조회 → sync:state 응답
            └── teacher_send_dm → Redis Pub/Sub → Room 브로드캐스트
```

---

## Redis 사용 구조

Redis 클라이언트는 용도별로 3개 인스턴스를 사용한다.

| 인스턴스 | 파일 | 용도 |
|----------|------|------|
| `redis` | `src/lib/redis.js` | 세션 저장, Whiteboard 저장 |
| `pubClient` | `src/lib/redisPubSub.js` | DM 메시지 발행(publish) |
| `subClient` | `src/lib/redisPubSub.js` | DM 메시지 구독(subscribe) |

> Pub/Sub 전용 클라이언트를 분리하는 이유: `subscribe` 상태의 Redis 연결은 일반 커맨드를 실행할 수 없기 때문.

### Key 구조

| Key | 타입 | TTL | 설명 |
|-----|------|-----|------|
| `session:{sessionId}` | String (JSON) | `SESSION_TTL_SECONDS` | 세션 메타데이터 |
| `whiteboard:{sessionId}` | Hash | `SESSION_TTL_SECONDS` | 판서 stroke 목록 (field: sId, value: stroke JSON) |
| `dm-channel:{sessionId}` | Pub/Sub channel | — | 교사 DM 브로드캐스트 |

---

## Socket.IO 구조

### Room 구조
- Room 이름: `session:{sessionId}`
- `join_room` 이벤트 수신 시 `socket.join(roomName)` 실행
- 브로드캐스트는 항상 `socket.to(currentRoom)` 으로 발신자 제외 전송

### 인메모리 상태

서버 프로세스 내에 유지되는 인메모리 상태 (재시작 시 초기화):

| 변수 | 타입 | 설명 |
|------|------|------|
| `pendingStrokes` | `Map<sessionId, Map<sId, dsData>>` | `ds` → `de` 완성 전 임시 저장 |
| `roomDrawTick` | `Map<roomName, number>` | 이벤트 순서 보장용 단조 증가 tick |

> `pendingStrokes`: `ds` 이벤트의 색상/굵기 등 속성을 보관했다가, `de` 수신 시 병합하여 Redis에 최종 저장.
> `roomDrawTick`: room의 모든 소켓이 disconnect되면 초기화됨.

### 이벤트 목록
→ [docs/socket-events.md](./docs/socket-events.md) 참조

---

## JWT 인증 흐름

### Socket 연결
1. Flutter가 `socket.handshake.auth.token`에 JWT 포함하여 연결
2. 서버 미들웨어에서 토큰 검증 → `socket.data.userId`, `socket.data.role` 저장
3. 검증 실패 시 연결 거부 (`UNAUTHORIZED`)

### HTTP API
1. `POST /auth/dev-login`으로 `{ userId, role }` 전달 → JWT 발급
2. 이후 요청 헤더에 `Authorization: Bearer <token>` 포함
3. `requireAuth` 미들웨어에서 검증 → `req.userId`, `req.role` 저장

> `POST /auth/dev-login`은 개발 전용 엔드포인트. 프로덕션에서는 실제 인증 시스템으로 대체 필요.

---

## 개발용 스크립트

```bash
# JWT 토큰 생성 (teacher-test 유저)
node scripts/genToken.js

# DB smoke test (User/Class/Material 더미 데이터 삽입)
node scripts/db-smoke.js

# 학생 유저 삽입
node scripts/insert-student.js

# 토큰 출력
node scripts/printToken.js

# 다중 인스턴스 테스트
node scripts/multi-instance-test.js

# Whiteboard snapshot 테스트
node scripts/snapshot-test.js
```

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [docs/socket-events.md](./docs/socket-events.md) | Socket 이벤트 명세 (판서, 채팅, DM, 상태복구) |
| [docs/rest-api.md](./docs/rest-api.md) | REST API 명세 |
| [docs/erd.md](./docs/erd.md) | DB ERD 및 관계/제약 설명 |
| [docs/redis-pubsub-risk.md](./docs/redis-pubsub-risk.md) | Redis Pub/Sub 다중 서버 이슈 분석 |
