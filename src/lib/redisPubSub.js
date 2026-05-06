const { logger } = require("../utils/logger");
const Redis = require("ioredis");

// redis url 정규화를 위한 임시 로직, 데모 끝나면 삭제해도 됨
function normalizeRedisUrl(rawUrl) {
  let normalized = (rawUrl || "").trim();
  if (!normalized) return normalized;
  normalized = normalized.replace(/^['"]|['"]$/g, "");
  normalized = normalized.replace(/\s+/g, "");
  normalized = normalized.replace(/^redis_url=/i, "");
  normalized = normalized.replace(/^url=/i, "");
  if (normalized.startsWith("//")) return `redis:${normalized}`;
  if (/^[a-z]+:\/\//i.test(normalized)) return normalized;
  return `redis://${normalized}`;
}

const REDIS_URL = normalizeRedisUrl(
  process.env.REDIS_URL ||
    process.env.REDIS_PRIVATE_URL ||
    process.env.REDIS_PUBLIC_URL ||
    `redis://${process.env.REDIS_HOST || "redis"}:${process.env.REDIS_PORT || 6379}`,
);

// publisher (메시지 발행 전용)
const pubClient = new Redis(REDIS_URL);

// subscriber (메시지 수신 전용)
const subClient = new Redis(REDIS_URL);

/**
 * 공통 로그 헬퍼
 */
function attachRedisLogs(client, name) {
  client.on("connect", () => {
    logger.info(`🔌 Redis ${name} connecting...`);
  });

  client.on("ready", () => {
    logger.info(`✅ Redis ${name} ready`);
  });

  client.on("reconnecting", () => {
    logger.info(`🔄 Redis ${name} reconnecting...`);
  });

  client.on("error", (err) => {
    logger.error(`❌ Redis ${name} error`, { err: err?.message });
  });
}

attachRedisLogs(pubClient, "PUB");
attachRedisLogs(subClient, "SUB");

module.exports = {
  pubClient,
  subClient,
};
