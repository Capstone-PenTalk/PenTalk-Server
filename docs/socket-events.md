# Socket 이벤트 문서

## 공통 규칙

### 인증
- Socket 연결 시 `socket.handshake.auth.token`으로 JWT 전달
- 서버는 토큰 검증 후 다음 값을 세팅한다:
  - `socket.data.userId`
  - `socket.data.role`
- `socket.data.classId`는 **join-room 성공 시점**에 설정된다.
- `userId`, `role`은 JWT에서 추출하므로 이벤트 payload에 포함하지 않는다.

---

## 공통 에러 이벤트

### Event
- `server_error`

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
- `INTERNAL_ERROR`

---

## join_room

### Client -> Server
- Event: `join_room`
- Payload:
```json
{
  "roomId": "sessionId",
  "classId": "c1"
}
```
- `userId`, `role`은 JWT에서 자동 추출되므로 payload에 포함하지 않는다.

### Server 동작
1. roomId 누락 시 에러
2. 세션 존재 여부 검증
3. classId 불일치 시 에러
4. 성공 시 `socket.join(roomId)`
5. `socket.data.roomId`, `socket.data.classId` 설정

### Success (Server -> Client)
- Event: `join_success`
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
- `CLASS_MISMATCH`

---

## teacher_send_dm

### Client -> Server
- Auth: teacher only
- Event: `teacher_send_dm`
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

## receive_dm

### Server -> Client (room broadcast, sender 제외)
- Event: `receive_dm`
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

## send_message

### Client -> Server
- Event: `send_message`
- Payload:
```json
{
  "message": "hello"
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

## receive_message

### Server -> Client (room broadcast, sender 제외)
- Event: `receive_message`
- Payload:
```json
{
  "message": "hello",
  "sender": {
    "userId": "u1",
    "role": "student"
  },
  "ts": 1706745600000
}
```

---

## draw:append (판서 스트리밍)

### 개요
실시간 판서 데이터(획 시작/스트리밍/종료)를 room 내 클라이언트에 브로드캐스트한다.
`e` 필드로 이벤트 타입을 구분한다.

### 이벤트 타입

| e | 설명 | 필수 필드 |
|---|------|----------|
| `ds` | draw_start - 획 시작 | `sId`, `x`, `y`, `c`, `w` |
| `dm` | draw_stream - 좌표 스트리밍 | `sId`, `x`, `y` |
| `de` | draw_end - 획 종료 | `sId`, (선택) `pts` |

### Client -> Server

- Event: `draw:append`
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
- `x`, `y`: number - 정규화 좌표 (0.0 ~ 1.0)
- `c`: string - 색상 (`#RRGGBB` hex 형식, 예: `#FF0000`)
- `w`: number - 선 굵기 (0 초과)

#### dm (draw_stream)
```json
{
  "e": "dm",
  "sId": 1706745600000,
  "x": 0.52,
  "y": 0.35,
  "p": 0.85
}
```
- 고빈도 이벤트. 검증 실패 시 에러 없이 drop한다.
- `x`, `y`: 0.0 ~ 1.0 범위
- `p`: (선택) number - 필압 (0.0 ~ 1.0)

#### de (draw_end)
```json
{
  "e": "de",
  "sId": 1706745600000,
  "pts": [
    {"x": 0.1234, "y": 0.5678},
    {"x": 0.1567, "y": 0.6001},
    {"x": 0.2012, "y": 0.5823}
  ]
}
```
- `pts`: (선택) 알고리즘으로 추출된 핵심 제어점 배열. 전송 시 Array 타입이어야 한다.

### Server -> Client (room broadcast, sender 제외)

- Event: `draw:append`
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
- `dm`: sId, x, y 타입 + 범위 검증, p는 존재 시만 검증. 실패 시 **에러 없이 drop** (고빈도 보호).
- `de`: sId 필수, pts 전송 시 Array 타입 검증. 실패 시 `PAYLOAD_INVALID` 에러.

### Errors
- `NOT_JOINED`
- `PAYLOAD_INVALID`
- `ROOM_MISMATCH`

