const { logger } = require("./utils/logger");
const { ERRORS } = require("../config/errors");
const { sendHttpError } = require("./utils/httpError");
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();


require('dotenv').config();
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
const MAX_MESSAGE_LEN = 300;



function isValidMessage(msg) {
  if (typeof msg !== "string") return false;

  const trimmed = msg.trim();
  if (!trimmed) return false;

  if (trimmed.length > MAX_MESSAGE_LEN) return false;

  return true;
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

// 2) 메시지 수신 → 해당 room(sessionId)로 브로드캐스트
subClient.on("pmessage", (pattern, channel, message) => {
  try {
    // channel 예: dm-channel:abc123
    const sessionId = channel.split(":")[1];
    if (!sessionId) return;

    const payload = JSON.parse(message);

    const roomName = `${APP_CONFIG.SESSION_PREFIX}${sessionId}`;
    
    const senderSocketId = payload?.senderSocketId;

    if (senderSocketId && io.sockets.sockets.has(senderSocketId)) {
      io.to(roomName).except(senderSocketId).emit(SOCKET_EVENTS.RECEIVE_DM, payload);
    } else {
      io.to(roomName).emit(SOCKET_EVENTS.RECEIVE_DM, payload);
    }

    logger.info("📨pubsub dm broadcast", {
    channel,
    channelSessionId: sessionId,
    roomName,
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
      return next(new Error("UNAUTHORIZED")); // 토큰 없음
    }

    const payload = verifyToken(token); // { userId, role }

    if (!payload?.userId || !payload?.role) {
      return next(new Error("UNAUTHORIZED")); // payload 이상
    }

    // ✅ JWT에서만 가져옴
    socket.data.userId = payload.userId;
    socket.data.role = payload.role;

    return next();
  } catch (err) {
    return next(new Error("UNAUTHORIZED")); // 토큰 검증 실패
  }
});


app.use(cors({
  origin: APP_CONFIG.CORS_ORIGIN,
}));

app.use(express.json());
app.use(express.static(APP_CONFIG.STATIC_DIR));

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

/**
 * ✅ Day11: materials 검색/필터링 리스트 API (schema.prisma 기준)
 * GET /materials?classId=&subjectId=&keyword=
 *
 * - classId: 필수
 * - subjectId: 선택 (MaterialSubject 조인 필터)
 * - keyword: 선택 (현재 schema에 title/description 없음 → type/url로만 최소 검색)
 *
 * 응답:
 * { items: [{ id,type,url,classId,createdAt,subjects:[{id,name}]}], count }
 */
app.get("/materials", async (req, res) => {

  console.log(">>> HIT /materials", req.query);


  try {
    const classId = (req.query.classId || "").toString().trim();
    const subjectId = (req.query.subjectId || "").toString().trim();
    const keyword = (req.query.keyword || "").toString().trim();

    // 1) validation
    if (!classId) {
      return res.status(400).json({
        code: "MISSING_CLASS_ID",
        message: "classId is required",
        items: [],
        count: 0,
      });
    }

    // 2) where 구성 (Material 기준)
    /** @type {any} */
    const where = { classId };

    // subject 필터: MaterialSubject 조인 테이블을 통해 필터링
    if (subjectId) {
      where.subjects = {
        some: { subjectId },
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

    // 3) 조회 + subject 이름까지 포함
    const items = await prisma.material.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        subjects: {
          include: {
            subject: { select: { id: true, name: true } },
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


    const session = await sessionStore.get(roomId);
    if (!session) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.SESSION_NOT_FOUND, message: "Session not found" });
      return;
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


    const newRoom = `${APP_CONFIG.SESSION_PREFIX}${roomId}`;

    if (socket.currentRoom) socket.leave(socket.currentRoom);

    socket.join(newRoom);
    socket.currentRoom = newRoom;
    socket.data.roomId = roomId;

    // ✅ 추가: 세션에서 classId 주입
    socket.data.classId = session.classId;

    logger.info("✅join room success",{
      socketId: socket.id,
      roomId: newRoom,
      classId: session.classId,
    });

    socket.emit(SOCKET_EVENTS.JOIN_SUCCESS, {
      roomId,
      classId: session.classId,
      user: { userId: socket.data.userId, role: socket.data.role }
    });
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

  // 4) 브로드캐스트 (객체)
  socket.to(socket.currentRoom).emit(SOCKET_EVENTS.RECEIVE_MESSAGE, {
    message: message.trim(),
    sender: {
      userId: socket.data.userId,
      role: socket.data.role,
    },
    ts: Date.now(),
  });
});

  // ✅ disconnect
  socket.on("disconnect", () => {
    logger.info("socket disconnected", { socketId: socket.id });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info("🚀server started", { url: `http://localhost:${PORT}` });
  });
}

module.exports = { app, server, io };
