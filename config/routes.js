// config/routes.js

const ROUTES = {
  SESSION_CREATE: '/session/create',
  SESSION_END: '/sessions/:sessionId/end',
  WHITEBOARD_GET: '/sessions/:sessionId/whiteboard',
  MATERIAL_UPLOAD: '/materials/pdf',  // ✅ #93
};

module.exports = { ROUTES };
