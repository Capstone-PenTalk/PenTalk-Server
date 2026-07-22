/**
 * 소켓 JOIN_ROOM - SessionParticipant 영구 참여 기록 upsert/재입장 최신화 테스트
 *
 * 실행: npx jest tests/join-room-session-participant-refresh.test.js --runInBand --forceExit
 *
 * 배경: 세션 종료 후에도 원본 자료 다운로드 권한을 유지하기 위해, 실제 참여가 확정되는
 * 소켓 JOIN_ROOM 성공 시점에 SessionParticipant를 upsert한다. classId/materialId는
 * 감사 기록용 스냅샷이라 upsert의 update 절도 매번 최신값으로 갱신하는데, 이 테스트는
 * 그 갱신이 실제로 일어나는지 검증한다(첫 참여 시 materialId=null → 이후 자료 연결 후
 * 재입장 시 upsert가 최신 materialId로 호출되는지).
 *
 * lastSession 캐시가 살아있으면 재입장이 캐시 경로를 타서 캐시 시점 materialId를 그대로
 * 쓰므로(이건 이 기능만의 문제가 아니라 #41 캐시 전반의 기존 동작), 두 번째 join 전에
 * 캐시 키를 지워 캐시-미스 경로(항상 최신 세션 데이터 조회)를 강제로 태운다.
 *
 * Prisma: jest.mock 처리(session.findUnique, sessionParticipant.upsert). Redis: 실 인스턴스 사용.
 */
require('dotenv').config();

const { io: ioc } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');

