// config/routes.js

const ROUTES = {
  AUTH_SIGNUP:   '/auth/signup',    // ✅ #172 POST
  AUTH_CHECK_ID: '/auth/check-id',  // ✅ #172 GET
  AUTH_LOGIN:    '/auth/login',     // ✅ #173 POST

  // ✅ 소셜 로그인(구글/카카오)
  AUTH_GOOGLE:          '/auth/google',          // GET: 인증 시작 (Provider로 리다이렉트)
  AUTH_GOOGLE_CALLBACK: '/auth/google/callback',  // GET: Provider redirect_uri
  AUTH_KAKAO:           '/auth/kakao',            // GET: 인증 시작
  AUTH_KAKAO_CALLBACK:  '/auth/kakao/callback',    // GET: Provider redirect_uri
  AUTH_EXCHANGE:        '/auth/exchange',          // POST: 1회용 코드 → JWT 교환
  AUTH_ROLE:            '/auth/role',              // PATCH: 최초 역할 확정

  CLASS_CREATE: '/classes',           // ✅ #138 POST
  CLASS_GET:    '/classes/:classId',  // ✅ #138 GET

  SESSION_CREATE: '/session/create',
  SESSION_JOIN:   '/sessions/:sessionId/join',  // ✅ #126
  SESSION_END:      '/sessions/:sessionId/end',
  SESSION_MATERIAL: '/sessions/:sessionId/material',  // ✅ #이슈번호: POST(세션 내 자료 업로드)
  WHITEBOARD_GET:   '/sessions/:sessionId/whiteboard',
  MATERIAL_UPLOAD: '/materials/pdf',  // ✅ #93

  // ✅ #60
  QUIZ_BASE:   '/sessions/:sessionId/quiz',                  // GET(목록), POST(추가)
  QUIZ_ITEM:   '/sessions/:sessionId/quiz/:questionId',      // PUT(수정), DELETE(삭제)
  // ✅ #132
  QUIZ_SUBMIT: '/sessions/:sessionId/quiz/submit',           // POST(복습 퀴즈 제출, 학생 전용)
  // ✅ #134
  QUIZ_RESULT: '/sessions/:sessionId/quiz/result',           // GET(퀴즈 통과 여부 조회)
};

module.exports = { ROUTES };
