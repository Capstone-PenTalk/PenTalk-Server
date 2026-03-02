# ERD (Entity Relationship Diagram)

```mermaid
erDiagram
    User {
        String id PK
        String name "nullable"
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
        String roleInClass "default: student"
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
        String name "unique"
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
        String name "unique"
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
    Class ||--o{ ClassMember : "has (cascade delete)"
    Class ||--o{ Material : "contains (cascade delete)"
    Material ||--o{ MaterialSubject : "has (cascade delete)"
    Subject ||--o{ MaterialSubject : "tagged to (cascade delete)"
    Material ||--o{ MaterialTag : "has (cascade delete)"
    Tag ||--o{ MaterialTag : "tagged to (cascade delete)"
```

## 관계 설명

| 관계 | 종류 | 설명 |
|------|------|------|
| User → Class | 1:N | 교사 한 명이 여러 반을 담당 |
| User ↔ Class (ClassMember) | N:M | 학생/교사가 여러 반에 소속 가능 |
| Class → Material | 1:N | 반 하나에 여러 수업자료 |
| Material ↔ Subject (MaterialSubject) | N:M | 수업자료에 여러 과목 태그 가능 |
| Material ↔ Tag (MaterialTag) | N:M | 수업자료에 여러 태그 가능 |

## 제약 조건

| 테이블 | 제약 | 설명 |
|--------|------|------|
| ClassMember | `UNIQUE (classId, userId)` | 동일 반에 중복 멤버 방지 |
| MaterialSubject | `UNIQUE (materialId, subjectId)` | 동일 과목 중복 연결 방지 |
| MaterialTag | `UNIQUE (materialId, tagId)` | 동일 태그 중복 연결 방지 |
| Subject | `UNIQUE (name)` | 과목명 중복 방지 |
| Tag | `UNIQUE (name)` | 태그명 중복 방지 |

## 인덱스

| 테이블 | 인덱스 | 목적 |
|--------|--------|------|
| Material | `(classId, createdAt)` | 반별 최신순 조회 최적화 |
| MaterialSubject | `(subjectId, materialId)` | 과목 기준 필터링 최적화 |
| MaterialTag | `(tagId, materialId)` | 태그 기준 필터링 최적화 |

## Cascade Delete 규칙

| 부모 삭제 시 | 연쇄 삭제 대상 |
|-------------|---------------|
| Class 삭제 | ClassMember, Material |
| Material 삭제 | MaterialSubject, MaterialTag |
| Subject 삭제 | MaterialSubject |
| Tag 삭제 | MaterialTag |
| User 삭제 | ClassMember |
