require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { logger } = require("./utils/logger");
const { ERRORS } = require("../config/errors");
const { sendHttpError } = require("./utils/httpError");
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { PDFDocument, rgb } = require('pdf-lib');

const WHITEBOARD_DIR = path.join(__dirname, '..', 'storage', 'whiteboards');
const { upload, saveFile } = require('./upload/uploadStorage'); // ✅ #93


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
const { randomUUID } = require("crypto");
const MAX_MESSAGE_LEN = 300;
const MAX_POLL_DURATION = 300;     // ✅ #51: 투표 최대 지속 시간 (초)
const MAX_QUESTION_LENGTH = 500;   // ✅ #54: 질문 최대 길이 (자)
const VALID_DRAW_APPEND_TYPES = new Set(["ds", "dm", "de"]);

// ✅ #61: export 제한값
const EXPORT_CONFIG = {
  MAX_STUDENT_STROKES: 3000,    // 학생 필기 최대 stroke 수
  MAX_POINTS_PER_STROKE: 1000,  // stroke당 최대 point 수 (렌더링 단계에서 slice)
  MAX_TOTAL_POINTS: 50_000,     // 전체 point 수 상한 (메모리/CPU 보호)
  PDF_FETCH_TIMEOUT_MS: 10_000, // 원본 PDF fetch timeout (ms)
  // 전체 export timeout은 nginx 레벨에서 제어
};

// ✅ #45: 펜 스타일 설정 상수
const PEN_CONFIG = {
  DEFAULT_COLOR: "#000000",
  DEFAULT_WIDTH: 2,
  MAX_WIDTH: 50, // 프론트 UI 펜 굵기 허용 범위 상한 (픽셀 기준)
  HEX_RE: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
};

// ✅ #45: 구형 stroke 데이터(c/w 없음) 정규화
function normalizeStroke(s) {
  if (!s) return s;
  const normalized = {
    ...s,
    c: (typeof s.c === "string" && PEN_CONFIG.HEX_RE.test(s.c)) ? s.c : PEN_CONFIG.DEFAULT_COLOR,
    w: (typeof s.w === "number" && s.w > 0 && s.w <= PEN_CONFIG.MAX_WIDTH) ? s.w : PEN_CONFIG.DEFAULT_WIDTH,
  };
  if (!(Number.isInteger(s.page) && s.page >= 1)) {
    delete normalized.page;
  }
  return normalized;
}

// ✅ #61: hex 색상 → pdf-lib rgb 변환 (#RGB, #RRGGBB 모두 지원)
function hexToRgbPdf(hex) {
  let clean = (typeof hex === 'string' ? hex : '#000000').replace('#', '');
  if (clean.length === 3) {
    clean = clean[0]+clean[0]+clean[1]+clean[1]+clean[2]+clean[2];
  }
  if (clean.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(clean)) return rgb(0, 0, 0);
  return rgb(
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  );
}

// ✅ #61: Flutter Color.value (ARGB int) → pdf-lib rgb 변환
function argbIntToRgbPdf(argb) {
  const v = argb >>> 0;
  return rgb(
    ((v >> 16) & 0xFF) / 255,
    ((v >> 8)  & 0xFF) / 255,
    (v         & 0xFF) / 255,
  );
}

// ✅ #61: stroke color 필드 정규화 (hex string 또는 Flutter ARGB int 모두 처리)
function resolveStrokeColor(stroke) {
  // hex string: c 필드 (서버 저장 형식)
  if (typeof stroke.c === 'string' && PEN_CONFIG.HEX_RE.test(stroke.c)) {
    return hexToRgbPdf(stroke.c);
  }
  // Flutter Color.value int: color 필드 (클라이언트 미변환 시 방어)
  if (typeof stroke.color === 'number' && Number.isInteger(stroke.color)) {
    return argbIntToRgbPdf(stroke.color);
  }
  return rgb(0, 0, 0);
}

// ✅ #61: stroke width 필드 정규화 (w 또는 width 모두 처리)
function resolveStrokeWidth(stroke) {
  const w = stroke.w ?? stroke.width;
  return (typeof w === 'number' && w > 0 && w <= PEN_CONFIG.MAX_WIDTH)
    ? w
    : PEN_CONFIG.DEFAULT_WIDTH;
}

// ✅ #74: room별 진행 중인 stroke 임시 저장 (ds → de 완성 전까지)
// Map<sessionId, Map<sId, {sId, x, y, c, w}>>
const pendingStrokes = new Map();

// ✅ #38: presence 자료구조 (sessionId -> Map(userKey -> socketId))
const presenceBySession = new Map();

// ✅ #42: 종료된 세션 Set (draw 이벤트 차단용)
const archivedSessions = new Set();

// ✅ #51: 세션별 진행 중인 투표 상태
// sessionId → {
//   pollId, question, options, duration,
//   startedAt, startedBy,
//   answers: Map(userId → optionId),
//   counts: { [optionId]: number },
//   timer: TimeoutId | null
// }
// ※ studentsRoom / teachersRoom은 저장하지 않음.
//   endPoll은 setTimeout에서 호출될 수 있으므로 getRoleRooms(sessionId)로 직접 계산.
const activePolls = new Map();

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

// ✅ #44: room별 draw tick 카운터 (de 이벤트 기준, 재연결 시 Redis meta에서 복원)
const roomDrawTick = new Map();
const tickInitPromise = new Map(); // single-flight: 동시 초기화 중복 방지