---

## draw:clear (판서 제어)

### 개요
획 지우기(eraser) 및 실행취소(undo)를 처리한다.
`e` 필드로 제어 타입을 구분한다.

### 이벤트 타입

| e | 설명 |
|---|------|
| `un` | undo - 특정 획 되돌리기 |
| `er` | eraser - 특정 획 지우기 |

### Client -> Server

- Event: `draw:clear`
- 조건: join된 상태에서만 전송 가능

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

- `sId`: number - 삭제할 획의 고유 ID

### Server 동작
1. join 여부 검증
2. `e` 타입 및 `sId` 검증
3. room 내 브로드캐스트 (sender 제외)
4. Redis whiteboard에서 해당 sId 삭제

### Server -> Client (room broadcast, sender 제외)

- Event: `draw:clear`
```json
{
  "e": "un",
  "sId": 1706745600000,
  "senderUserId": "u1",
  "t": 43,
  "ts": 1706745600000
}
```

### Errors
- `NOT_JOINED`
- `PAYLOAD_INVALID`

---

## sync:request / sync:state (판서 상태 복구)

### 개요
재접속 또는 중간 입장 시 클라이언트가 명시적으로 현재 판서 상태를 요청한다.

### Client -> Server
- Event: `sync:request`
- Payload: 없음
- 조건: join된 상태에서만 전송 가능

### Server -> Client (요청자에게만)
- Event: `sync:state`
```json
{
  "strokes": [
    {
      "sId": 1706745600000,
      "x": 0.1,
      "y": 0.2,
      "c": "#FF0000",
      "w": 3,
      "pts": [
        {"x": 0.1, "y": 0.2},
        {"x": 0.15, "y": 0.25}
      ]
    }
  ]
}
```

- `strokes`: 현재 room의 완성된 stroke 목록 (빈 배열이면 신규 입장)
- 각 stroke는 `de` 수신 시 저장된 최종 상태 (dm 중간 좌표 제외)
- `un`/`er`로 삭제된 stroke는 포함되지 않음

### 저장 구조
- Redis Hash: `whiteboard:{sessionId}`
- field: strokeId(string), value: stroke JSON
- TTL: 세션과 동일 (`SESSION_TTL_SECONDS`)

### 클라이언트 처리 순서
1. `join_success` 수신
2. `sync:request` 전송
3. `sync:state` 수신 → 캔버스 초기화 후 strokes 전체 렌더링
4. 이후 `draw:append` / `draw:clear` 실시간 이벤트 적용

### Errors
- `NOT_JOINED`
- `INTERNAL_ERROR`

---

## Flutter ↔ Native MethodChannel 인터페이스

### Channel Name
`pentalk/drawing`

### Flutter → Native (`sendDrawEvent`)
Flutter에서 터치 이벤트 발생 시 Native로 소켓 전송을 요청한다.
Native는 수신한 Map 데이터를 그대로 소켓 서버로 전송한다.

- **대상 이벤트:** `draw:append` (ds/dm/de), `draw:clear` (un/er) 공통 사용

```dart
// 예시
channel.invokeMethod('sendDrawEvent', {
  "e": "ds",
  "sId": 1706745600000,
  "x": 0.5,
  "y": 0.3,
  "c": "#FF0000",
  "w": 2.5,
});
```

### Native → Flutter (`onDrawEvent`)
소켓 서버로부터 다른 사용자의 판서 데이터를 수신했을 때 Flutter 화면에 전달한다.

```dart
// Native가 호출, Flutter에서 처리
channel.setMethodCallHandler((call) async {
  if (call.method == 'onDrawEvent') {
    final data = call.arguments as Map<String, dynamic>;
    // 캔버스 렌더링 처리
  }
});
```

### 좌표계 규칙
- `x`, `y`: 디바이스 해상도 무관, **0.0 ~ 1.0 정규화 값**으로 송수신
- Native에서 별도 좌표 변환 불필요

### 색상 규칙
- `c`: `#RRGGBB` 형식의 Hex String (예: `#FF0000`)
