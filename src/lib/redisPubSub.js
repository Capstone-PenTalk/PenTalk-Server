const { logger } = require("../utils/logger");
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL;

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
