// config/routes.js

const ROUTES = {
  SESSION_CREATE: '/session/create',
  SESSION_JOIN:   '/sessions/:sessionId/join',  // ✅ #126
  SESSION_END:    '/sessions/:sessionId/end',
  WHITEBOARD_GET: '/sessions/:sessionId/whiteboard',
  MATERIAL_UPLOAD: '/materials/pdf',  // ✅ #93

  // ✅ #60
  QUIZ_BASE: '/sessions/:sessionId/quiz',             // GET(목록), POST(추가)
  QUIZ_ITEM: '/sessions/:sessionId/quiz/:questionId', // PUT(수정), DELETE(삭제)
};

module.exports = { ROUTES };
