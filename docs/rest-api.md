# REST API 문서

## 공통 규칙

### Base URL
- 개발: `http://localhost:4000`

### 인증
일부 엔드포인트는 JWT 토큰이 필요합니다. `POST /auth/dev-login`으로 토큰을 발급받아 헤더에 포함합니다.

```
Authorization: Bearer <token>
```

### Error Response (통일 포맷)
```json
{
  "code": "ERROR_CODE",
  "message": "ERROR_MESSAGE"
}
```

---

## POST /auth/dev-login

### 목적
개발 환경에서 teacher / student JWT 토큰을 발급한다.

### Request Body
```json
{
  "userId": "u1",
  "role": "teacher"
}
```

### Response 200
```json
{
  "token": "JWT_TOKEN",
  "user": {
    "userId": "u1",
    "role": "teacher"
  }
}
```

### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_INPUT |

---

## POST /session/create

### 목적
새 세션을 생성하고 교사용/학생용 접속 URL을 반환한다.

### Request Body
```json
{
  "classId": "c1"
}
```

### Response 200
```json
{
  "sessionId": "uuid",
  "joinUrlTeacher": "http://localhost:4000/?sessionId=uuid",
  "joinUrlStudent": "http://localhost:4000/?sessionId=uuid"
}
```

### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | MISSING_CLASS_ID |

---

## GET /materials

### 목적
반(class) 기준으로 수업 자료(Material)를 조회한다.
과목(subject) 및 키워드(keyword) 필터를 선택적으로 적용할 수 있다.

> **인증 필요** — `Authorization: Bearer <token>` 헤더 필수
> 토큰의 userId가 해당 class의 ClassMember에 존재해야 한다.

### Query Parameters

| 이름 | 필수 | 설명 |
|------|------|------|
| classId | O | 반(Class) ID |
| subjectId | X | 과목(Subject) ID |
| keyword | X | 검색 키워드 (type, url 기준 부분 검색) |

### Request 예시
```
GET /materials?classId=CLASS_ID
GET /materials?classId=CLASS_ID&subjectId=SUBJECT_ID
GET /materials?classId=CLASS_ID&keyword=pdf
GET /materials?classId=CLASS_ID&subjectId=SUBJECT_ID&keyword=sample
```

### Response 200
```json
{
  "items": [
    {
      "id": "cml4sj7qd0001uvupaz8w2cnd",
      "type": "pdf",
      "url": "https://example.com/sample.pdf",
      "classId": "cml3irfbx0002uvtjvazqiv3z",
      "createdAt": "2026-02-02T06:30:29.605Z",
      "subjects": [
        {
          "id": "b3cb5b75-4655-4be9-b1b5-fb051464b4e9",
          "name": "Math"
        }
      ]
    }
  ],
  "count": 1
}
```

- `items`: 조건에 맞는 material 목록 (최대 50개, 최신순)
- `count`: 반환된 결과 개수
- `subjects`: material에 연결된 과목 목록

### Errors
| HTTP | code | message | 설명 |
|------|------|---------|------|
| 400 | PAYLOAD_INVALID | MISSING_CLASS_ID | classId 누락 |
| 401 | UNAUTHORIZED | MISSING_TOKEN | Authorization 헤더 없음 |
| 401 | UNAUTHORIZED | INVALID_TOKEN | 토큰 검증 실패 |
| 401 | UNAUTHORIZED | INVALID_TOKEN_PAYLOAD | 토큰 payload 이상 |
| 403 | FORBIDDEN | NOT_CLASS_MEMBER | 해당 반의 멤버가 아님 |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR | 서버 오류 |

### Performance Note
- `(classId, createdAt)` 복합 인덱스로 반별 최신순 조회 최적화
- `MaterialSubject(subjectId, materialId)` 인덱스로 과목 필터 최적화
- EXPLAIN ANALYZE 기준 실행 시간 약 0.3ms