async function getNextTick(roomId) {
  if (!roomDrawTick.has(roomId)) {
    // 이미 초기화 중인 Promise가 없을 때만 생성 (single-flight)
    // has() → set() 사이에 await 없으므로 동시 분기 진입 불가
    if (!tickInitPromise.has(roomId)) {
      const p = (async () => {
        let base = 0;
        try {
          const rawMeta = await redis.get(`whiteboardMeta:${roomId}`);
          if (rawMeta) {
            const parsed = JSON.parse(rawMeta);
            base = Number.isInteger(parsed?.serverTick) ? parsed.serverTick : 0;
          }
        } catch (err) {
          logger.error("Failed to restore tick from Redis", { roomId, err: err?.message });
        }
        roomDrawTick.set(roomId, base);
      })().finally(() => {
        // finally: 성공/실패 모두 정리 (await 뒤 delete보다 안전)
        tickInitPromise.delete(roomId);
      });
      tickInitPromise.set(roomId, p);
    }
    await tickInitPromise.get(roomId);
  }

  // await 없음 → 동기 실행 → 중복 tick 없음
  const next = (roomDrawTick.get(roomId) ?? 0) + 1;
  roomDrawTick.set(roomId, next);
  return next;
}

// ✅ 가드 헬퍼 함수
function requireTeacher(socket) {
  return socket.data.role === "teacher";
}

// ✅ #51
function requireStudent(socket) {
  return socket.data.role === "student";
}

function requireJoined(socket) {
  return !!socket.currentRoom && !!socket.data.roomId && !!socket.data.classId;
}

// ✅ #51: option 배열 유효성 검사
// - 2~4개, id는 string|number, text는 비어있지 않은 문자열, id 중복 없음
function isValidPollOptions(options) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return false;
  const seenIds = new Set();
  for (const o of options) {
    if (typeof o.id !== "string" && typeof o.id !== "number") return false;
    if (typeof o.text !== "string" || !o.text.trim()) return false;
    if (seenIds.has(o.id)) return false;
    seenIds.add(o.id);
  }
  return true;
}

/// ✅ #55: 익명 여부에 따라 askedBy 구성
// userId: null → 익명 사용자 (프론트에서 "익명" 등으로 표시). 문구/아이콘 결정은 클라이언트 담당
function resolveAskedBy(userId, isAnonymous) {
  return isAnonymous
    ? { userId: null, isAnonymous: true }
    : { userId, isAnonymous: false };
}

