# PenTalk Server

비대면/대면 수업 환경에서  
**교사의 실시간 판서를 학생 기기에 동기화하고,  
학생 필기와 함께 PDF로 저장할 수 있는 수업 플랫폼 _PenTalk_ 의 백엔드 서버입니다.**

---

## ✨ 주요 기능

### 🖊 실시간 판서 시스템
- Socket.IO 기반 획 단위 스트리밍 (`draw:append`, `draw:clear`)
- 다수 사용자 환경에서도 **저지연 동기화**

### 🔄 상태 복구
- Redis 기반 Whiteboard 상태 저장
- 재접속 시 `sync:request`로 **자동 복구**

### 💬 교사 DM (공지/메시지)
- Redis Pub/Sub 기반 브로드캐스트
- 멀티 서버 환경에서도 안정적인 메시지 전달

### 📚 수업 관리
- Material / Subject / Tag CRUD REST API 제공
- 수업 자료 구조화 및 관리

### 📄 PDF Export
- 원본 PDF + 교사 판서 + 학생 필기 합성
- `application/pdf` 바이너리 응답

### 🔐 인증
- JWT 기반 인증
- Socket 연결 및 HTTP API 모두 토큰 검증 지원

---

## 🛠 기술 스택

| 구분 | 기술 |
|------|------|
| Runtime | Node.js |
| Framework | Express 5 |
| Realtime | Socket.IO 4 |
| Database | PostgreSQL + Prisma 6 |
| Cache / Pub-Sub | Redis (ioredis) |
| Auth | JWT |
| PDF | pdf-lib |

---

## ⚡ 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.example .env

# 3. DB 마이그레이션
npx prisma migrate dev

# 4. Redis 실행
docker run -d -p 6379:6379 redis

# 5. 개발 서버 실행
npm run dev
```

👉 서버 실행 주소  
```
http://localhost:3000
```

---

## 🔑 환경 변수 (.env)

```env
PORT=3000
JWT_SECRET=dev-secret-change-me
DATABASE_URL="postgresql://pentalk:pentalk123@localhost:5432/pentalk_dev?schema=public"
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=http://localhost:5173
```

---

## 📚 문서

| 문서 | 설명 |
|------|------|
| [DEVELOP.md](./DEVELOP.md) | 개발 환경 설정, 아키텍처, Redis 구조 |
| [docs/socket-events.md](./docs/socket-events.md) | Socket 이벤트 명세 (판서, DM, 상태복구 등) |
| [docs/rest-api.md](./docs/rest-api.md) | REST API 명세 |
| [docs/erd.md](./docs/erd.md) | DB ERD 및 관계/제약 |
| [docs/redis-pubsub-risk.md](./docs/redis-pubsub-risk.md) | Redis Pub/Sub 리스크 분석 및 대응 전략 |

---

## 📁 프로젝트 구조

```
src/
├── server.js        # 서버 진입점
├── lib/             # Redis 클라이언트
├── store/           # 세션 저장소
├── utils/           # JWT, 로거, HTTP 에러 처리

config/              # 이벤트명, 라우트, 에러 코드 상수
prisma/              # DB 스키마 및 마이그레이션
docs/                # API 및 설계 문서
scripts/             # 개발용 유틸 스크립트
```

---

## 🎯 핵심 설계 포인트

- **저지연 실시간 동기화 (Socket.IO 기반 이벤트 스트리밍)**
- **Redis를 활용한 판서 상태 저장 및 복구 구조**
- **Pub/Sub 기반 멀티 서버 확장 대응**
- **tick 기반 이벤트 순서 보장으로 데이터 일관성 유지**
- **세션 단위 TTL 관리로 메모리 효율성 확보**

---

## 🧩 향후 개선 방향

- 판서 데이터 payload 최적화 (전송량 감소 및 렌더링 성능 개선)
- Redis 장애 대응을 위한 fallback 및 데이터 영속화 전략 보완
- 동시 접속자 증가 상황에서의 성능 테스트 및 병목 구간 개선
- PDF 생성 로직의 비동기 처리 및 성능 개선
- 서버 로그 및 모니터링 체계 강화 (에러 추적 및 운영 안정성 확보)
