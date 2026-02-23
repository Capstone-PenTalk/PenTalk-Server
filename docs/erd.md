# ERD (Entity Relationship Diagram)

```mermaid
erDiagram
    User {
        String id PK
        String name
        String role
        DateTime createdAt
    }

    Class {
        String id PK
        String title
        String teacherId FK
        DateTime createdAt
    }

    ClassMember {
        String id PK
        String userId FK
        String classId FK
        String roleInClass
        DateTime createdAt
    }

    Material {
        String id PK
        String classId FK
        String type
        String url
        DateTime createdAt
    }

    Subject {
        String id PK
        String name
        DateTime createdAt
    }

    MaterialSubject {
        String id PK
        String materialId FK
        String subjectId FK
        DateTime createdAt
    }

    Tag {
        String id PK
        String name
        DateTime createdAt
    }

    MaterialTag {
        String id PK
        String materialId FK
        String tagId FK
        DateTime createdAt
    }

    User ||--o{ Class : "teaches (teacherId)"
    User ||--o{ ClassMember : "belongs to"
    Class ||--o{ ClassMember : "has"
    Class ||--o{ Material : "contains"
    Material ||--o{ MaterialSubject : "has"
    Subject ||--o{ MaterialSubject : "tagged to"
    Material ||--o{ MaterialTag : "has"
    Tag ||--o{ MaterialTag : "tagged to"
```

## 관계 설명

| 관계 | 종류 | 설명 |
|------|------|------|
| User → Class | 1:N | 교사 한 명이 여러 반을 담당 |
| User ↔ Class (ClassMember) | N:M | 학생/교사가 여러 반에 소속 가능 |
| Class → Material | 1:N | 반 하나에 여러 수업자료 |
| Material ↔ Subject (MaterialSubject) | N:M | 수업자료에 여러 과목 태그 가능 |
| Material ↔ Tag (MaterialTag) | N:M | 수업자료에 여러 태그 가능 |

## 인덱스

| 테이블 | 인덱스 | 목적 |
|--------|--------|------|
| Material | `(classId, createdAt)` | 반별 최신순 조회 최적화 |
| MaterialSubject | `(subjectId, materialId)` | 과목 기준 필터링 최적화 |
| MaterialTag | `(tagId, materialId)` | 태그 기준 필터링 최적화 |
| ClassMember | `UNIQUE (classId, userId)` | 중복 멤버 방지 |