// ✅ #51: 투표 종료 공통 처리 (타이머 만료 / 교사 조기 종료 / 세션 종료 모두 이 경로)
function endPoll(io, sessionId) {
  const poll = activePolls.get(sessionId);
  if (!poll) return;

  // 중복 종료 방지를 위해 상태 삭제를 브로드캐스트보다 먼저 수행
  if (poll.timer) clearTimeout(poll.timer);
  activePolls.delete(sessionId);

  const { studentsRoom, teachersRoom } = getRoleRooms(sessionId);

  io.to(studentsRoom).to(teachersRoom).emit(SOCKET_EVENTS.POLL_END, {
    pollId: poll.pollId,
    counts: { ...poll.counts },
    total: poll.answers.size,
  });

  logger.info("📊 poll ended", {
    sessionId,
    pollId: poll.pollId,
    total: poll.answers.size,
  });
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

// ✅ #93: 업로드된 PDF 정적 파일 서빙
// ⚠️ 현재 인증 없이 URL만 알면 누구나 접근 가능. 향후 S3 전환 시 signed URL로 대체 예정.
app.use('/pdfs', express.static(path.join(__dirname, '..', 'storage', 'pdfs')));

// ✅ #61: PDF export
// global body parser(100kb) 적용 전 실행되도록 app.use(express.json()) 앞에 위치
app.post('/export/pdf', express.json({ limit: '5mb' }), requireAuth, async (req, res) => {
  const exportStart = Date.now();
  try {
    const { sessionId, strokes: rawStudentStrokes } = req.body;

    // ── 1. 입력 검증 ──────────────────────────────────────────────
    if (!sessionId || typeof sessionId !== 'string') {
      return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, 'SESSION_ID_REQUIRED');
    }
    // strokes 없으면 [] 처리 / 있는데 배열 아니면 400
    if (rawStudentStrokes !== undefined && !Array.isArray(rawStudentStrokes)) {
      return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, 'STROKES_MUST_BE_ARRAY');
    }
    const studentStrokes = rawStudentStrokes ?? [];
    if (studentStrokes.length > EXPORT_CONFIG.MAX_STUDENT_STROKES) {
      return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, 'TOO_MANY_STROKES');
    }
    const totalPoints = studentStrokes.reduce((sum, s) => sum + (Array.isArray(s?.points) ? s.points.length : 0), 0);
    if (totalPoints > EXPORT_CONFIG.MAX_TOTAL_POINTS) {
      return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, 'TOO_MANY_POINTS');
    }

    // ── 2. 세션 + material 조회 ───────────────────────────────────
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { material: { select: { url: true } } },
    });
    if (!session) {
      return sendHttpError(res, 404, ERRORS.SESSION_NOT_FOUND, 'SESSION_NOT_FOUND');
    }
    if (!session.material?.url) {
      return sendHttpError(res, 400, ERRORS.MATERIAL_NOT_FOUND, 'MATERIAL_NOT_FOUND');
    }

    // ── 3. 권한 검증: 세션 소속 클래스 멤버인지 확인 ──────────────
    // 현재 정책: classMember 확인 (teacher/student 구분 없이 동일 엔드포인트)
    // session-level 참가 이력 검증은 이번 범위 외
    const membership = await prisma.classMember.findFirst({
      where: { classId: session.classId, userId: req.userId },
      select: { id: true },
    });
    if (!membership) {
      return sendHttpError(res, 403, ERRORS.FORBIDDEN, 'NOT_SESSION_MEMBER');
    }

    // ── 4. 교사 판서 읽기 ─────────────────────────────────────────
    let teacherStrokes = [];

    if (session.status === 'ARCHIVED') {
      if (session.drawingPath) {
        // ARCHIVED + drawingPath 있음: 파일이 기준 데이터 → 실패 시 명시적 500
        try {
          const raw = await fs.promises.readFile(session.drawingPath, 'utf8');
          const data = JSON.parse(raw);
          teacherStrokes = Array.isArray(data?.strokes) ? data.strokes : [];
        } catch (e) {
          logger.error('export: archived teacher strokes file read failed', {
            sessionId,
            drawingPath: session.drawingPath,
            err: e?.message,
          });
          return sendHttpError(res, 500, ERRORS.PDF_EXPORT_FAILED, 'TEACHER_STROKES_UNAVAILABLE');
        }
      }
      // ARCHIVED + drawingPath null: 판서 없이 저장된 세션 → soft fail, 그대로 진행
    } else {
      // ACTIVE / CLOSING: Redis 조회 → miss는 soft fail (TTL 만료 등 가능)
      try {
        const raw = await redis.get(`whiteboard:${sessionId}`);
        if (raw) {
          try {
            const data = JSON.parse(raw);
            teacherStrokes = Array.isArray(data?.strokes) ? data.strokes : [];
          } catch (e) {
            // Redis 파싱 실패: soft fail (교사 판서 없이 진행)
            logger.warn('export: teacher strokes redis parse failed', { sessionId, err: e?.message });
          }
        }
      } catch (e) {
        // Redis 연결 에러: soft fail (교사 판서 없이 진행)
        logger.warn('export: redis get failed', { sessionId, err: e?.message });
      }
    }

    // 기존 normalizeStroke 규칙 적용 (c/w/page 누락된 legacy 데이터 보정)
    teacherStrokes = teacherStrokes.map(normalizeStroke);

    // tick 오름차순 정렬 (t 없는 legacy stroke는 0 취급 → 앞쪽 배치)
    // t가 없는 데이터는 정확한 순서를 알 수 없으므로 유효 tick stroke 앞에 배치
    teacherStrokes.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

    // ── 5. 원본 PDF fetch (timeout 포함) ──────────────────────────
    // 현재는 material.url 직접 fetch. 추후 스토리지 서명 URL 유틸로 분리 가능.
    const fetchController = new AbortController();
    const fetchTimeout = setTimeout(
      () => fetchController.abort(),
      EXPORT_CONFIG.PDF_FETCH_TIMEOUT_MS,
    );
    let pdfBuffer;
    try {
      const pdfRes = await fetch(session.material.url, { signal: fetchController.signal });
      if (!pdfRes.ok) {
        return sendHttpError(res, 502, ERRORS.PDF_FETCH_FAILED, 'PDF_FETCH_FAILED');
      }
      pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    } catch (e) {
      if (e.name === 'AbortError') {
        return sendHttpError(res, 504, ERRORS.PDF_FETCH_FAILED, 'PDF_FETCH_TIMEOUT');
      }
      return sendHttpError(res, 502, ERRORS.PDF_FETCH_FAILED, 'PDF_FETCH_FAILED');
    } finally {
      clearTimeout(fetchTimeout);
    }

    // ── 6. PDF 로드 ───────────────────────────────────────────────
    let pdfDoc;
    try {
      pdfDoc = await PDFDocument.load(pdfBuffer);
    } catch (e) {
      logger.warn('export: pdf-lib load failed', { sessionId, err: e?.message });
      return sendHttpError(res, 502, ERRORS.PDF_FETCH_FAILED, 'PDF_INVALID');
    }
    const totalPages = pdfDoc.getPageCount();

    // ── 7. 학생 stroke 1차 필터링 ────────────────────────────────
    // - points 1개 이하: 선분 불가 → skip
    // - tool === 'eraser': skip (클라이언트가 이미 제거 후 전송하므로 방어적 처리)
    // page 범위/좌표 유효성은 렌더링 단계(2차)에서 처리
    const validStudentStrokes = studentStrokes.filter(s =>
      s &&
      Array.isArray(s.points) &&
      s.points.length > 1 &&
      s.tool !== 'eraser'
    );

    // ── 8. 렌더링 순서 결정 및 page별 그룹핑 ─────────────────────
    // 교사 판서(tick 오름차순) → 학생 필기(body 순서)
    // 학생 필기가 항상 교사 판서 위에 렌더링됨
    const allStrokes = [...teacherStrokes, ...validStudentStrokes];

    const strokesByPage = new Map();
    for (const stroke of allStrokes) {
      const pageNum = stroke.page;
      if (!Number.isInteger(pageNum) || pageNum < 1) {
        logger.warn('export: stroke skipped (invalid page)', { sessionId, page: pageNum });
        continue;
      }
      const pageIdx = pageNum - 1;
      if (pageIdx >= totalPages) {
        logger.warn('export: stroke skipped (page out of range)', { sessionId, pageNum, totalPages });
        continue;
      }
      if (!strokesByPage.has(pageIdx)) strokesByPage.set(pageIdx, []);
      strokesByPage.get(pageIdx).push(stroke);
    }

    // ── 9. 판서 합성 ──────────────────────────────────────────────
    for (const [pageIdx, strokes] of strokesByPage) {
      const page = pdfDoc.getPage(pageIdx);
      const { width: pageW, height: pageH } = page.getSize();

      for (const stroke of strokes) {
        const color = resolveStrokeColor(stroke);
        const baseWidth = resolveStrokeWidth(stroke);
        const pts = stroke.points.slice(0, EXPORT_CONFIG.MAX_POINTS_PER_STROKE);

        for (let i = 0; i < pts.length - 1; i++) {
          const p1 = pts[i];
          const p2 = pts[i + 1];

          // NaN / Infinity / 비숫자 좌표: 해당 선분만 skip
          if (
            typeof p1.x !== 'number' || !isFinite(p1.x) ||
            typeof p1.y !== 'number' || !isFinite(p1.y) ||
            typeof p2.x !== 'number' || !isFinite(p2.x) ||
            typeof p2.y !== 'number' || !isFinite(p2.y)
          ) continue;

          // 0~1 범위 벗어난 좌표: skip 대신 clamp
          const x1 = Math.min(1, Math.max(0, p1.x));
          const y1 = Math.min(1, Math.max(0, p1.y));
          const x2 = Math.min(1, Math.max(0, p2.x));
          const y2 = Math.min(1, Math.max(0, p2.y));

          // 필압 적용: p=0 → 0.5배, p=1 → 1.0배
          const pressure = typeof p1.p === 'number' && isFinite(p1.p)
            ? Math.min(1, Math.max(0, p1.p))
            : 0.5;
          const thickness = baseWidth * (0.5 + pressure * 0.5);

          // 좌표 변환: 정규화(0~1) → PDF pt
          // y축 반전: Flutter 좌상단 원점(y↓) → PDF 좌하단 원점(y↑)
          page.drawLine({
            start: { x: x1 * pageW, y: (1 - y1) * pageH },
            end:   { x: x2 * pageW, y: (1 - y2) * pageH },
            thickness,
            color,
            opacity: 1,
          });
        }
      }
    }

    // ── 10. PDF 반환 ──────────────────────────────────────────────
    const pdfBytes = await pdfDoc.save();
    const buf = Buffer.from(pdfBytes);

    // 파일명은 sessionId 기반 (한글 파일명 인코딩 문제 방지)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="export_${sessionId}.pdf"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);

    logger.info('pdf export success', {
      sessionId,
      userId: req.userId,
      teacherStrokeCount: teacherStrokes.length,
      studentStrokeCount: validStudentStrokes.length,
      totalPages,
      durationMs: Date.now() - exportStart,
    });

  } catch (err) {
    const sid = req?.body?.sessionId ?? null;
    logger.error('pdf export failed', { sessionId: sid, err: err?.message });
    if (!res.headersSent) {
      return sendHttpError(res, 500, ERRORS.PDF_EXPORT_FAILED, 'PDF_EXPORT_FAILED');
    }
  }
});

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