const PORT = 3105;
const BASE_URL = `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const CLASS_ID = 'test-class-participant-refresh';
const MATERIAL_ID = 'test-material-participant-refresh';

// 서버가 접속자를 roomId+userId 기준 in-memory Map(presence)으로도 추적하므로,
// 테스트 간 이전 소켓의 비동기 disconnect 처리와 레이스가 나지 않도록 테스트마다 고유 값을 쓴다.
let testSeq = 0;
function makeIds() {
  testSeq += 1;
  return {
    sessionId: `test-session-participant-refresh-${Date.now()}-${testSeq}`,
    userId: `test-student-participant-refresh-${Date.now()}-${testSeq}`,
  };
}

// ── Prisma mock ────────────────────────────────────────────────────────────
const mockSessionFindUnique = jest.fn();
const mockSessionParticipantUpsert = jest.fn();
const mockMaterialFindUnique = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    session: { findUnique: mockSessionFindUnique },
    sessionParticipant: { upsert: (...args) => mockSessionParticipantUpsert(...args) },
    material: { findUnique: (...args) => mockMaterialFindUnique(...args) },
  })),
}));

let serverInstance;
let ioInstance;
let socket;
let currentIds = null;

function makeToken(userId, role = 'student') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function connect(token) {
  return ioc(BASE_URL, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
  });
}

// join_success는 JOIN_ROOM 핸들러가 lastSession 캐시 쓰기 등 후속 await를 마치기 전에
// emit되므로(권한에 쓰이는 참여 기록 upsert 자체는 emit 전에 이미 끝남), 그 이후 부수 효과까지
// 끝나길 기다릴 땐 고정 sleep 대신 조건이 실제로 충족될 때까지 짧은 간격으로 폴링한다.
async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function waitFor(sock, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    sock.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function cleanupRedis(sessionId, userId) {
  await redis.del(
    `session:${sessionId}`,
    `whiteboard:${sessionId}`,
    `whiteboardMeta:${sessionId}`,
    `session:${sessionId}:participants`,
    `session:${sessionId}:users`,
    `user:${userId}:lastSession`,
  );
}

beforeAll(async () => {
  const { server, io } = require('../src/server');
  serverInstance = server;
  ioInstance = io;
  await new Promise((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  ioInstance.close();
  await new Promise((resolve) => serverInstance.close(resolve));
}, 20000);

afterEach(async () => {
  if (socket) socket.close();
  if (currentIds) await cleanupRedis(currentIds.sessionId, currentIds.userId);
});

beforeEach(() => {
  currentIds = makeIds();
  jest.clearAllMocks();
  mockSessionParticipantUpsert.mockResolvedValue({ id: 'participant-row-1' });
  // 캐시 미스 시 JOIN_ROOM이 ARCHIVED 여부를 DB로 확인하는 경로용
  mockSessionFindUnique.mockResolvedValue({ status: 'ACTIVE' });
  // materialId가 세션에 연결된 경우 JOIN_SUCCESS payload 구성을 위해 조회됨(이 테스트의 관심사 아님)
  mockMaterialFindUnique.mockResolvedValue(null);
});

describe('JOIN_ROOM → SessionParticipant upsert', () => {
  test('첫 참여 시 materialId=null로 upsert 후, 자료 연결 후 재입장하면 최신 materialId로 upsert', async () => {
    const { sessionId: SESSION_ID, userId: USER_ID } = currentIds;

    // 1) 세션: 아직 자료 연결 안 됨
    await redis.setex(
      `session:${SESSION_ID}`,
      3600,
      JSON.stringify({ id: SESSION_ID, classId: CLASS_ID, materialId: null, createdAt: Date.now() }),
    );

    socket = connect(makeToken(USER_ID));
    await waitFor(socket, 'connect');
    socket.emit('join_room', { roomId: SESSION_ID, classId: CLASS_ID });
    await waitFor(socket, 'join_success');

    // 권한에 쓰이는 SessionParticipant upsert 자체는 emit 전에 이미 끝나 있지만(server.js 기준
    // redis.sadd/expire, sessionParticipant.upsert 모두 JOIN_SUCCESS emit보다 앞선 라인에서 await됨),
    // emit 이후에도 핸들러는 lastSession 캐시 쓰기를 계속 진행한다. 다음 단계에서 그 캐시 키를
    // 지우고 다시 만들 것이므로, 고정 sleep 대신 캐시 키가 실제로 쓰여질 때까지 폴링한다.
    await waitUntil(async () => Boolean(await redis.exists(`user:${USER_ID}:lastSession`)));

    expect(mockSessionParticipantUpsert).toHaveBeenCalledTimes(1);
    expect(mockSessionParticipantUpsert).toHaveBeenCalledWith({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: USER_ID } },
      create: { sessionId: SESSION_ID, userId: USER_ID, classId: CLASS_ID, materialId: null },
      update: { classId: CLASS_ID, materialId: null, lastJoinedAt: expect.any(Date) },
    });

    // 2) 교사가 세션에 자료를 연결했다고 가정 (Redis 세션 데이터 갱신)
    await redis.setex(
      `session:${SESSION_ID}`,
      3600,
      JSON.stringify({ id: SESSION_ID, classId: CLASS_ID, materialId: MATERIAL_ID, createdAt: Date.now() }),
    );

    // lastSession 캐시가 남아있으면 재입장이 캐시 경로를 타서 stale materialId를 쓰게 되므로,
    // 캐시-미스 경로를 강제하기 위해 캐시를 지운다 (재연결/캐시 만료 상황을 재현).
    await redis.del(`user:${USER_ID}:lastSession`);

    socket.close();
    socket = connect(makeToken(USER_ID));
    await waitFor(socket, 'connect');
    socket.emit('join_room', { roomId: SESSION_ID, classId: CLASS_ID, materialId: MATERIAL_ID });
    await waitFor(socket, 'join_success');

    expect(mockSessionParticipantUpsert).toHaveBeenCalledTimes(2);
    expect(mockSessionParticipantUpsert).toHaveBeenLastCalledWith({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: USER_ID } },
      create: { sessionId: SESSION_ID, userId: USER_ID, classId: CLASS_ID, materialId: MATERIAL_ID },
      update: { classId: CLASS_ID, materialId: MATERIAL_ID, lastJoinedAt: expect.any(Date) },
    });

    // GPT 리뷰 제안: update 절이 최신 classId/materialId로 호출됐는지 별도로도 명시적으로 확인
    expect(mockSessionParticipantUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ classId: CLASS_ID, materialId: MATERIAL_ID }),
      }),
    );
  });

  test('upsert가 실패해도 join_success는 정상 emit (실시간 참여 자체는 막지 않음)', async () => {
    const { sessionId: SESSION_ID, userId: USER_ID } = currentIds;
    mockSessionParticipantUpsert.mockRejectedValue(new Error('db unreachable'));
    await redis.setex(
      `session:${SESSION_ID}`,
      3600,
      JSON.stringify({ id: SESSION_ID, classId: CLASS_ID, materialId: null, createdAt: Date.now() }),
    );

    socket = connect(makeToken(USER_ID));
    await waitFor(socket, 'connect');
    socket.emit('join_room', { roomId: SESSION_ID, classId: CLASS_ID });
    const data = await waitFor(socket, 'join_success');

    expect(data.roomId).toBe(SESSION_ID);
    expect(mockSessionParticipantUpsert).toHaveBeenCalledTimes(1);
  });
});
