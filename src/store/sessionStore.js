const redis = require("../lib/redis");
const { APP_CONFIG } = require("../../config/appConfig");

const makeKey = (sessionId) => `session:${sessionId}`;

module.exports = {
  async create(sessionId, data) {
    const key = makeKey(sessionId);
    const value = JSON.stringify(data);

    await redis.setex(key, APP_CONFIG.SESSION_TTL_SECONDS, value);
  },

  async get(sessionId) {
    const value = await redis.get(makeKey(sessionId));
    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch (err) {
      console.error("❌ Session JSON parse failed:", {
        sessionId,
        value,
      });

      // 깨진 데이터는 삭제해서 재사용 방지
      await redis.del(makeKey(sessionId));
      return null;
    }
  },

  async exists(sessionId) {
    const key = makeKey(sessionId);
    const result = await redis.exists(key);
    return result === 1;
  },

  async update(sessionId, patch) {
    const key = makeKey(sessionId);
    const current = await this.get(sessionId);

    if (!current) return null;

    const ttl = await redis.ttl(key);
    const updated = { ...current, ...patch };

    await redis.setex(
      key,
      ttl > 0 ? ttl : APP_CONFIG.SESSION_TTL_SECONDS,
      JSON.stringify(updated)
    );

    return updated;
  },

  async delete(sessionId) {
    const key = makeKey(sessionId);
    await redis.del(key);
  },
};