// ✅ #93: orphan 파일 cleanup helper
// multer가 디스크에 먼저 저장하므로, 이후 검증/DB 저장 실패 시 반드시 파일을 삭제해야 함.
// 삭제 실패도 로그로 관측.
function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err) logger.warn('uploaded file cleanup failed', { filePath, err: err.message });
  });
}

// ✅ #93: PDF 수업자료 업로드
// POST /materials/pdf
// multipart/form-data: file(pdf 파일), classId(string)
app.post(
  ROUTES.MATERIAL_UPLOAD,
  requireAuth,
  requireTeacherRole,
  // multer 에러(FILE_TYPE_INVALID, LIMIT_FILE_SIZE)를 next(err)로 전달하기 위해 콜백 패턴 사용
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, 'FILE_REQUIRED');
    }

    const filePath = req.file.path;

    const classId = (req.body.classId || '').toString().trim();
    if (!classId) {
      safeUnlink(filePath);
      return sendHttpError(res, 400, ERRORS.PAYLOAD_INVALID, 'CLASS_ID_REQUIRED');
    }

    // classId 검증부터 prisma.create까지 하나의 try로 묶음.
    // findUnique 포함 DB 접근에서 예외가 나도 cleanup이 보장됨.
    try {
      const foundClass = await prisma.class.findUnique({
        where: { id: classId },
        select: { id: true, teacherId: true },
      });
      if (!foundClass) {
        safeUnlink(filePath);
        return sendHttpError(res, 404, ERRORS.CLASS_NOT_FOUND, 'CLASS_NOT_FOUND');
      }
      if (foundClass.teacherId !== req.userId) {
        safeUnlink(filePath);
        return sendHttpError(res, 403, ERRORS.FORBIDDEN, 'NOT_CLASS_TEACHER');
      }

      const { url } = await saveFile(req, req.file);

      const material = await prisma.material.create({
        data: {
          type: 'pdf',
          url,
          name: req.file.originalname,
          classId,
        },
        select: { id: true, type: true, url: true, name: true, classId: true, createdAt: true },
      });

      logger.info('material uploaded', { materialId: material.id, classId });
      return res.status(201).json(material);
    } catch (err) {
      safeUnlink(filePath);
      logger.error('material upload failed', { err });
      return sendHttpError(res, 500, ERRORS.MATERIAL_UPLOAD_FAILED, 'UPLOAD_FAILED');
    }
  }
);

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
    // ✅ #44: whiteboard와 whiteboardMeta 함께 축소 (meta만 남으면 복원 판단 미묘해짐)
    await Promise.all([
      redis.expire(wbKey, APP_CONFIG.WHITEBOARD_TTL_AFTER_END),
      redis.expire(`whiteboardMeta:${sessionId}`, APP_CONFIG.WHITEBOARD_TTL_AFTER_END),
    ]);

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
    archivedSessions.add(sessionId);

    // ✅ #44: 세션 완전 종료 시 in-memory 정리 (메모리 누수 방지)
    roomDrawTick.delete(sessionId);
    tickInitPromise.delete(sessionId);
    pendingStrokes.delete(sessionId);
    // ✅ #51: 진행 중 투표가 있으면 타이머 취소 + 최종 결과 브로드캐스트 후 정리
    if (activePolls.has(sessionId)) endPoll(io, sessionId);

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

