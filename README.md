# PenTalk Server

실시간 판서 수업 플랫폼 **PenTalk**의 백엔드 서버.

---

## 주요 기능

- **실시간 판서 동기화** — Socket.IO 기반 획 스트리밍 (draw:append / draw:clear)
- **판서 상태 복구** — Redis Whiteboard 저장, 재접속 시 sync:request로 복원
- **교사 DM** — Redis Pub/Sub 기반 다중 서버 대응 메시지 브로드캐스트
- **세션 관리** — UUID 기반 세션 생성, Redis TTL 관리
- **수업자료 관리** — Material / Subject / Tag CRUD REST API
- **JWT 인증** — Socket 연결 및 HTTP API 토큰 검증

---

## 기술 스택

| | |
|---|---|
| Runtime | Node.js |
| Framework | Express 5 |
| 실시간 통신 | Socket.IO 4 |
| DB | PostgreSQL + Prisma 6 |
| Cache / Pub-Sub | Redis (ioredis) |
| 인증 | JWT |

---

## 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.example .env  # 없으면 아래 참고

# 3. DB 마이그레이션
npx prisma migrate dev

# 4. Redis 실행 (Docker)
docker run -d -p 6379:6379 redis

# 5. 개발 서버 실행
npm run dev
```

서버: `http://localhost:3000`

### 최소 `.env` 설정

```env
PORT=3000
JWT_SECRET=dev-secret-change-me
DATABASE_URL="postgresql://pentalk:pentalk123@localhost:5432/pentalk_dev?schema=public"
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=http://localhost:5173
```

---

## 문서

| 문서 | 설명 |
|------|------|
| [DEVELOP.md](./DEVELOP.md) | 개발 환경 설정, 아키텍처, Redis 구조, 스크립트 |
| [docs/socket-events.md](./docs/socket-events.md) | Socket 이벤트 명세 (판서, 채팅, DM, 상태복구) |
| [docs/rest-api.md](./docs/rest-api.md) | REST API 명세 |
| [docs/erd.md](./docs/erd.md) | DB ERD 및 관계/제약 설명 |

---

## 프로젝트 구조

```
src/
├── server.js          # 앱 진입점
├── lib/               # Redis 클라이언트
├── store/             # 세션 저장소
├── utils/             # JWT, 로거, HTTP 에러
config/                # 이벤트명, 라우트, 에러 코드 상수
prisma/                # DB 스키마 및 마이그레이션
docs/                  # API 문서
scripts/               # 개발용 유틸 스크립트
```
