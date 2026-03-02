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

## 목차

- [POST /auth/dev-login](#post-authdev-login)
- [POST /session/create](#post-sessioncreate)
- [Subject API](#subject-api)
- [GET /materials](#get-materials)
- [Tag API](#tag-api)
- [Material-Subject 연결 API](#material-subject-연결-api)
- [Material-Tag 연결 API](#material-tag-연결-api)

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
- `role`: `"teacher"` 또는 `"student"`만 허용

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
  "classId": "c1",
  "materialId": "m1"
}
```
- `classId`: 필수. DB에 존재하는 class ID여야 한다.
- `materialId`: 선택. 지정 시 해당 material이 존재하고 classId와 일치해야 한다.

### Response 200
```json
{
  "sessionId": "uuid",
  "materialId": "m1",
  "joinUrlTeacher": "http://localhost:5173/?sessionId=uuid&role=teacher",
  "joinUrlStudent": "http://localhost:5173/?sessionId=uuid&role=student",
  "ttlSeconds": 21600
}
```
- `materialId`: 세션에 연결된 material ID. 지정하지 않은 경우 `null`
- `ttlSeconds`: 세션 유효 시간 (초). 기본값 21600 (6시간)

### Errors
| HTTP | code | message | 설명 |
|------|------|---------|------|
| 400 | PAYLOAD_INVALID | MISSING_CLASS_ID | classId 누락 |
| 404 | CLASS_NOT_FOUND | CLASS_NOT_FOUND | 존재하지 않는 class |
| 404 | MATERIAL_NOT_FOUND | MATERIAL_NOT_FOUND | 존재하지 않는 material |
| 400 | MATERIAL_CLASS_MISMATCH | MATERIAL_CLASS_MISMATCH | material의 classId 불일치 |

---

## Subject API

> **인증 불필요** — 전체 엔드포인트 인증 없이 접근 가능

### 설계 결정 사항
Subject는 **과목(교육과정 단위)** 태그로, Material에 연결된다 (Class 연결 없음).

---

### POST /subjects

#### 목적
새 과목을 생성한다.

#### Request Body
```json
{ "name": "수학" }
```

#### Response 201
```json
{ "id": "SUBJECT_ID", "name": "수학", "createdAt": "..." }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_SUBJECT_NAME |
| 409 | PAYLOAD_INVALID | DUPLICATE_SUBJECT |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### GET /subjects

#### 목적
전체 과목 목록을 이름 오름차순으로 반환한다.

#### Response 200
```json
[
  { "id": "SUBJECT_ID", "name": "수학", "createdAt": "..." }
]
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### GET /subjects/:subjectId

#### Response 200
```json
{ "id": "SUBJECT_ID", "name": "수학", "createdAt": "..." }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 404 | PAYLOAD_INVALID | SUBJECT_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### PUT /subjects/:subjectId

#### Request Body
```json
{ "name": "과학" }
```

#### Response 200
```json
{ "id": "SUBJECT_ID", "name": "과학", "createdAt": "..." }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_SUBJECT_NAME |
| 404 | PAYLOAD_INVALID | SUBJECT_NOT_FOUND |
| 409 | PAYLOAD_INVALID | DUPLICATE_SUBJECT |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### DELETE /subjects/:subjectId

#### Response 200
```json
{ "ok": true, "subjectId": "SUBJECT_ID" }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 404 | PAYLOAD_INVALID | SUBJECT_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

## GET /materials

### 목적
반(class) 기준으로 수업 자료(Material)를 조회한다.
과목(subject), 태그(tag), 키워드(keyword) 필터를 선택적으로 적용할 수 있다.

> **인증 필요** — `Authorization: Bearer <token>` 헤더 필수
> 토큰의 userId가 해당 class의 ClassMember에 존재해야 한다.

### Query Parameters

| 이름 | 필수 | 설명 |
|------|------|------|
| classId | O | 반(Class) ID |
| subjectId | X | 과목(Subject) ID |
| tagId | X | 태그(Tag) ID |
| keyword | X | 검색 키워드 (type, url 기준 부분 검색, 최소 2자) |

### Request 예시
```
GET /materials?classId=CLASS_ID
GET /materials?classId=CLASS_ID&subjectId=SUBJECT_ID
GET /materials?classId=CLASS_ID&tagId=TAG_ID
GET /materials?classId=CLASS_ID&keyword=pdf
GET /materials?classId=CLASS_ID&subjectId=SUBJECT_ID&tagId=TAG_ID&keyword=sample
```

### Response 200
```json
{
  "items": [
    {
      "id": "MATERIAL_ID",
      "type": "pdf",
      "url": "https://example.com/sample.pdf",
      "classId": "CLASS_ID",
      "createdAt": "2026-02-02T06:30:29.605Z",
      "subjects": [
        { "id": "SUBJECT_ID", "name": "수학" }
      ],
      "tags": [
        { "id": "TAG_ID", "name": "중요" }
      ]
    }
  ],
  "count": 1
}
```

- `items`: 조건에 맞는 material 목록 (최대 50개, 최신순)
- `count`: 반환된 결과 개수
- `subjects`: material에 연결된 과목 목록
- `tags`: material에 연결된 태그 목록

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
- `MaterialTag(tagId, materialId)` 인덱스로 태그 필터 최적화

---

## Tag API

> **POST /tags**, **PUT /tags/:tagId**, **DELETE /tags/:tagId** — 교사만 가능
> **GET /tags**, **GET /tags/:tagId** — 인증 필요 (교사/학생 모두 가능)

### 설계 결정 사항
Tag는 **자유 형식 다중 태그**로, Subject와 독립적으로 Material에 부여할 수 있다.

---

### POST /tags

#### 목적
새 태그를 생성한다.

#### Request Body
```json
{ "name": "중요" }
```

#### Response 201
```json
{ "id": "TAG_ID", "name": "중요", "createdAt": "..." }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_TAG_NAME |
| 401 | UNAUTHORIZED | — |
| 403 | FORBIDDEN | TEACHER_ONLY |
| 409 | PAYLOAD_INVALID | DUPLICATE_TAG |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### GET /tags

#### 목적
전체 태그 목록을 이름 오름차순으로 반환한다.

#### Response 200
```json
[
  { "id": "TAG_ID", "name": "중요", "createdAt": "..." }
]
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 401 | UNAUTHORIZED | — |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### GET /tags/:tagId

#### Response 200
```json
{ "id": "TAG_ID", "name": "중요", "createdAt": "..." }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 401 | UNAUTHORIZED | — |
| 404 | PAYLOAD_INVALID | TAG_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### PUT /tags/:tagId

#### Request Body
```json
{ "name": "매우중요" }
```

#### Response 200
```json
{ "id": "TAG_ID", "name": "매우중요", "createdAt": "..." }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_TAG_NAME |
| 401 | UNAUTHORIZED | — |
| 403 | FORBIDDEN | TEACHER_ONLY |
| 404 | PAYLOAD_INVALID | TAG_NOT_FOUND |
| 409 | PAYLOAD_INVALID | DUPLICATE_TAG |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### DELETE /tags/:tagId

#### Response 200
```json
{ "ok": true, "tagId": "TAG_ID" }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 401 | UNAUTHORIZED | — |
| 403 | FORBIDDEN | TEACHER_ONLY |
| 404 | PAYLOAD_INVALID | TAG_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

## Material-Subject 연결 API

> **인증 불필요** — 전체 엔드포인트 인증 없이 접근 가능

---

### POST /materials/:materialId/subjects

#### 목적
수업자료에 과목을 추가한다. 여러 개를 한 번에 추가 가능하며, 중복은 무시된다.

#### Request Body
```json
{ "subjectIds": ["SUBJECT_ID_1", "SUBJECT_ID_2"] }
```

#### Response 200
```json
{
  "materialId": "MATERIAL_ID",
  "subjects": [
    { "id": "SUBJECT_ID_1", "name": "수학", "createdAt": "..." }
  ]
}
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_SUBJECT_IDS |
| 404 | PAYLOAD_INVALID | MATERIAL_NOT_FOUND |
| 404 | PAYLOAD_INVALID | SUBJECT_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### GET /materials/:materialId/subjects

#### 목적
수업자료에 연결된 과목 목록을 반환한다.

#### Response 200
```json
[
  { "id": "SUBJECT_ID", "name": "수학", "createdAt": "..." }
]
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 404 | PAYLOAD_INVALID | MATERIAL_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### DELETE /materials/:materialId/subjects/:subjectId

#### 목적
수업자료에서 과목을 제거한다.

#### Response 200
```json
{ "ok": true, "materialId": "MATERIAL_ID", "subjectId": "SUBJECT_ID" }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 404 | PAYLOAD_INVALID | MAPPING_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

## Material-Tag 연결 API

> **POST**, **GET**, **DELETE** 모두 **인증 필요** (교사/학생 모두 가능)

---

### POST /materials/:materialId/tags

#### 목적
수업자료에 태그를 추가한다. 여러 개를 한 번에 추가 가능하며, 중복은 무시된다.

#### Request Body
```json
{ "tagIds": ["TAG_ID_1", "TAG_ID_2"] }
```

#### Response 200
```json
{
  "materialId": "MATERIAL_ID",
  "tags": [
    { "id": "TAG_ID_1", "name": "중요", "createdAt": "..." }
  ]
}
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 400 | PAYLOAD_INVALID | INVALID_TAG_IDS |
| 401 | UNAUTHORIZED | — |
| 404 | PAYLOAD_INVALID | MATERIAL_NOT_FOUND |
| 404 | PAYLOAD_INVALID | TAG_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### GET /materials/:materialId/tags

#### 목적
수업자료에 연결된 태그 목록을 반환한다.

#### Response 200
```json
[
  { "id": "TAG_ID", "name": "중요", "createdAt": "..." }
]
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 401 | UNAUTHORIZED | — |
| 404 | PAYLOAD_INVALID | MATERIAL_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |

---

### DELETE /materials/:materialId/tags/:tagId

#### 목적
수업자료에서 태그를 제거한다.

#### Response 200
```json
{ "ok": true, "materialId": "MATERIAL_ID", "tagId": "TAG_ID" }
```

#### Errors
| HTTP | code | message |
|------|------|---------|
| 401 | UNAUTHORIZED | — |
| 404 | PAYLOAD_INVALID | MAPPING_NOT_FOUND |
| 500 | INTERNAL_ERROR | INTERNAL_ERROR |
