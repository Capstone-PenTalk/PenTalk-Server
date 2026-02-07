# REST API 문서

## 공통 규칙

### Base URL
- 개발: `http://localhost:4000`

### Error Response (통일 포맷)
```json
{
  "code": "PAYLOAD_INVALID",
  "message": "MISSING_CLASS_ID"
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

📄 GET /materials — 수업 자료 조회 (검색/필터링)

반(class) 기준으로 수업 자료(Material)를 조회한다.
과목(subject) 및 키워드(keyword) 필터를 선택적으로 적용할 수 있다.

✅ Request
GET /materials?classId=&subjectId=&keyword=

Query Parameters
이름	필수	설명
classId	O	반(Class) ID
subjectId	X	과목(Subject) ID
keyword	X	검색 키워드 (type, url 기준 부분 검색)

classId가 없을 경우 요청은 거부된다.

✅ Response (200 OK)
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


items: 조건에 맞는 material 목록

count: 전체 결과 개수

subjects: material에 연결된 과목 목록 (태그 형태로 프론트 사용 가능)

❌ Error Responses
400 Bad Request — classId 누락
{
  "code": "MISSING_CLASS_ID",
  "message": "classId is required",
  "items": [],
  "count": 0
}

500 Internal Server Error
{
  "code": "INTERNAL_ERROR",
  "message": "failed to fetch materials"
}

🔍 필터 조합 예시
# classId 기준 조회
GET /materials?classId=CLASS_ID

# classId + subjectId
GET /materials?classId=CLASS_ID&subjectId=SUBJECT_ID

# classId + keyword
GET /materials?classId=CLASS_ID&keyword=pdf

# classId + subjectId + keyword
GET /materials?classId=CLASS_ID&subjectId=SUBJECT_ID&keyword=sample

⚙️ Performance Note

classId 기준 조회는 ("classId","createdAt") 복합 인덱스를 사용

subjectId 필터는 MaterialSubject(subjectId, materialId) 인덱스를 사용

EXPLAIN ANALYZE 기준 실행 시간은 약 0.3ms로 확인됨