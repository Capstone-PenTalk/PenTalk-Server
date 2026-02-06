require('dotenv').config();
console.log("REDIS_URL =", process.env.REDIS_URL);


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


// ✅ 가드 헬퍼 함수
function requireTeacher(socket) {
  return socket.data.role === "teacher";
}

function requireJoined(socket) {
  return !!socket.currentRoom && !!socket.data.classId;
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: APP_CONFIG.CORS_ORIGIN }
});

// 1) dm-channel:* 패턴 구독
subClient.psubscribe("dm-channel:*", (err, count) => {
  if (err) {
    console.error("❌ psubscribe failed:", err);
    return;
  }
  console.log(`📡 psubscribed to dm-channel:* (count=${count})`);
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

    console.log("📨 [PUBSUB DM] broadcast", {
      channel,
      toRoom: roomName,
      senderUserId: payload?.senderUserId,
      message: payload?.message,
    });
  } catch (e) {
    console.error("❌ [PUBSUB DM] invalid message:", e);
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

const PORT = process.env.PORT || APP_CONFIG.PORT;

app.post('/auth/dev-login', (req, res) => {
  const { userId, role } = req.body;

  if (!userId || !role || !['teacher','student'].includes(role)) {
    return res.status(400).json({ message: 'INVALID_INPUT' });
  }

  const token = signToken({ userId, role });
  res.json({ token, user: { userId, role } });

});


app.post(ROUTES.SESSION_CREATE, async (req, res) => {
  const { classId } = req.body;

  if (!classId || typeof classId !== "string" || classId.trim() === "") {
    return res.status(400).json({ message: "MISSING_CLASS_ID" });
  }

  const sessionId = uuidv4();

  const sessionData = {
    id: sessionId,
    classId: classId.trim(),
    createdAt: Date.now(),
  };

  await sessionStore.create(sessionId, sessionData);

  console.log("세션 생성:", sessionId, "classId:", sessionData.classId);

  const clientOrigin = process.env.CLIENT_ORIGIN || APP_CONFIG.CORS_ORIGIN || "http://localhost:5173";
  const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS || 21600);

  res.json({
    sessionId,
    joinUrlTeacher: `${clientOrigin}/?sessionId=${sessionId}&role=teacher`,
    joinUrlStudent: `${clientOrigin}/?sessionId=${sessionId}&role=student`,
    ttlSeconds,
  });
});


/**
 * ✅ Socket.IO 연결
 */
io.on('connection', (socket) => {

  console.log("유저 접속:", socket.id, "userId:", socket.data.userId, "role:", socket.data.role);

  socket.currentRoom = null;

  // ✅ join-room
  socket.on(SOCKET_EVENTS.JOIN_ROOM, async ({ roomId }) => {
    console.log("📌 JOIN_ROOM 요청:", { socketId: socket.id, role: socket.data.role, roomId });

    if (!roomId) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "MISSING_ROOM_ID" });
      return;
    }

    const session = await sessionStore.get(roomId);
    if (!session) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "SESSION_NOT_FOUND" });
      return;
    }

    const newRoom = `${APP_CONFIG.SESSION_PREFIX}${roomId}`;

    if (socket.currentRoom) socket.leave(socket.currentRoom);

    socket.join(newRoom);
    socket.currentRoom = newRoom;
    socket.data.roomId = roomId;

    // ✅ 추가: 세션에서 classId 주입
    socket.data.classId = session.classId;

    console.log("✅ JOIN_ROOM 성공:", { socketId: socket.id, joined: newRoom, classId: session.classId });

    socket.emit(SOCKET_EVENTS.JOIN_SUCCESS, {
      roomId,
      classId: session.classId,
      user: { userId: socket.data.userId, role: socket.data.role }
    });
  });


  // ✅ teacher DM (학생만 받기)
  socket.on(SOCKET_EVENTS.TEACHER_SEND_DM, async ({ message }) => {
    if (!requireTeacher(socket)) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "FORBIDDEN" });
      return;
    }

    if (!requireJoined(socket)) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "NOT_JOINED" });
      return;
    }

    const roomId = socket.data.roomId;
    if (!roomId || !(await sessionStore.exists(roomId))) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "SESSION_NOT_FOUND" });
      return;
    }

    // ✅ 메시지 유효성 검사
    if (!message || typeof message !== "string") {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "INVALID_MESSAGE" });
      return;
    }

    const trimmed = message.trim();

    if (!trimmed) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "INVALID_MESSAGE" });
      return;
    }

    if (trimmed.length > 300) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "MESSAGE_TOO_LONG" });
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
  console.log("📤 [PUBSUB DM] published", {
    channel: `dm-channel:${roomId}`,
    message: payload.message,
    from: socket.data.userId,
  });

} catch (err) {
  console.error("❌ DM publish failed:", err);
  socket.emit(SOCKET_EVENTS.ERROR, { code: "DM_PUBLISH_FAILED" });
}
  });

  // ✅ chat (보낸 사람 제외)
  socket.on(SOCKET_EVENTS.SEND_MESSAGE, async ({ msg }) => {
    if (!requireJoined(socket)) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "NOT_JOINED" });
      return;
    }

    const roomId = socket.data.roomId;
    if (!roomId || !(await sessionStore.exists(roomId))) {
      socket.emit(SOCKET_EVENTS.ERROR, { code: "SESSION_NOT_FOUND" });
      return;
    }

    socket.to(socket.currentRoom).emit(SOCKET_EVENTS.RECEIVE_MESSAGE, msg);
  });

  // ✅ disconnect
  socket.on("disconnect", () => {
    console.log("연결 종료:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
