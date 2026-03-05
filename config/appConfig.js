// src/config/app.Config.js

const APP_CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  STATIC_DIR: 'public',
  SESSION_PREFIX: 'session:',
  SESSION_TTL_SECONDS: Number(process.env.SESSION_TTL_SECONDS) || 21600,
  WHITEBOARD_TTL_AFTER_END: Number(process.env.WHITEBOARD_TTL_AFTER_END) || 600,
};

module.exports = { APP_CONFIG };