// ✅ #42: 판서 데이터 조회 API (ARCHIVED → 파일, ACTIVE → Redis)
app.get(ROUTES.WHITEBOARD_GET, requireAuth, async (req, res) => {
  const { sessionId } = req.params;

  try {
    // ARCHIVED 여부 DB 확인
    const dbSession = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true, drawingPath: true },
    });

    if (dbSession?.status === 'ARCHIVED') {
      if (!dbSession.drawingPath) {
        return sendHttpError(res, 404, ERRORS.SESSION_NOT_FOUND, "DRAWING_NOT_FOUND");
      }
      const raw = await fs.promises.readFile(dbSession.drawingPath, 'utf8');
      const data = JSON.parse(raw);
      return res.json({ sessionId, readOnly: true, strokes: (data.strokes ?? []).map(normalizeStroke) });
    }

    // ACTIVE: Redis에서 조회
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return sendHttpError(res, 404, ERRORS.SESSION_NOT_FOUND, "SESSION_NOT_FOUND");
    }

    const wbKey = `whiteboard:${sessionId}`;
    const raw = await redis.get(wbKey);
    let strokes = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
      } catch (_) {}
    }

    return res.json({ sessionId, readOnly: false, strokes: strokes.map(normalizeStroke) });
  } catch (err) {
    logger.error("whiteboard get failed", { sessionId, err: err?.message });
    return sendHttpError(res, 500, ERRORS.INTERNAL_ERROR, "WHITEBOARD_GET_FAILED");
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


// ✅ #93: multer 에러 핸들러
// Express 에러 핸들러는 라우트들 뒤, io.on('connection') 앞에 위치해야 함.
app.use((err, req, res, next) => {
  if (err.code === 'FILE_TYPE_INVALID') {
    return sendHttpError(res, 400, ERRORS.FILE_TYPE_INVALID, 'PDF_ONLY');
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendHttpError(res, 400, ERRORS.FILE_TOO_LARGE, 'MAX_50MB');
  }
  next(err);
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

    // ✅ #44: 재연결 시 TTL 갱신 (키 없으면 expire는 무시됨 → allSettled)
    await Promise.allSettled([
      redis.expire(`session:${roomId}`, APP_CONFIG.SESSION_TTL_SECONDS),
      redis.expire(`whiteboard:${roomId}`, APP_CONFIG.SESSION_TTL_SECONDS),
      redis.expire(`whiteboardMeta:${roomId}`, APP_CONFIG.SESSION_TTL_SECONDS),
    ]);

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

  // ✅ #44: sync:request (재연결 시 lastTick 기반 delta 또는 full sync)
  socket.on(SOCKET_EVENTS.SYNC_REQUEST, async ({ lastTick } = {}) => {
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.NOT_JOINED,
        message: "NOT_JOINED",
      });
    }

    const roomId = socket.data.roomId;
    const wbKey = `whiteboard:${roomId}`;
    const metaKey = `whiteboardMeta:${roomId}`;

    // 정수 + 0 이상만 유효 (NaN, 음수, 소수 제외)
    const clientLastTick =
      Number.isInteger(lastTick) && lastTick >= 0 ? lastTick : null;

    try {
      const [rawBoard, rawMeta] = await Promise.all([
        redis.get(wbKey),
        redis.get(metaKey),
      ]);

      let strokes = [];
      if (rawBoard) {
        try {
          const parsed = JSON.parse(rawBoard);
          strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
        } catch (e) {
          logger.warn("invalid whiteboard json on sync", { roomId, err: e?.message });
        }
      }

      // meta 파싱 실패 시 보수적으로 hasDestructiveChange: true
      let meta = { serverTick: 0, hasDestructiveChange: true };
      if (rawMeta) {
        try {
          const parsed = JSON.parse(rawMeta);
          meta = {
            serverTick: Number.isInteger(parsed?.serverTick) ? parsed.serverTick : 0,
            hasDestructiveChange: parsed?.hasDestructiveChange === true,
            updatedAt: parsed?.updatedAt ?? 0,
          };
        } catch (e) {
          logger.warn("invalid whiteboard meta json on sync", { roomId, err: e?.message });
        }
      }

      // delta 가능 조건:
      // rawBoard === null → Redis miss (TTL 만료). strokes:[]인 정상 빈 보드와 구분
      const hasNoTickData = strokes.some((s) => s.t == null);
      const canDelta =
        clientLastTick !== null &&
        rawBoard !== null &&
        !hasNoTickData &&
        !meta.hasDestructiveChange;

      const mode = canDelta ? "delta" : "full";
      const payloadStrokes = canDelta
        ? strokes.filter((s) => s.t > clientLastTick)
        : strokes;

      socket.emit(SOCKET_EVENTS.SYNC_STATE, {
        strokes: payloadStrokes.map(normalizeStroke),
        mode,
        serverTick: meta.serverTick,
      });

      logger.info("sync:state sent", {
        roomId,
        mode,
        total: strokes.length,
        delta: payloadStrokes.length,
        clientLastTick,
        serverTick: meta.serverTick,
        destructive: meta.hasDestructiveChange,
        redisMiss: rawBoard === null,
      });
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

  // ✅ #51: 교사 → 학생 전체 투표 시작
  socket.on(SOCKET_EVENTS.POLL_START, ({ question, options, duration } = {}) => {
    if (!requireTeacher(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.FORBIDDEN, message: "Teacher role required" });
    }
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.NOT_JOINED, message: "Join a session first" });
    }

    const sessionId = socket.data.roomId;

    if (activePolls.has(sessionId)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.POLL_ALREADY_ACTIVE, message: "이미 진행 중인 투표가 있습니다" });
    }

    if (typeof question !== "string" || !question.trim() || !isValidPollOptions(options)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.PAYLOAD_INVALID, message: "INVALID_POLL_PAYLOAD" });
    }

    // duration 미제공(undefined) → null (타이머 없음)
    // 제공됐으나 범위 벗어남 → PAYLOAD_INVALID
    let validDuration = null;
    if (duration !== undefined) {
      if (typeof duration !== "number" || duration <= 0 || duration > MAX_POLL_DURATION) {
        return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.PAYLOAD_INVALID, message: "INVALID_POLL_DURATION" });
      }
      validDuration = duration;
    }

    const pollId = randomUUID();
    const normalizedQuestion = question.trim();
    const counts = {};
    options.forEach(o => { counts[o.id] = 0; });

    activePolls.set(sessionId, {
      pollId,
      question: normalizedQuestion,
      options,
      duration: validDuration,
      startedAt: Date.now(),
      startedBy: socket.data.userId,
      answers: new Map(),
      counts,
      timer: validDuration
        ? setTimeout(() => endPoll(io, sessionId), validDuration * 1000)
        : null,
    });

    const { studentsRoom } = getRoleRooms(sessionId);
    io.to(studentsRoom).emit(SOCKET_EVENTS.POLL_START, {
      pollId,
      question: normalizedQuestion,
      options,
      duration: validDuration,
    });

    logger.info("📊 poll started", {
      sessionId,
      pollId,
      teacherUserId: socket.data.userId,
      duration: validDuration,
    });
  });

  // ✅ #51: 학생 응답 수신 → 교사에게 실시간 집계 전송
  socket.on(SOCKET_EVENTS.POLL_ANSWER, ({ pollId, optionId } = {}) => {
    if (!requireStudent(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.FORBIDDEN, message: "Students only" });
    }
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.NOT_JOINED, message: "Join a session first" });
    }

    const sessionId = socket.data.roomId;
    const poll = activePolls.get(sessionId);

    if (!poll || poll.pollId !== pollId) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.POLL_NOT_FOUND, message: "활성 투표가 없습니다" });
    }
    if (poll.answers.has(socket.data.userId)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.POLL_ALREADY_ANSWERED, message: "이미 응답한 투표입니다" });
    }
    if (!(optionId in poll.counts)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.POLL_INVALID_OPTION, message: "유효하지 않은 선택지입니다" });
    }

    // 현재 단일 프로세스/단일 인스턴스 기준으로 동시성 문제 가능성 낮음.
    // 수평 확장(멀티 서버) 시 Redis atomic 연산으로 교체 필요.
    poll.answers.set(socket.data.userId, optionId);
    poll.counts[optionId] += 1;

    const { teachersRoom } = getRoleRooms(sessionId);
    io.to(teachersRoom).emit(SOCKET_EVENTS.POLL_RESULT, {
      pollId,
      counts: { ...poll.counts },
      total: poll.answers.size,
    });

    logger.info("📊 poll answer received", {
      sessionId,
      pollId,
      userId: socket.data.userId,
      optionId,
    });
  });

  // ✅ #51: 교사 조기 종료
  socket.on(SOCKET_EVENTS.POLL_END, ({ pollId } = {}) => {
    if (!requireTeacher(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.FORBIDDEN, message: "Teacher role required" });
    }
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.NOT_JOINED, message: "Join a session first" });
    }

    const sessionId = socket.data.roomId;
    const poll = activePolls.get(sessionId);

    if (!poll || poll.pollId !== pollId) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.POLL_NOT_FOUND, message: "활성 투표가 없습니다" });
    }

    endPoll(io, sessionId);
  });

  // ✅ #54 + #55: 학생 질문 수신 → DB 저장 → 교사에게 전달
  socket.on(SOCKET_EVENTS.QUESTION_ASK, async ({ content, isAnonymous = false } = {}) => {
    if (!requireStudent(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.FORBIDDEN, message: "Students only" });
    }
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.NOT_JOINED, message: "Not joined" });
    }

    if (typeof content !== "string") {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.QUESTION_EMPTY, message: "질문 내용이 비어 있습니다" });
    }

    const trimmed  = content.trim();
    // boolean이 아닌 값(예: 문자열 "true")은 false로 간주
    const anonymous = isAnonymous === true;

    if (!trimmed) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.QUESTION_EMPTY, message: "질문 내용이 비어 있습니다" });
    }
    if (trimmed.length > MAX_QUESTION_LENGTH) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.QUESTION_TOO_LONG, message: `최대 ${MAX_QUESTION_LENGTH}자` });
    }

    const sessionId = socket.data.roomId;
    const userId    = socket.data.userId;

    // retry 1회 — 일시적 커넥션 실패 완화 목적. FK 제약 위반 등 영구 오류는 해결하지 않음
    let question;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        question = await prisma.question.create({
          data: { sessionId, userId, content: trimmed, isAnonymous: anonymous },
        });
        break;
      } catch (err) {
        if (attempt === 2) {
          logger.error("question save failed", { sessionId, userId, err });
          return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.QUESTION_SAVE_FAILED, message: "저장 실패" });
        }
      }
    }

    // ACK: 본인에게만 반환. 마스킹 없이 isAnonymous를 최상위에 포함
    socket.emit(SOCKET_EVENTS.QUESTION_ACK, {
      questionId:  question.id,
      content:     question.content,
      status:      question.status,
      isAnonymous: question.isAnonymous,
      askedAt:     question.createdAt.getTime(),
    });

    // QUESTION_NEW: 교사에게 broadcast. askedBy 내부에 isAnonymous 포함
    const { teachersRoom } = getRoleRooms(sessionId);
    io.to(teachersRoom).emit(SOCKET_EVENTS.QUESTION_NEW, {
      questionId: question.id,
      content:    question.content,
      askedBy:    resolveAskedBy(userId, anonymous),
      status:     question.status,
      askedAt:    question.createdAt.getTime(),
    });

    logger.info("❓ question received", { sessionId, userId, questionId: question.id, isAnonymous: anonymous });
  });

  // ✅ #54: 교사 질문 목록 조회 (재접속 sync 용)
  socket.on(SOCKET_EVENTS.QUESTION_LIST, async () => {
    if (!requireTeacher(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.FORBIDDEN, message: "Teachers only" });
    }
    if (!requireJoined(socket)) {
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.NOT_JOINED, message: "Not joined" });
    }

    const sessionId = socket.data.roomId;

    let questions;
    try {
      questions = await prisma.question.findMany({
        where:   { sessionId },
        orderBy: { createdAt: "asc" },
        select:  { id: true, userId: true, content: true, status: true, isAnonymous: true, createdAt: true },
      });
    } catch (err) {
      logger.error("question list failed", { sessionId, err });
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.QUESTION_LIST_FAILED, message: "목록 조회 실패" });
    }

    socket.emit(SOCKET_EVENTS.QUESTION_LIST_RESULT, {
      questions: questions.map(q => ({
        questionId: q.id,
        content:    q.content,
        askedBy:    resolveAskedBy(q.userId, q.isAnonymous),
        status:     q.status,
        askedAt:    q.createdAt.getTime(),
      })),
    });
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

  // ✅ #42: 종료된 세션 판서 차단
  if (archivedSessions.has(socket.data.roomId)) {
    logger.warn("draw:append blocked: session archived", { sessionId: socket.data.roomId, userId: socket.data.userId });
    return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.SESSION_ENDED, message: "종료된 세션에서는 판서가 불가합니다" });
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
        typeof payload.c !== "string" || !PEN_CONFIG.HEX_RE.test(payload.c) ||
        typeof payload.w !== "number" || payload.w <= 0 || payload.w > PEN_CONFIG.MAX_WIDTH ||
      (payload.page !== undefined && (!Number.isInteger(payload.page) || payload.page < 1))) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DS_PAYLOAD",
      });
    }
    // ✅ #74: ds 데이터를 pendingStrokes에 임시 보관 (de 완성 시 Redis 저장에 사용)
    // ✅ #47: page는 stroke 시작 시점(ds) 기준으로 고정
    const sid = socket.data.roomId;
    if (!pendingStrokes.has(sid)) pendingStrokes.set(sid, new Map());
    pendingStrokes.get(sid).set(payload.sId, {
      sId: payload.sId, x: payload.x, y: payload.y, c: payload.c, w: payload.w,
      ...(Number.isInteger(payload.page) && payload.page >= 1 && { page: payload.page }),
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

  // ✅ #44: ds, dm → tick 없이 브로드캐스트 (휘발성, delta sync 대상 아님)
  if (e === "ds" || e === "dm") {
    socket.to(socket.data.studentsRoom).emit(SOCKET_EVENTS.DRAW_APPEND, {
      ...payload,
      senderUserId: socket.data.userId,
      senderRole: socket.data.role,
      ts: Date.now(),
    });
    logger.info("📐draw:append broadcast", {
      fromUserId: socket.data.userId,
      roomId: socket.data.roomId,
      e: payload.e,
      sId: payload.sId,
    });
    return;
  }

  // ✅ #44: de → tick 발급 후 브로드캐스트 + Redis 저장 (tick은 emit/store 동일값)
  if (e === "de") {
    const sessionId = socket.data.roomId;
    const wbKey = `whiteboard:${sessionId}`;
    const metaKey = `whiteboardMeta:${sessionId}`;

    const tick = await getNextTick(sessionId);
    const ts = Date.now();

    // ✅ #45: de 브로드캐스트 전에 dsData를 먼저 조회하여 c/w 보완
    const sessionMap = pendingStrokes.get(sessionId);
    const dsData = sessionMap?.get(payload.sId);

    socket.to(socket.data.studentsRoom).emit(SOCKET_EVENTS.DRAW_APPEND, {
      ...payload,
      c: dsData?.c ?? PEN_CONFIG.DEFAULT_COLOR,
      w: dsData?.w ?? PEN_CONFIG.DEFAULT_WIDTH,
      senderUserId: socket.data.userId,
      senderRole: socket.data.role,
      t: tick,
      ts,
    });

    logger.info("📐draw:append broadcast", {
      fromUserId: socket.data.userId,
      roomId: sessionId,
      e: payload.e,
      sId: payload.sId,
      t: tick,
    });

    try {
      if (!dsData) {
        logger.warn("draw:append 'de' received without 'ds'", {
          sessionId,
          sId: payload.sId,
          userId: socket.data.userId,
        });
      }
      const newStroke = {
        sId: payload.sId,
        x: dsData?.x ?? 0,
        y: dsData?.y ?? 0,
        c: dsData?.c ?? PEN_CONFIG.DEFAULT_COLOR,
        w: dsData?.w ?? PEN_CONFIG.DEFAULT_WIDTH,
        pts: Array.isArray(payload.pts) ? payload.pts : [],
        t: tick,
        ...(dsData?.page !== undefined && { page: dsData.page }),
      };

      // 락 획득 후 GET → parse → upsert → SET (원자적 보장)
      await withWhiteboardLock(sessionId, async () => {
        const [rawBoard, rawMeta] = await Promise.all([
          redis.get(wbKey),
          redis.get(metaKey),
        ]);

        let strokes = [];
        if (rawBoard) {
          try {
            const parsed = JSON.parse(rawBoard);
            strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
          } catch (_) {}
        }

        // 기존 destructive flag 유지 — append가 덮어쓰면 안 됨
        let prevDestructive = false;
        if (rawMeta) {
          try {
            prevDestructive = JSON.parse(rawMeta)?.hasDestructiveChange === true;
          } catch (_) {}
        }

        const idx = strokes.findIndex((s) => s.sId === payload.sId);
        if (idx >= 0) strokes[idx] = newStroke;
        else strokes.push(newStroke);

        await Promise.all([
          redis.set(wbKey, JSON.stringify({ strokes }), "EX", APP_CONFIG.SESSION_TTL_SECONDS),
          redis.set(metaKey, JSON.stringify({
            serverTick: tick,
            hasDestructiveChange: prevDestructive,
            updatedAt: ts,
          }), "EX", APP_CONFIG.SESSION_TTL_SECONDS),
        ]);
      });

      pendingStrokes.get(sessionId)?.delete(payload.sId);
    } catch (err) {
      logger.error("whiteboard store update failed", { e, err: err?.message });
    }
  }
});


  // ✅ #44: draw:clear (cl: 전체 지우기, un: 실행취소, er: 지우개)
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

    // cl: sId 불필요 / un, er: sId 필수
    if (!payload || (payload.e !== "cl" && payload.e !== "un" && payload.e !== "er")) {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DRAW_CLEAR_PAYLOAD",
      });
    }
    if (payload.e !== "cl" && typeof payload.sId !== "number") {
      return socket.emit(SOCKET_EVENTS.ERROR, {
        code: ERRORS.PAYLOAD_INVALID,
        message: "INVALID_DRAW_CLEAR_PAYLOAD",
      });
    }

    // ✅ #42: 종료된 세션 판서 차단
    if (archivedSessions.has(socket.data.roomId)) {
      logger.warn("draw:clear blocked: session archived", { sessionId: socket.data.roomId, userId: socket.data.userId });
      return socket.emit(SOCKET_EVENTS.ERROR, { code: ERRORS.SESSION_ENDED, message: "종료된 세션에서는 판서가 불가합니다" });
    }

    const sessionId = socket.data.roomId;
    const wbKey = `whiteboard:${sessionId}`;
    const metaKey = `whiteboardMeta:${sessionId}`;

    const tick = await getNextTick(sessionId);
    const ts = Date.now();

    socket.to(socket.data.studentsRoom).emit(SOCKET_EVENTS.DRAW_CLEAR, {
      e: payload.e,
      sId: payload.sId,
      senderUserId: socket.data.userId,
      t: tick,
      ts,
    });

    try {
      // 락 획득 후 GET → parse → filter/clear → SET (원자적 보장)
      await withWhiteboardLock(sessionId, async () => {
        const rawBoard = await redis.get(wbKey);
        let strokes = [];
        if (rawBoard) {
          try {
            const parsed = JSON.parse(rawBoard);
            strokes = Array.isArray(parsed?.strokes) ? parsed.strokes : [];
          } catch (_) {}
        }

        if (payload.e === "cl") {
          strokes = [];
        } else {
          strokes = strokes.filter((s) => s.sId !== payload.sId);
        }

        await Promise.all([
          redis.set(wbKey, JSON.stringify({ strokes }), "EX", APP_CONFIG.SESSION_TTL_SECONDS),
          redis.set(metaKey, JSON.stringify({
            serverTick: tick,
            hasDestructiveChange: true,
            updatedAt: ts,
          }), "EX", APP_CONFIG.SESSION_TTL_SECONDS),
        ]);
      });

      // cl: pending 전체 정리 / un, er: 해당 sId만 정리
      const p = pendingStrokes.get(sessionId);
      if (p) {
        if (payload.e === "cl") p.clear();
        else p.delete(payload.sId);
      }
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

  // ✅ #44: disconnect
  socket.on("disconnect", (reason) => {
    logger.info("socket disconnected", {
      socketId: socket.id,
      userId: socket.data.userId ?? null,
      role: socket.data.role ?? null,
      roomId: socket.data.roomId ?? null,
      reason,
    });

    const studentsRoom = socket.data?.studentsRoom;
    if (studentsRoom) {
      const sRoom = io.sockets.adapter.rooms.get(studentsRoom);
      if (!sRoom || sRoom.size === 0) {
        // roomDrawTick은 유지 — 재연결 시 tick 연속성 보장
        // (서버 재시작 시에는 getNextTick이 Redis meta에서 자동 복원)
        pendingStrokes.delete(socket.data.roomId);
        tickInitPromise.delete(socket.data.roomId); // 혹시 남은 init promise 정리
      }
    }

    // ✅ #45: 교사 disconnect 시 해당 소켓의 미완성 stroke 정리 (메모리 누수 방지)
    // ds → de 없이 끊기면 pendingStrokes에 고아 항목이 남을 수 있음
    if (socket.data.role === "teacher" && socket.data.roomId) {
      pendingStrokes.delete(socket.data.roomId);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info("🚀server started", { url: `http://localhost:${PORT}` });
  });
}

module.exports = { app, server, io };
