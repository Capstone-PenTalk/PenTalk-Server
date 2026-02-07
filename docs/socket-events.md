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
