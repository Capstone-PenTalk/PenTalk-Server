# Socket 이벤트 문서

## 공통 규칙

### 인증
- Socket 연결 시 `socket.handshake.auth.token`으로 JWT 전달
- 서버는 토큰 검증 후 다음 값을 세팅한다:
  - `socket.data.userId`
  - `socket.data.role`
- `socket.data.classId`는 **join-room 성공 시점**에 설정된다.

---

## 공통 에러 이벤트

### Event
- `server-error`

### Payload
```json
{
  "code": "SESSION_NOT_FOUND",
  "message": "optional message"
}
```

### 사용되는 에러 코드
- `UNAUTHORIZED`
- `FORBIDDEN`
- `MISSING_ROOM_ID`
- `SESSION_NOT_FOUND`
- `NOT_JOINED`
- `INVALID_MESSAGE`
- `MESSAGE_TOO_LONG`
- `PAYLOAD_INVALID`
- `DM_PUBLISH_FAILED`

---

## join-room

### Client -> Server
- Event: `join-room`
- Payload:
```json
{
  "roomId": "sessionId"
}
```

### Server 동작
1. roomId 누락 시 에러
2. 세션 존재 여부 검증
3. 성공 시 `socket.join(roomId)`
4. `socket.data.roomId`, `socket.data.classId` 설정

### Success (Server -> Client)
- Event: `join-success`
- Payload:
```json
{
  "roomId": "sessionId",
  "classId": "c1",
  "user": {
    "userId": "u1",
    "role": "teacher"
  }
}
```

### Errors
- `MISSING_ROOM_ID`
- `SESSION_NOT_FOUND`

---

## teacher-send-dm

### Client -> Server
- Auth: teacher only
- Event: `teacher-send-dm`
- Payload:
```json
{
  "message": "hello"
}
```

### Server 동작
1. teacher role만 허용
2. join 여부 검증
3. 세션 유효성 확인
4. 메시지 유효성 검사 (빈 값, 타입, 길이 300자 제한)
5. Redis channel `dm-channel:{sessionId}` publish

### Errors
- `FORBIDDEN`
- `NOT_JOINED`
- `SESSION_NOT_FOUND`
- `INVALID_MESSAGE`
- `MESSAGE_TOO_LONG`
- `DM_PUBLISH_FAILED`

---

## receive-dm

### Server -> Client (room broadcast, sender 제외)
- Event: `receive-dm`
- Payload:
```json
{
  "from": "teacher",
  "message": "hello",
  "ts": 1706745600000,
  "senderSocketId": "socketId",
  "senderUserId": "u1"
}
```

---

## send-message

### Client -> Server
- Event: `send-message`
- Payload:
```json
{
  "msg": "hello"
}
```

### Server 동작
1. 메시지 유효성 검사 (`isValidMessage`)
2. join 여부 확인
3. 세션 유효성 확인
4. 같은 room으로 브로드캐스트 (sender 제외)

### Errors
- `PAYLOAD_INVALID`
- `NOT_JOINED`
- `SESSION_NOT_FOUND`

---

## receive-message

### Server -> Client (room broadcast, sender 제외)
- Event: `receive-message`
- Payload:
```json
{
  "msg": "hello",
  "sender": {
    "userId": "u1",
    "role": "student"
  },
  "ts": 1706745600000
}
```

---

## draw_event (판서 스트리밍)

### 개요
실시간 판서 데이터를 room 내 클라이언트에 브로드캐스트한다.
모든 draw 이벤트는 `draw_event` 이름으로 송수신하며, `e` 필드로 이벤트 타입을 구분한다.

### 이벤트 타입

| e | 설명 | 필수 필드 |
|---|------|----------|
| `ds` | draw_start - 획 시작 | `sId`, `x`, `y`, `c`, `w` |
| `dm` | draw_stream - 좌표 스트리밍 | `sId`, `x`, `y` |
| `de` | draw_end - 획 종료 | `sId`, (선택) `pts` |
| `un` | undo - 획 되돌리기 | `sId` |
| `er` | eraser - 획 지우기 | `sId` |

### Client -> Server

- Event: `draw_event`
- 조건: join된 상태에서만 전송 가능

#### ds (draw_start)
```json
{
  "e": "ds",
  "sId": 1706745600000,
  "x": 0.5,
  "y": 0.3,
  "c": "#FF0000",
  "w": 2.5
}
```
- `sId`: number - strokeId (타임스탬프 등 고유 값)
- `x`, `y`: number - 정규화 좌표 (0~1 범위)
- `c`: string - 색상 (hex 등)
- `w`: number - 선 굵기 (0 초과)

#### dm (draw_stream)
```json
{
  "e": "dm",
  "sId": 1706745600000,
  "x": 0.52,
  "y": 0.35
}
```
- 고빈도 이벤트. 검증 실패 시 에러 없이 drop한다.
- `x`, `y`: 0~1 범위

#### de (draw_end)
```json
{
  "e": "de",
  "sId": 1706745600000,
  "pts": [{"x":0.5,"y":0.3},{"x":0.52,"y":0.35}]
}
```
- `pts`: (선택) 전체 좌표 배열. 전송 시 Array 타입이어야 한다.

#### un (undo)
```json
{
  "e": "un",
  "sId": 1706745600000
}
```

#### er (eraser)
```json
{
  "e": "er",
  "sId": 1706745600000
}
```

### Server -> Client (room broadcast, sender 제외)

- Event: `draw_event`
- 서버가 추가하는 필드:

```json
{
  "...payload",
  "senderUserId": "u1",
  "senderRole": "teacher",
  "t": 42,
  "ts": 1706745600000
}
```

- `t`: number - room별 단조 증가 tick. 클라이언트는 이 값으로 이벤트 순서를 보장할 수 있다.
  - 서버에서 부여하므로 클라이언트 간 시계 차이에 영향받지 않는다.
  - room의 모든 소켓이 disconnect되면 tick은 초기화된다.

### Validation 정책
- `ds`: 모든 필수 필드 + 좌표 범위 검증. 실패 시 `PAYLOAD_INVALID` 에러.
- `dm`: sId, x, y 타입 + 범위 검증. 실패 시 **에러 없이 drop** (고빈도 보호).
- `de`: sId 필수, pts 전송 시 Array 타입 검증. 실패 시 `PAYLOAD_INVALID` 에러.
- `un`, `er`: sId 필수. 실패 시 `PAYLOAD_INVALID` 에러.

### Errors
- `NOT_JOINED` - room 미참여
- `PAYLOAD_INVALID` - 잘못된 payload
- `ROOM_MISMATCH` - payload.r이 현재 room과 불일치
