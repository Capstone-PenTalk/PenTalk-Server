// src/config/app.Config.js

function clampDpi(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

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

  // PDF 페이지 서버 래스터화: 교사/학생 기기별 PDF 렌더러 차이로 인한 판서 좌표 불일치 해결
  // 72~300 범위로 clamp (환경변수 오설정 방어)
  PDF_RASTERIZE_DPI: clampDpi(process.env.PDF_RASTERIZE_DPI, 150, 72, 300),
};

module.exports = { APP_CONFIG };
