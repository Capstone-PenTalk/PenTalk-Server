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
