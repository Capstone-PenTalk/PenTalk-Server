const { logger } = require("../utils/logger");
const Redis = require("ioredis");

// redis url 정규화를 위한 임시 로직, 데모 끝나면 삭제해도 됨
function normalizeRedisUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("//")) return `redis:${trimmed}`;
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  return `redis://${trimmed}`;
}

const redisUrl = normalizeRedisUrl(
  process.env.REDIS_URL ||
    process.env.REDIS_PRIVATE_URL ||
    process.env.REDIS_PUBLIC_URL ||
    `redis://${process.env.REDIS_HOST || "redis"}:${process.env.REDIS_PORT || 6379}`,
);

const redis = new Redis(redisUrl);

redis.on("connect", () => {
  logger.info("✅ Redis connected", { url: redisUrl });
});

redis.on("error", (err) => {
  logger.error("❌ Redis error", { err: err?.message });
});

module.exports = redis;
