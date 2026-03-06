require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { logger } = require("./utils/logger");
const { ERRORS } = require("../config/errors");
const { sendHttpError } = require("./utils/httpError");
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const WHITEBOARD_DIR = path.join(__dirname, '..', 'storage', 'whiteboards');


if (process.env.NODE_ENV !== "production") {
  logger.info("env loaded", { key: "REDIS_URL" });
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { APP_CONFIG } = require('../config/appConfig');
const { SOCKET_EVENTS } = require('../config/socket.events');
const { ROUTES } = require('../config/routes');
const sessionStore = require('./store/sessionStore');
const { signToken, verifyToken } = require('./utils/jwt');
const { pubClient, subClient } = require("./lib/redisPubSub");
const redis = require("./lib/redis");
const MAX_MESSAGE_LEN = 300;
const VALID_DRAW_APPEND_TYPES = new Set(["ds", "dm", "de"]);

// ✅ #74: room별 진행 중인 stroke 임시 저장 (ds → de 완성 전까지)
// Map<sessionId, Map<sId, {sId, x, y, c, w}>>
const pendingStrokes = new Map();

// ✅ #38: presence 자료구조 (sessionId -> Map(userKey -> socketId))
const presenceBySession = new Map();

function userKeyOf(socket) {
  return `${socket.data.role}:${socket.data.userId}`;
}

function getSessionPresence(roomId) {
  let m = presenceBySession.get(roomId);
  if (!m) {
    m = new Map();
    presenceBySession.set(roomId, m);
  }
  return m;
}

function buildPresenceList(roomId) {
  const m = presenceBySession.get(roomId);
  if (!m) return [];
  return Array.from(m.keys()).map((k) => {
    const [role, userId] = k.split(":");
    return { userId, role };
  });
}

function getRoleRooms(roomId) {
  return {
    studentsRoom: `${APP_CONFIG.SESSION_PREFIX}${roomId}:students`,
    teachersRoom: `${APP_CONFIG.SESSION_PREFIX}${roomId}:teachers`,
  };
}



function isValidMessage(msg) {
  if (typeof msg !== "string") return false;

  const trimmed = msg.trim();
  if (!trimmed) return false;

  if (trimmed.length > MAX_MESSAGE_LEN) return false;

  return true;
}


// ✅ #34: whiteboard 분산 락 (SET NX PX)
const WB_LOCK_TTL_MS = 2000;
const WB_LOCK_RETRY_DELAY_MS = 25;
const WB_LOCK_MAX_RETRIES = 10;
// 락 해제: 자신이 건 락만 삭제 (Lua 원자적 실행)
const WB_LOCK_RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end`;

async function withWhiteboardLock(sessionId, fn) {
  const lockKey = `lock:whiteboard:${sessionId}`;
  const lockValue = uuidv4();
  for (let attempt = 0; attempt <= WB_LOCK_MAX_RETRIES; attempt++) {
    const acquired = await redis.set(lockKey, lockValue, "NX", "PX", WB_LOCK_TTL_MS);
    if (acquired) {
      try {
        return await fn();
      } finally {
        await redis.eval(WB_LOCK_RELEASE_SCRIPT, 1, lockKey, lockValue);
      }
    }
    if (attempt < WB_LOCK_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, WB_LOCK_RETRY_DELAY_MS));
    }
  }
  throw new Error(`whiteboard lock timeout sessionId=${sessionId}`);
}

// room별 draw tick 카운터 (순서 보장용)
const roomDrawTick = new Map();

function getNextTick(roomName) {
  const t = (roomDrawTick.get(roomName) || 0) + 1;
  roomDrawTick.set(roomName, t);
  return t;
}

// ✅ 가드 헬퍼 함수
function requireTeacher(socket) {
  return socket.data.role === "teacher";
}

function requireJoined(socket) {
  return !!socket.currentRoom && !!socket.data.roomId && !!socket.data.classId;
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: APP_CONFIG.CORS_ORIGIN }
});

// 1) dm-channel:* 패턴 구독
subClient.psubscribe("dm-channel:*", (err, count) => {
  if (err) {
    logger.error("❌redis psubscribe failed", { err: err?.message });
    return;
  }
  logger.info("📡redis psubscribed", { pattern: "dm-channel:*", count });
});

// 2) 메시지 수신 → 학생 룸으로만 브로드캐스트
subClient.on("pmessage", (pattern, channel, message) => {
  try {
    // channel 예: dm-channel:abc123
    const sessionId = channel.split(":")[1];
    if (!sessionId) return;

    const payload = JSON.parse(message);

    const studentsRoom = `${APP_CONFIG.SESSION_PREFIX}${sessionId}:students`;

    const senderSocketId = payload?.senderSocketId;

    if (senderSocketId && io.sockets.sockets.has(senderSocketId)) {
      io.to(studentsRoom).except(senderSocketId).emit(SOCKET_EVENTS.RECEIVE_DM, payload);
    } else {
      io.to(studentsRoom).emit(SOCKET_EVENTS.RECEIVE_DM, payload);
    }

    logger.info("📨pubsub dm broadcast", {
    channel,
    channelSessionId: sessionId,
    studentsRoom,
    fromUserId: payload?.senderUserId,
    senderSocketId: payload?.senderSocketId,
  });

  } catch (e) {
    logger.warn("❌pubsub dm invalid message", { err: e?.message });
  }
});


io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      logger.warn("socket auth failed", { reason: "NO_TOKEN", socketId: socket.id });
      return next(new Error("UNAUTHORIZED"));
    }

    const payload = verifyToken(token); // { userId, role }

    if (!payload?.userId || !payload?.role) {
      logger.warn("socket auth failed", {
        reason: "INVALID_PAYLOAD",
        socketId: socket.id,
        payload,
      });
      return next(new Error("UNAUTHORIZED"));
    }

    if (!['teacher', 'student'].includes(payload.role)) {
      logger.warn("socket auth failed", {
        reason: "INVALID_ROLE",
        socketId: socket.id,
        userId: payload.userId,
        role: payload.role,
      });
      return next(new Error("UNAUTHORIZED"));
    }

    // ✅ JWT에서만 가져옴
    socket.data.userId = payload.userId;
    socket.data.role = payload.role;

    logger.info("socket authenticated", {
      socketId: socket.id,
      userId: payload.userId,
      role: payload.role,
    });

    return next();
  } catch (err) {
    logger.error("socket auth error", {
      socketId: socket.id,
      error: err.message,
    });
    return next(new Error("UNAUTHORIZED"));
  }
});


app.use(cors({
  origin: APP_CONFIG.CORS_ORIGIN,
}));

app.use(express.json());
app.use(express.static(APP_CONFIG.STATIC_DIR));

// ✅ #29: HTTP 인증 미들웨어
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const [type, token] = auth.split(" ");

  if (type !== "Bearer" || !token) {
    return sendHttpError(res, 401, ERRORS.UNAUTHORIZED, "MISSING_TOKEN");
  }

  try {
    const payload = verifyToken(token);
    if (!payload?.userId) {
      return sendHttpError(res, 401, ERRORS.UNAUTHORIZED, "INVALID_TOKEN_PAYLOAD");
    }
    req.userId = payload.userId;
    req.role = payload.role;
    next();
  } catch (e) {
    return sendHttpError(res, 401, ERRORS.UNAUTHORIZED, "INVALID_TOKEN");
  }
}

// ✅ #30: 교사 role 검증 미들웨어 (requireAuth 이후에 사용)
function requireTeacherRole(req, res, next) {
  if (req.role !== "teacher") {
    return sendHttpError(res, 403, ERRORS.FORBIDDEN, "TEACHER_ONLY");
  }
  next();
}

// ✅ #29: class 멤버십 검증 미들웨어
async function requireClassMember(req, res, next) {
  const classId = (req.query.classId || "").toString().trim();

  if (!classId) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "MISSING_CLASS_ID");
  }

  try {
    const membership = await prisma.classMember.findFirst({
      where: { classId, userId: req.userId },
      select: { id: true, roleInClass: true },
    });

    if (!membership) {
      return sendHttpError(res, 403, ERRORS.FORBIDDEN, "NOT_CLASS_MEMBER");
    }

    req.roleInClass = membership.roleInClass;
    next();
  } catch (e) {
    logger.error("requireClassMember failed", { err: e?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
}

app.post("/subjects", async (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_SUBJECT_NAME");
  }

  try {
    const subject = await prisma.subject.create({
      data: { name: name.trim() },
    });

    return res.status(201).json(subject);
  } catch (err) {
    if (err?.code === "P2002") {
      return sendHttpError(res, 409, ERRORS.PAYLOAD_INVALID, "DUPLICATE_SUBJECT");
    }

    logger.error("subject create failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

async function getSubjectOr404(subjectId, res) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "SUBJECT_NOT_FOUND");
    return null;
  }
  return subject;
}

app.get("/subjects/:subjectId", async (req, res) => {
  const { subjectId } = req.params;

  try {
    const subject = await prisma.subject.findUnique({
      where: { id: subjectId },
    });

    if (!subject) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "SUBJECT_NOT_FOUND");
    }

    return res.json(subject);
  } catch (err) {
    logger.error("subject get failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.get("/subjects", async (req, res) => {
  try {
    const subjects = await prisma.subject.findMany({
      orderBy: { name: "asc" },
    });

    return res.json(subjects);
  } catch (err) {
    logger.error("subjects list failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.put("/subjects/:subjectId", async (req, res) => {
  const { subjectId } = req.params;
  const { name } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_SUBJECT_NAME");
  }

  try {
    // 존재 확인
    const subject = await getSubjectOr404(subjectId, res);
    if (!subject) return;

    const updated = await prisma.subject.update({
      where: { id: subjectId },
      data: { name: name.trim() },
    });

    return res.json(updated);
  } catch (err) {
    if (err?.code === "P2002") {
      return sendHttpError(res, 409, ERRORS.PAYLOAD_INVALID, "DUPLICATE_SUBJECT");
    }

    logger.error("subject update failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.delete("/subjects/:subjectId", async (req, res) => {
  const { subjectId } = req.params;

  try {
    // 존재 확인
    const subject = await getSubjectOr404(subjectId, res);
    if (!subject) return;

    await prisma.subject.delete({
      where: { id: subjectId },
    });

    return res.json({ ok: true, subjectId });
  } catch (err) {
    logger.error("subject delete failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

// ✅ #30: Tag CRUD
async function getTagOr404(tagId, res) {
  const tag = await prisma.tag.findUnique({ where: { id: tagId } });
  if (!tag) {
    sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "TAG_NOT_FOUND");
    return null;
  }
  return tag;
}

app.post("/tags", requireAuth, requireTeacherRole, async (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_TAG_NAME");
  }

  try {
    const tag = await prisma.tag.create({ data: { name: name.trim() } });
    return res.status(201).json(tag);
  } catch (err) {
    if (err?.code === "P2002") {
      return sendHttpError(res, 409, ERRORS.PAYLOAD_INVALID, "DUPLICATE_TAG");
    }
    logger.error("tag create failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.get("/tags", requireAuth, async (req, res) => {
  try {
    const tags = await prisma.tag.findMany({ orderBy: { name: "asc" } });
    return res.json(tags);
  } catch (err) {
    logger.error("tags list failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.get("/tags/:tagId", requireAuth, async (req, res) => {
  const { tagId } = req.params;
  try {
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "TAG_NOT_FOUND");
    return res.json(tag);
  } catch (err) {
    logger.error("tag get failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.put("/tags/:tagId", requireAuth, requireTeacherRole, async (req, res) => {
  const { tagId } = req.params;
  const { name } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_TAG_NAME");
  }

  try {
    const tag = await getTagOr404(tagId, res);
    if (!tag) return;

    const updated = await prisma.tag.update({
      where: { id: tagId },
      data: { name: name.trim() },
    });
    return res.json(updated);
  } catch (err) {
    if (err?.code === "P2002") {
      return sendHttpError(res, 409, ERRORS.PAYLOAD_INVALID, "DUPLICATE_TAG");
    }
    logger.error("tag update failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.delete("/tags/:tagId", requireAuth, requireTeacherRole, async (req, res) => {
  const { tagId } = req.params;
  try {
    const tag = await getTagOr404(tagId, res);
    if (!tag) return;

    await prisma.tag.delete({ where: { id: tagId } });
    return res.json({ ok: true, tagId });
  } catch (err) {
    logger.error("tag delete failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

/**
 * GET /materials?classId=&subjectId=&tagId=&keyword=
 *
 * - classId: 필수
 * - subjectId: 선택 (MaterialSubject 조인 필터)
 * - keyword: 선택 (현재 schema에 title/description 없음 → type/url로만 최소 검색)
 *
 * 응답:
 * { items: [{ id,type,url,classId,createdAt,subjects:[{id,name}]}], count }
 */
app.get("/materials", requireAuth, requireClassMember, async (req, res) => {
  try {
    const classId = (req.query.classId || "").toString().trim();
    const subjectId = (req.query.subjectId || "").toString().trim();
    const tagId = (req.query.tagId || "").toString().trim();
    const keyword = (req.query.keyword || "").toString().trim();

    // 2) where 구성 (Material 기준)
    /** @type {any} */
    const where = { classId };

    // subject 필터: MaterialSubject 조인 테이블을 통해 필터링
    if (subjectId) {
      where.subjects = {
        some: { subjectId },
      };
    }

    // tag 필터: MaterialTag 조인 테이블을 통해 필터링
    if (tagId) {
      where.MaterialTag = {
        some: { tagId },
      };
    }

    // keyword 검색: schema에 title/description이 없어서
    // 임시로 type/url에서만 검색(필요하면 Material에 title 같은 필드 추가 권장)
    if (keyword && keyword.length >= 2) {
      where.OR = [
        { type: { contains: keyword, mode: "insensitive" } },
        { url: { contains: keyword, mode: "insensitive" } },
      ];
    }

    // 3) 조회 + subject/tag 이름까지 포함
    const items = await prisma.material.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        subjects: {
          include: {
            subject: { select: { id: true, name: true } },
          },
        },
        MaterialTag: {
          include: {
            Tag: { select: { id: true, name: true } },
          },
        },
      },
      take: 50,
    });

    // 4) 프론트 친화 포맷으로 변환
    const formatted = items.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      classId: m.classId,
      createdAt: m.createdAt,
      subjects: (m.subjects || []).map((ms) => ({
        id: ms.subject.id,
        name: ms.subject.name,
      })),
      tags: (m.MaterialTag || []).map((mt) => ({
        id: mt.Tag.id,
        name: mt.Tag.name,
      })),
    }));

    return res.json({
      items: formatted,
      count: formatted.length,
    });
  } catch (err) {
  console.error("========== GET /materials ERROR ==========");
  console.error("name:", err?.name);
  console.error("message:", err?.message);
  console.error("stack:", err?.stack);
  console.error("raw:", err);
  console.error("==========================================");
  return res.status(500).json({
    code: "INTERNAL_ERROR",
    message: "failed to fetch materials",
  });
}


});



app.post("/materials/:materialId/subjects", async (req, res) => {
  const { materialId } = req.params;
  const { subjectIds } = req.body;

  if (!Array.isArray(subjectIds) || subjectIds.length === 0) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_SUBJECT_IDS");
  }

  const uniqueIds = [...new Set(subjectIds.map((x) => String(x).trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_SUBJECT_IDS");
  }

  try {
    // 1) material 존재 확인
    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { id: true },
    });
    if (!material) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "MATERIAL_NOT_FOUND");
    }

    // 2) subject 존재 확인
    const found = await prisma.subject.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "SUBJECT_NOT_FOUND");
    }

    // 3) 매핑 생성 (중복은 skipDuplicates로 무시)
    await prisma.materialSubject.createMany({
      data: uniqueIds.map((subjectId) => ({ materialId, subjectId })),
      skipDuplicates: true,
    });

    // 4) 결과 반환
    const mapped = await prisma.materialSubject.findMany({
      where: { materialId },
      include: { subject: true },
      orderBy: { createdAt: "asc" },
    });

    return res.json({
      materialId,
      subjects: mapped.map((m) => m.subject),
    });
  } catch (err) {
    logger.error("material subject add failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.get("/materials/:materialId/subjects", async (req, res) => {
  const { materialId } = req.params;

  try {
    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { id: true },
    });

    if (!material) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "MATERIAL_NOT_FOUND");
    }

    const mapped = await prisma.materialSubject.findMany({
      where: { materialId },
      include: { subject: true },
      orderBy: { createdAt: "asc" },
    });

    return res.json(mapped.map((m) => m.subject));
  } catch (err) {
    logger.error("material subject list failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.delete("/materials/:materialId/subjects/:subjectId", async (req, res) => {
  const { materialId, subjectId } = req.params;

  try {
    const deleted = await prisma.materialSubject.deleteMany({
      where: { materialId, subjectId },
    });

    if (deleted.count === 0) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "MAPPING_NOT_FOUND");
    }

    return res.json({ ok: true, materialId, subjectId });
  } catch (err) {
    logger.error("material subject delete failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

// ✅ #30: MaterialTag 엔드포인트
app.post("/materials/:materialId/tags", requireAuth, async (req, res) => {
  const { materialId } = req.params;
  const { tagIds } = req.body;

  if (!Array.isArray(tagIds) || tagIds.length === 0) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_TAG_IDS");
  }

  const uniqueIds = [...new Set(tagIds.map((x) => String(x).trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "INVALID_TAG_IDS");
  }

  try {
    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { id: true },
    });
    if (!material) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "MATERIAL_NOT_FOUND");
    }

    const found = await prisma.tag.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "TAG_NOT_FOUND");
    }

    await prisma.materialTag.createMany({
      data: uniqueIds.map((tagId) => ({ materialId, tagId })),
      skipDuplicates: true,
    });

    const mapped = await prisma.materialTag.findMany({
      where: { materialId },
      include: { Tag: true },
      orderBy: { createdAt: "asc" },
    });

    return res.json({
      materialId,
      tags: mapped.map((m) => m.Tag),
    });
  } catch (err) {
    logger.error("material tag add failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.get("/materials/:materialId/tags", requireAuth, async (req, res) => {
  const { materialId } = req.params;

  try {
    const material = await prisma.material.findUnique({
      where: { id: materialId },
      select: { id: true },
    });
    if (!material) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "MATERIAL_NOT_FOUND");
    }

    const mapped = await prisma.materialTag.findMany({
      where: { materialId },
      include: { Tag: true },
      orderBy: { createdAt: "asc" },
    });

    return res.json(mapped.map((m) => m.Tag));
  } catch (err) {
    logger.error("material tag list failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});

app.delete("/materials/:materialId/tags/:tagId", requireAuth, async (req, res) => {
  const { materialId, tagId } = req.params;

  try {
    const deleted = await prisma.materialTag.deleteMany({
      where: { materialId, tagId },
    });

    if (deleted.count === 0) {
      return sendHttpError(res, 404, ERRORS.PAYLOAD_INVALID, "MAPPING_NOT_FOUND");
    }

    return res.json({ ok: true, materialId, tagId });
  } catch (err) {
    logger.error("material tag delete failed", { err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR ?? "INTERNAL_ERROR", "INTERNAL_ERROR");
  }
});


// ✅ #34: 세션 종료 API
app.post(ROUTES.SESSION_END, requireAuth, requireTeacherRole, async (req, res) => {
  const { sessionId } = req.params;

  try {
    // 1. Idempotent: 이미 ARCHIVED면 기존 결과 반환
    const existing = await prisma.session.findUnique({ where: { id: sessionId } });
    if (existing?.status === 'ARCHIVED') {
      return res.json({
        ok: true,
        sessionId,
        status: 'ARCHIVED',
        drawingPath: existing.drawingPath,
        closedAt: existing.closedAt,
      });
    }

    // 2. Redis에서 세션 조회
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return sendHttpError(res, 404, ERRORS.SESSION_NOT_FOUND, "SESSION_NOT_FOUND");
    }

    // 3. JWT classId == session.classId 검증 (교사가 해당 클래스 멤버인지 확인)
    const membership = await prisma.classMember.findFirst({
      where: { classId: session.classId, userId: req.userId },
      select: { id: true },
    });
    if (!membership) {
      return sendHttpError(res, 403, ERRORS.FORBIDDEN, "NOT_CLASS_MEMBER");
    }

    // 4. DB 상태: ACTIVE → CLOSING
    await prisma.session.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        classId: session.classId,
        materialId: session.materialId || null,
        status: 'CLOSING',
        endAttempts: 1,
      },
      update: {
        status: 'CLOSING',
        endAttempts: { increment: 1 },
        endError: null,
      },
    });

    // 5. Redis에서 판서 데이터 수집 (락으로 스냅샷 일관성 보장)
    const wbKey = `whiteboard:${sessionId}`;
    let strokes = [];
    await withWhiteboardLock(sessionId, async () => {
      const raw = await redis.get(wbKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
        } catch (e) {
          logger.warn("invalid whiteboard json in redis", { sessionId, err: e?.message });
        }
      }
    });
    const whiteboardData = { strokes };

    // 6. Atomic file write: tmp → rename
    await fs.promises.mkdir(WHITEBOARD_DIR, { recursive: true });
    const filePath = path.join(WHITEBOARD_DIR, `${sessionId}.json`);
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(whiteboardData), 'utf8');
    await fs.promises.rename(tmpPath, filePath);

    // 7. 파일 저장 성공 후 Redis TTL 설정 (즉시 DEL 하지 않음)
    await redis.expire(wbKey, APP_CONFIG.WHITEBOARD_TTL_AFTER_END);

    // 8. DB 상태: CLOSING → ARCHIVED
    const closedAt = new Date();
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'ARCHIVED',
        drawingPath: filePath,
        closedAt,
        endError: null,
      },
    });

    // 9. Socket session:ended 브로드캐스트
    const studentsRoom = `${APP_CONFIG.SESSION_PREFIX}${sessionId}:students`;
    const teachersRoom = `${APP_CONFIG.SESSION_PREFIX}${sessionId}:teachers`;
    io.to(studentsRoom).to(teachersRoom).emit(SOCKET_EVENTS.SESSION_ENDED, {
      sessionId,
      endedAt: closedAt.getTime(),
      reason: "SESSION_ENDED_BY_TEACHER",
      endedBy: req.userId,
      message: "교사가 수업을 종료했습니다",
    });

    // ✅ #41: 세션 참여자 lastSession 캐시 삭제 (현재 sessionId와 일치하는 것만)
    const sessionUsersKey = `session:${sessionId}:users`;
    const userIds = await redis.smembers(sessionUsersKey);
    if (userIds.length > 0) {
      const getPipeline = redis.pipeline();
      for (const userId of userIds) getPipeline.get(`user:${userId}:lastSession`);
      const getResults = await getPipeline.exec();

      const delPipeline = redis.pipeline();
      for (let i = 0; i < userIds.length; i++) {
        const raw = getResults[i][1];
        if (raw) {
          try {
            const cached = JSON.parse(raw);
            if (cached.sessionId === sessionId) delPipeline.del(`user:${userIds[i]}:lastSession`);
          } catch (_) {}
        }
      }
      delPipeline.del(sessionUsersKey);
      await delPipeline.exec();
    }

    logger.info("✅ session ended", {
      sessionId,
      classId: session.classId,
      strokeCount: strokes.length,
      drawingPath: filePath,
    });

    return res.json({
      ok: true,
      sessionId,
      status: 'ARCHIVED',
      strokeCount: strokes.length,
      drawingPath: filePath,
      closedAt,
    });
  } catch (err) {
    logger.error("session end failed", { sessionId, err: err?.message });
    // 실패 시 endError 기록 (CLOSING 상태로 남아있을 수 있음)
    try {
      await prisma.session.updateMany({
        where: { id: sessionId, status: 'CLOSING' },
        data: { status: 'FAILED', endError: err?.message ?? 'UNKNOWN' },
      });
    } catch (_) { /* DB 기록 실패는 무시 */ }
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR, "SESSION_END_FAILED");
  }
});

const PORT = process.env.PORT || APP_CONFIG.PORT;

app.post('/auth/dev-login', (req, res) => {
  const { userId, role } = req.body;

  if (!userId || !role || !['teacher','student'].includes(role)) {
    return sendHttpError(
      res,
      400,
      ERRORS.PAYLOAD_INVALID,
      "INVALID_INPUT"
  );

  }

  const token = signToken({ userId, role });
  res.json({ token, user: { userId, role } });

});


app.post(ROUTES.SESSION_CREATE, async (req, res) => {
const { classId, materialId } = req.body;

if (!classId || typeof classId !== "string" || classId.trim() === "") {
  return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, "MISSING_CLASS_ID");
}

// ✅ classId DB 검증 (RDB 기준으로 유효한 class만 세션 생성 허용)
const foundClass = await prisma.class.findUnique({
  where: { id: classId.trim() },
  select: { id: true },
});

if (!foundClass) {
  return sendHttpError(res, 404, ERRORS.CLASS_NOT_FOUND, "CLASS_NOT_FOUND");
}

// ✅ materialId가 있으면 DB 검증 (선택)
let normalizedMaterialId = null;

if (
  materialId !== undefined &&
  materialId !== null &&
  typeof materialId === "string" &&
  materialId.trim() !== ""
) {
  normalizedMaterialId = materialId.trim();

  const foundMaterial = await prisma.material.findUnique({
    where: { id: normalizedMaterialId },
    select: { id: true, classId: true },
  });

  if (!foundMaterial) {
    return sendHttpError(res, 404, ERRORS.MATERIAL_NOT_FOUND, "MATERIAL_NOT_FOUND");
  }

  if (foundMaterial.classId !== classId.trim()) {
    return sendHttpError(res, 400, ERRORS.MATERIAL_CLASS_MISMATCH, "MATERIAL_CLASS_MISMATCH");
  }
}

  const sessionId = uuidv4();

  const sessionData = {
    id: sessionId,
    classId: classId.trim(),
    materialId: normalizedMaterialId,
    createdAt: Date.now(),
  };

  await sessionStore.create(sessionId, sessionData);

logger.info("session created", { sessionId, classId: sessionData.classId });

const clientOrigin =
  process.env.CLIENT_ORIGIN || APP_CONFIG.CORS_ORIGIN || "http://localhost:5173";
const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS || 21600);

res.json({
  sessionId,
  materialId: sessionData.materialId,
  joinUrlTeacher: `${clientOrigin}/?sessionId=${sessionId}&role=teacher`,
  joinUrlStudent: `${clientOrigin}/?sessionId=${sessionId}&role=student`,
  ttlSeconds,
});
});


/**
 * ✅ Socket.IO 연결
 */
io.on('connection', (socket) => {

logger.info("socket connected", {
  socketId: socket.id,
  userId: socket.data.userId,
  role: socket.data.role,
});

socket.currentRoom = null;

// ✅ join-room
socket.on(SOCKET_EVENTS.JOIN_ROOM, async ({ roomId, classId, materialId }) => {
  logger.info("join room requested", {
    socketId: socket.id,
    role: socket.data.role,
    roomId,
  });

  if (!roomId) {
    socket.emit(SOCKET_EVENTS.ERROR, {
      code: ERRORS.MISSING_ROOM_ID,
      message: "roomId is required",
    });
    return;
  }


    // ✅ #41: 캐시 우선 조회 (userId → lastSession)
    const cacheKey = `user:${socket.data.userId}:lastSession`;
    let session = null;
    let cacheHit = false;

    const cachedRaw = await redis.get(cacheKey);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw);
        if (cached.sessionId === roomId) {
          session = { classId: cached.classId, materialId: cached.materialId ?? null };
          cacheHit = true;
        }
      } catch (_) {}
    }

    if (!cacheHit) {
      const fetched = await sessionStore.get(roomId);
      if (!fetched) {
        socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.SESSION_NOT_FOUND, message: "Session not found" });
        return;
      }

      // ✅ #39: 종료된 세션 재입장 차단 (캐시 미스 시에만 DB 조회)
      const dbSession = await prisma.session.findUnique({ where: { id: roomId }, select: { status: true } });
      if (dbSession?.status === 'ARCHIVED') {
        socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.SESSION_ENDED, message: "세션이 종료되어 입장할 수 없습니다" });
        return;
      }

      session = fetched;
    }

    // ✅ classId 불일치 차단
    if (classId && classId !== session.classId) {
      socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.CLASS_MISMATCH,
        message: "classId does not match session",
      });
      return;
    }

    // ✅ 세션이 특정 materialId를 고정한 경우, join 요청도 materialId가 일치해야 함
    const reqMaterialId =
      typeof materialId === "string" && materialId.trim() !== ""
        ? materialId.trim()
        : null;

    if (session.materialId) {
      // materialId 고정 세션인데 요청 materialId가 없으면 차단
      if (!reqMaterialId) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          code: ERRORS.PAYLOAD_INVALID,
          message: "MISSING_MATERIAL_ID",
        });
        return;
      }

      // materialId 불일치면 차단
      if (reqMaterialId !== session.materialId) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          code: ERRORS.FORBIDDEN,
          message: "MATERIAL_MISMATCH",
        });
        return;
      }
    }


    const studentsRoom = `${APP_CONFIG.SESSION_PREFIX}${roomId}:students`;
    const teachersRoom = `${APP_CONFIG.SESSION_PREFIX}${roomId}:teachers`;
    const roleRoom = socket.data.role === "teacher" ? teachersRoom : studentsRoom;

    if (socket.currentRoom) socket.leave(socket.currentRoom);

    socket.join(roleRoom);
    socket.currentRoom = roleRoom;
    socket.data.roomId = roomId;
    socket.data.classId = session.classId;
    socket.data.studentsRoom = studentsRoom;
    socket.data.teachersRoom = teachersRoom;
    socket.data.roleRoom = roleRoom;

    logger.info("✅join room success", {
      socketId: socket.id,
      userId: socket.data.userId,
      role: socket.data.role,
      roomId,
      joinedRoom: roleRoom,
      studentsRoom,
      teachersRoom,
    });

    socket.emit(SOCKET_EVENTS.JOIN_SUCCESS, {
      roomId,
      classId: session.classId,
      user: { userId: socket.data.userId, role: socket.data.role }
    });

    // ✅ #41: 캐시 저장 (캐시 미스였을 때만)
    if (!cacheHit) {
      const pipeline = redis.pipeline();
      pipeline.set(
        `user:${socket.data.userId}:lastSession`,
        JSON.stringify({ sessionId: roomId, classId: session.classId, materialId: session.materialId ?? null }),
        'EX',
        APP_CONFIG.USER_SESSION_CACHE_TTL,
      );
      // 세션에 입장한 전체 userId 추적 (나간 사람 포함, 종료 시 캐시 일괄 삭제용)
      pipeline.sadd(`session:${roomId}:users`, socket.data.userId);
      pipeline.expire(`session:${roomId}:users`, APP_CONFIG.USER_SESSION_CACHE_TTL);
      await pipeline.exec();
    }

    // ✅ #38: presence 입장 처리
    const sessionPresence = getSessionPresence(roomId);
    const meKey = userKeyOf(socket);

    // 중복 접속 처리: 같은 userId+role이 이미 접속 중이면 기존 소켓 끊기
    const existingSocketId = sessionPresence.get(meKey);
    if (existingSocketId && existingSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) oldSocket.disconnect(true);
      sessionPresence.delete(meKey);
    }

    // 현재 소켓 등록
    sessionPresence.set(meKey, socket.id);

    // 본인에게 현재 접속자 목록 전달
    socket.emit(SOCKET_EVENTS.PRESENCE_STATE, {
      roomId,
      users: buildPresenceList(roomId),
    });

    // 같은 세션의 학생/교사 룸 전체에 입장 브로드캐스트 (본인 제외)
    const { studentsRoom: sRoom, teachersRoom: tRoom } = getRoleRooms(roomId);
    socket.to(sRoom).to(tRoom).emit(SOCKET_EVENTS.PRESENCE_JOIN, {
      roomId,
      userId: socket.data.userId,
      role: socket.data.role,
    });

  });

  // ✅ sync:request (재접속 시 명시적 판서 상태 요청 → sync:state 응답)
  socket.on(SOCKET_EVENTS.SYNC_REQUEST, async () => {
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.NOT_JOINED,
        message: "NOT_JOINED",
      });
    }

    const roomId = socket.data.roomId;
    logger.info("sync:request received", {
      socketId: socket.id,
      userId: socket.data.userId,
      role: socket.data.role,
      roomId,
    });

    try {
      const wbKey = `whiteboard:${roomId}`;
      const raw = await redis.get(wbKey);
      let strokes = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
        } catch (e) {
          logger.warn("invalid whiteboard json on sync", { roomId, err: e?.message });
        }
      }
      socket.emit(SOCKET_EVENTS.SYNC_STATE, { strokes });
      logger.info("sync:state sent", { roomId, count: strokes.length });
    } catch (err) {
      logger.error("sync:state failed", { err: err?.message });
      socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.INTERNAL_ERROR,
        message: "SYNC_FAILED",
      });
    }
  });


  // ✅ teacher DM (학생만 받기)
  socket.on(SOCKET_EVENTS.TEACHER_SEND_DM, async ({ message }) => {
    if (!requireTeacher(socket)) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.FORBIDDEN, message: "Teacher role required" });
      return;
    }

    if (!requireJoined(socket)) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.NOT_JOINED, message: "Join room first" });
      return;
    }

    const roomId = socket.data.roomId;
    if (!roomId || !(await sessionStore.exists(roomId))) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.SESSION_NOT_FOUND, message: "Session not found" });
      return;
    }

    // ✅ 메시지 유효성 검사
    if (!message || typeof message !== "string") {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.INVALID_MESSAGE, message: "Invalid message" });
      return;
    }

    const trimmed = message.trim();

    if (!trimmed) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.INVALID_MESSAGE, message: "Invalid message" });
      return;
    }

    if (trimmed.length > 300) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.MESSAGE_TOO_LONG, message: "Message too long" });
      return;
    }

    // ✅ Redis Pub/Sub 기반 DM 전송 (다중 서버 대응)
    const payload = {
      from: "teacher",
      message: trimmed,
      ts: Date.now(),

      // ✅ sender 식별자 추가
      senderSocketId: socket.id,
      senderUserId: socket.data.userId,
    };

    try {
  // roomId는 prefix 없는 순수 sessionId
  await pubClient.publish(`dm-channel:${roomId}`, JSON.stringify(payload));

  // ✅ publish 성공 로그
  logger.info("📤pubsub dm published", {
  sessionId: roomId,
  roomId,
  fromUserId: socket.data.userId,
});


} catch (err) {
  logger.error("❌dm publish failed", { err: err?.message });
  socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.DM_PUBLISH_FAILED, message: "DM publish failed" });
}
  });

  // ✅ chat (보낸 사람 제외)
socket.on(SOCKET_EVENTS.SEND_MESSAGE, async (payload) => {
  const message = payload?.message;

  // 1) message 검증
  if (!isValidMessage(message)) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
  code: ERRORS.PAYLOAD_INVALID,
  message: "INVALID_MESSAGE_PAYLOAD",
});

  }

  // 2) join 여부 확인
  if (!requireJoined(socket)) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
  code: ERRORS.NOT_JOINED,
  message: "NOT_JOINED",
});

  }

  // 3) 세션 유효성 확인
  const roomId = socket.data.roomId;
  if (!roomId || !(await sessionStore.exists(roomId))) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
  code: ERRORS.SESSION_NOT_FOUND,
  message: "SESSION_NOT_FOUND",
});

  }

  // 4) 브로드캐스트 — 교사/학생 양쪽 룸으로 전송 (크로스룸 채팅 유지)
  const chatPayload = {
    message: message.trim(),
    sender: {
      userId: socket.data.userId,
      role: socket.data.role,
    },
    ts: Date.now(),
  };
  socket.to(socket.data.studentsRoom).to(socket.data.teachersRoom).emit(SOCKET_EVENTS.RECEIVE_MESSAGE, chatPayload);
});

// ✅ draw:append (ds: 시작, dm: 스트리밍, de: 종료)
socket.on(SOCKET_EVENTS.DRAW_APPEND, async (payload) => {
  if (!requireTeacher(socket)) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
      code: ERRORS.FORBIDDEN,
      message: "TEACHER_ONLY",
    });
  }

  if (!requireJoined(socket)) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
      code: ERRORS.NOT_JOINED,
      message: "NOT_JOINED",
    });
  }

  if (!payload || !VALID_DRAW_APPEND_TYPES.has(payload.e)) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
      code: ERRORS.PAYLOAD_INVALID,
      message: "INVALID_DRAW_APPEND_EVENT",
    });
  }

  const roomId = payload.r || socket.data.roomId;
  if (roomId !== socket.data.roomId) {
    return socket.emit(SOCKET_EVENTS.ERROR, {
      code: ERRORS.PAYLOAD_INVALID,
      message: "ROOM_MISMATCH",
    });
  }

  const { e } = payload;

  if (e === "ds") {
    if (typeof payload.sId !== "number" ||
        typeof payload.x !== "number" || payload.x < 0 || payload.x > 1 ||
        typeof payload.y !== "number" || payload.y < 0 || payload.y > 1 ||
        typeof payload.c !== "string" || !payload.c ||
        typeof payload.w !== "number" || payload.w <= 0) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DS_PAYLOAD",
      });
    }
    // ✅ #74: ds 데이터를 pendingStrokes에 임시 보관 (de 완성 시 Redis 저장에 사용)
    const sid = socket.data.roomId;
    if (!pendingStrokes.has(sid)) pendingStrokes.set(sid, new Map());
    pendingStrokes.get(sid).set(payload.sId, {
      sId: payload.sId, x: payload.x, y: payload.y, c: payload.c, w: payload.w,
    });
  }

  if (e === "dm") {
    if (typeof payload.sId !== "number" ||
        typeof payload.x !== "number" || payload.x < 0 || payload.x > 1 ||
        typeof payload.y !== "number" || payload.y < 0 || payload.y > 1 ||
        (payload.p !== undefined && (typeof payload.p !== "number" || payload.p < 0 || payload.p > 1))) {
      return; // drop: 고빈도 이벤트이므로 에러 응답 생략
    }
  }

  if (e === "de") {
    if (typeof payload.sId !== "number") {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DE_PAYLOAD",
      });
    }
    if (payload.pts !== undefined && !Array.isArray(payload.pts)) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DE_PAYLOAD",
      });
    }
  }

  socket.to(socket.data.studentsRoom).emit(SOCKET_EVENTS.DRAW_APPEND, {
    ...payload,
    senderUserId: socket.data.userId,
    senderRole: socket.data.role,
    t: getNextTick(socket.data.studentsRoom),
    ts: Date.now(),
  });

  logger.info("📐draw:append broadcast", {
    fromUserId: socket.data.userId,
    roomId: socket.data.roomId,
    studentsRoom: socket.data.studentsRoom,
    e: payload.e,
    sId: payload.sId,
  });

  // ✅ #74: de 시 whiteboard Redis 저장 (string/JSON: { strokes: [...] })
  if (e === "de") {
    const sessionId = socket.data.roomId;
    const wbKey = `whiteboard:${sessionId}`;
    try {
      const dsData = pendingStrokes.get(sessionId)?.get(payload.sId);
      const newStroke = {
        sId: payload.sId,
        x: dsData?.x ?? 0,
        y: dsData?.y ?? 0,
        c: dsData?.c ?? "#000000",
        w: dsData?.w ?? 2,
        pts: Array.isArray(payload.pts) ? payload.pts : [],
      };

      // 락 획득 후 GET → parse → upsert → SET (원자적 보장)
      await withWhiteboardLock(sessionId, async () => {
        const raw = await redis.get(wbKey);
        let strokes = [];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
          } catch (_) { /* 깨진 데이터면 빈 배열로 초기화 */ }
        }
        const idx = strokes.findIndex((s) => s.sId === payload.sId);
        if (idx >= 0) strokes[idx] = newStroke;
        else strokes.push(newStroke);
        await redis.set(wbKey, JSON.stringify({ strokes }), "EX", APP_CONFIG.SESSION_TTL_SECONDS);
      });

      pendingStrokes.get(sessionId)?.delete(payload.sId);
    } catch (err) {
      logger.error("whiteboard store update failed", { e, err: err?.message });
    }
  }
});


  // ✅ draw:clear (un: 실행취소, er: 지우개)
  socket.on(SOCKET_EVENTS.DRAW_CLEAR, async (payload) => {
    if (!requireTeacher(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.FORBIDDEN,
        message: "TEACHER_ONLY",
      });
    }

    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.NOT_JOINED,
        message: "NOT_JOINED",
      });
    }

    if (!payload || typeof payload.sId !== "number" ||
        (payload.e !== "un" && payload.e !== "er")) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DRAW_CLEAR_PAYLOAD",
      });
    }

    socket.to(socket.data.studentsRoom).emit(SOCKET_EVENTS.DRAW_CLEAR, {
      e: payload.e,
      sId: payload.sId,
      senderUserId: socket.data.userId,
      t: getNextTick(socket.data.studentsRoom),
      ts: Date.now(),
    });

    const sessionId = socket.data.roomId;
    const wbKey = `whiteboard:${sessionId}`;
    try {
      // 락 획득 후 GET → parse → filter → SET (원자적 보장)
      await withWhiteboardLock(sessionId, async () => {
        const raw = await redis.get(wbKey);
        let strokes = [];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
          } catch (_) { /* 깨진 데이터면 빈 배열 */ }
        }
        strokes = strokes.filter((s) => s.sId !== payload.sId);
        await redis.set(wbKey, JSON.stringify({ strokes }), "EX", APP_CONFIG.SESSION_TTL_SECONDS);
      });
      pendingStrokes.get(sessionId)?.delete(payload.sId);
    } catch (err) {
      logger.error("whiteboard clear failed", { err: err?.message });
    }
  });

  // ✅ #38: disconnecting - 룸이 비워지기 전에 presence:leave 브로드캐스트
  socket.on("disconnecting", (reason) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const sessionPresence = presenceBySession.get(roomId);
    if (!sessionPresence) return;

    const meKey = userKeyOf(socket);
    const existingSocketId = sessionPresence.get(meKey);

    // 현재 끊기는 소켓이 등록된 소켓일 때만 제거 (중복 접속 race 방어)
    if (existingSocketId === socket.id) {
      sessionPresence.delete(meKey);
      if (sessionPresence.size === 0) presenceBySession.delete(roomId);

      const { studentsRoom: sRoom, teachersRoom: tRoom } = getRoleRooms(roomId);
      socket.to(sRoom).to(tRoom).emit(SOCKET_EVENTS.PRESENCE_LEAVE, {
        roomId,
        userId: socket.data.userId,
        role: socket.data.role,
        reason,
      });
    }
  });

  // ✅ disconnect
  socket.on("disconnect", () => {
    logger.info("socket disconnected", { socketId: socket.id });
    // studentsRoom이 비면 tick 카운터 및 pendingStrokes 정리
    const studentsRoom = socket.data?.studentsRoom;
    if (studentsRoom) {
      const sRoom = io.sockets.adapter.rooms.get(studentsRoom);
      if (!sRoom || sRoom.size === 0) {
        roomDrawTick.delete(studentsRoom);
        pendingStrokes.delete(socket.data.roomId);
      }
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info("🚀server started", { url: `http://localhost:${PORT}` });
  });
}

module.exports = { app, server, io };
