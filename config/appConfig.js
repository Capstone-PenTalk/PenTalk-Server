// src/config/app.Config.js

const APP_CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  STATIC_DIR: 'public',
  SESSION_PREFIX: 'session:',
  SESSION_TTL_SECONDS: Number(process.env.SESSION_TTL_SECONDS) || 21600,
  WHITEBOARD_TTL_AFTER_END: Number(process.env.WHITEBOARD_TTL_AFTER_END) || 600,
  USER_SESSION_CACHE_TTL: Number(process.env.USER_SESSION_CACHE_TTL) || 21600,

  // ✅ 소셜 로그인(구글/카카오)
  OAUTH_STATE_TTL_SECONDS: Number(process.env.OAUTH_STATE_TTL_SECONDS) || 300, // CSRF용 state, 5분
  OAUTH_CODE_TTL_SECONDS: Number(process.env.OAUTH_CODE_TTL_SECONDS) || 90,    // 앱 전달용 1회용 코드, 90초
  APP_CALLBACK_URL: process.env.APP_CALLBACK_URL || 'pentalk://auth/callback', // 앱 딥링크 (고정값, 클라이언트가 지정 불가)
};

module.exports = { APP_CONFIG };
