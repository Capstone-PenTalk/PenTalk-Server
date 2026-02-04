const { logger } = require("../utils/logger");
const Redis = require("ioredis");

const redisUrl =
  process.env.REDIS_URL ||
  `redis://${process.env.REDIS_HOST || "redis"}:${process.env.REDIS_PORT || 6379}`;

const redis = new Redis(redisUrl);

redis.on("connect", () => {
  logger.info("✅ Redis connected", { url: redisUrl });
});

redis.on("error", (err) => {
  logger.error("❌ Redis error", { err: err?.message });
});

module.exports = redis;
