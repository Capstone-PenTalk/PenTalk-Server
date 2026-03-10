/**
 * #44 재연결 지원 통합 테스트
 *
 * 실행: npx jest tests/44-reconnect.test.js --runInBand --forceExit
 *
 * 전제: Redis 실행 중 (DB 불필요 - lastSession 캐시로 DB 조회 우회)
 */

require('dotenv').config();

const { io: ioc } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');
const { app, server, io } = require('../src/server');

const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const SESSION_ID = `test-session-44-${Date.now()}`;
const CLASS_ID = 'test-class-44';

// 각 소켓마다 고유 userId → "중복 접속 강제 disconnect" 충돌 방지
let tokenCounter = 0;
function makeTeacherToken() {
  tokenCounter++;
  return jwt.sign({ userId: `teacher-${tokenCounter}`, role: 'teacher' }, JWT_SECRET, { expiresIn: '1h' });
}

function connect(token) {
  return ioc(BASE_URL, {
    auth: { token },            // 소켓 미들웨어는 raw 토큰 직접 검증 (Bearer prefix 없음)
    transports: ['websocket'],
    forceNew: true,
  });
}

function waitFor(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// 특정 e 타입의 draw:append만 기다림 (dm이 먼저 와도 건너뜀)
function waitForDrawAppend(socket, eType, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for draw:append e=${eType}`)), timeoutMs);
    function handler(data) {
      if (data.e === eType) {
        clearTimeout(timer);
        socket.off('draw:append', handler);
        resolve(data);
      }
    }
    socket.on('draw:append', handler);
  });
}

async function cleanupRedis() {
  await redis.del(
    `session:${SESSION_ID}`,
    `whiteboard:${SESSION_ID}`,
    `whiteboardMeta:${SESSION_ID}`,
    `lock:whiteboard:${SESSION_ID}`,
  );
}

// 현재 Redis meta의 serverTick 읽기 (없으면 0)
async function getCurrentTick() {
  const raw = await redis.get(`whiteboardMeta:${SESSION_ID}`);
  if (!raw) return 0;
  try { return JSON.parse(raw).serverTick ?? 0; } catch (_) { return 0; }
}

beforeAll((done) => {
  server.listen(PORT, done);
});

afterAll(async () => {
  await cleanupRedis();
  io.close();
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
}, 20000);

beforeEach(async () => {
  await cleanupRedis();
  // 세션을 Redis에 직접 세팅
  await redis.setex(
    `session:${SESSION_ID}`,
    3600,
    JSON.stringify({ id: SESSION_ID, classId: CLASS_ID, materialId: null, createdAt: Date.now() }),
  );
});

// ─── 헬퍼: 학생 join (draw:append 브로드캐스트 수신용) ──────────────────
async function joinAsStudent() {
  const userId = `student-${++tokenCounter}`;
  const token = jwt.sign({ userId, role: 'student' }, JWT_SECRET, { expiresIn: '1h' });
  const socket = connect(token);
  await waitFor(socket, 'connect');

  await redis.setex(
    `user:${userId}:lastSession`,
    3600,
    JSON.stringify({ sessionId: SESSION_ID, classId: CLASS_ID, materialId: null }),
  );

  socket.emit('join_room', { roomId: SESSION_ID, classId: CLASS_ID });
  await waitFor(socket, 'join_success');
  return socket;
}

// ─── 헬퍼: 교사 join ───────────────────────────────────────────────────
async function joinAsTeacher() {
  const token = makeTeacherToken();
  const userId = `teacher-${tokenCounter}`;
  const socket = connect(token);
  await waitFor(socket, 'connect');

  // lastSession 캐시 세팅 → DB 조회 우회 (테스트 환경에서 DB 미실행)
  await redis.setex(
    `user:${userId}:lastSession`,
    3600,
    JSON.stringify({ sessionId: SESSION_ID, classId: CLASS_ID, materialId: null }),
  );

  socket.emit('join_room', { roomId: SESSION_ID, classId: CLASS_ID });
  await waitFor(socket, 'join_success');
  return socket;
}

// ─── 헬퍼: de 이벤트 전송 ───────────────────────────────────────────
async function sendDe(socket, sId) {
  socket.emit('draw:append', { e: 'ds', sId, r: SESSION_ID, x: 0.1, y: 0.1, c: '#000', w: 2 });
  socket.emit('draw:append', { e: 'dm', sId, r: SESSION_ID, x: 0.2, y: 0.2 });
  socket.emit('draw:append', { e: 'de', sId, r: SESSION_ID, pts: [[0.1, 0.1], [0.2, 0.2]] });
  await new Promise((r) => setTimeout(r, 150));
}

// ─────────────────────────────────────────────────────────────────────────
// 시나리오 1. 일반 판서 (ds/dm → t 없음, de → t 있음)
// ─────────────────────────────────────────────────────────────────────────
describe('시나리오 1. 일반 판서', () => {
  test('ds/dm 브로드캐스트에 t 필드가 없고, de에는 t와 ts가 있다', async () => {
    const teacher = await joinAsTeacher();
    // draw:append는 studentsRoom으로만 브로드캐스트 → 학생 소켓으로 수신
    const student = await joinAsStudent();

    // ds 수신 확인
    const dsPromise = waitForDrawAppend(student, 'ds');
    teacher.emit('draw:append', { e: 'ds', sId: 1, r: SESSION_ID, x: 0.1, y: 0.1, c: '#000', w: 2 });
    const dsPayload = await dsPromise;
    expect(dsPayload.t).toBeUndefined();        // ds에는 t 없음

    // de 수신 확인 (dm이 먼저 와도 건너뜀)
    const dePromise = waitForDrawAppend(student, 'de');
    teacher.emit('draw:append', { e: 'dm', sId: 1, r: SESSION_ID, x: 0.15, y: 0.15 });
    teacher.emit('draw:append', { e: 'de', sId: 1, r: SESSION_ID, pts: [] });
    const dePayload = await dePromise;
    expect(typeof dePayload.t).toBe('number');  // de에는 t 있음
    expect(dePayload.t).toBeGreaterThan(0);
    expect(typeof dePayload.ts).toBe('number');

    teacher.disconnect();
    student.disconnect();
  });

  test('de 이후 Redis whiteboard에 t 필드가 저장되고, meta와 일치하며 hasDestructiveChange=false', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);

    const raw = await redis.get(`whiteboard:${SESSION_ID}`);
    const board = JSON.parse(raw);
    expect(Array.isArray(board.strokes)).toBe(true);
    expect(typeof board.strokes[0].t).toBe('number');
    expect(board.strokes[0].t).toBeGreaterThan(0);

    const rawMeta = await redis.get(`whiteboardMeta:${SESSION_ID}`);
    const meta = JSON.parse(rawMeta);
    // stroke의 t와 meta.serverTick이 일치해야 함
    expect(meta.serverTick).toBe(board.strokes[0].t);
    expect(meta.hasDestructiveChange).toBe(false);

    teacher.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 시나리오 2. 재연결 후 delta sync (전제: clear 없는 상태)
// ─────────────────────────────────────────────────────────────────────────
describe('시나리오 2. 재연결 후 delta sync (clear 없는 상태)', () => {
  test('lastTick=t2일 때 t>t2인 stroke만 delta로 온다', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    await sendDe(teacher, 2);

    // 2번째 de 직후 tick을 lastTick 기준으로 사용
    const tickAfter2 = await getCurrentTick();

    await sendDe(teacher, 3);
    await sendDe(teacher, 4);

    const finalTick = await getCurrentTick();
    teacher.disconnect();

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', { lastTick: tickAfter2 });
    const state = await syncPromise;

    expect(state.mode).toBe('delta');
    expect(state.strokes.length).toBe(2);
    expect(state.strokes.every((s) => s.t > tickAfter2)).toBe(true);
    expect(state.serverTick).toBe(finalTick);

    teacher2.disconnect();
  });

  test('lastTick=0이면 전체 strokes를 delta로 받는다', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    await sendDe(teacher, 2);
    const finalTick = await getCurrentTick();
    teacher.disconnect();

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', { lastTick: 0 });
    const state = await syncPromise;

    expect(state.mode).toBe('delta');
    expect(state.strokes.length).toBe(2);
    expect(state.serverTick).toBe(finalTick);

    teacher2.disconnect();
  });

  test('lastTick 없으면 full sync된다', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    teacher.disconnect();

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', {});
    const state = await syncPromise;

    expect(state.mode).toBe('full');

    teacher2.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 시나리오 3. clear 후 재연결 → full sync 강제
// clear 이벤트도 getNextTick() 소비 → serverTick += 1
// ─────────────────────────────────────────────────────────────────────────
describe('시나리오 3. clear 후 재연결 → full sync 강제', () => {
  test('un 후 hasDestructiveChange=true, serverTick 증가, 재연결 시 full sync', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    await sendDe(teacher, 2);
    const tickBeforeClear = await getCurrentTick();

    teacher.emit('draw:clear', { e: 'un', sId: 1 }); // tick 소비
    await new Promise((r) => setTimeout(r, 150));

    const rawMeta = await redis.get(`whiteboardMeta:${SESSION_ID}`);
    const meta = JSON.parse(rawMeta);
    expect(meta.hasDestructiveChange).toBe(true);
    expect(meta.serverTick).toBe(tickBeforeClear + 1); // clear가 tick 1개 소비

    teacher.disconnect();

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', { lastTick: tickBeforeClear - 1 }); // lastTick 있어도 full이어야 함
    const state = await syncPromise;

    expect(state.mode).toBe('full');
    expect(state.serverTick).toBe(tickBeforeClear + 1);

    teacher2.disconnect();
  });

  test('cl 후 strokes:[], hasDestructiveChange=true, full sync', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    await sendDe(teacher, 2);

    teacher.emit('draw:clear', { e: 'cl' });
    await new Promise((r) => setTimeout(r, 150));

    const rawBoard = await redis.get(`whiteboard:${SESSION_ID}`);
    const board = JSON.parse(rawBoard);
    expect(board.strokes.length).toBe(0);

    const rawMeta = await redis.get(`whiteboardMeta:${SESSION_ID}`);
    const meta = JSON.parse(rawMeta);
    expect(meta.hasDestructiveChange).toBe(true);

    teacher.disconnect();

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    const currentTick = await getCurrentTick();
    teacher2.emit('sync:request', { lastTick: currentTick - 1 });
    const state = await syncPromise;

    expect(state.mode).toBe('full');
    expect(state.strokes.length).toBe(0);

    teacher2.disconnect();
  });

  test('append가 와도 destructive flag가 false로 되돌아가지 않는다', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    teacher.emit('draw:clear', { e: 'un', sId: 1 });
    await new Promise((r) => setTimeout(r, 150));

    await sendDe(teacher, 2); // append 후에도 flag 유지 확인
    await new Promise((r) => setTimeout(r, 150));

    const rawMeta = await redis.get(`whiteboardMeta:${SESSION_ID}`);
    const meta = JSON.parse(rawMeta);
    expect(meta.hasDestructiveChange).toBe(true);

    teacher.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 시나리오 6. join_room 후 TTL 갱신
// ─────────────────────────────────────────────────────────────────────────
describe('시나리오 6. join_room 후 TTL 갱신', () => {
  test('join 후 whiteboard / whiteboardMeta TTL이 SESSION_TTL_SECONDS로 갱신된다', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);

    // TTL을 30초로 강제 축소
    await redis.expire(`whiteboard:${SESSION_ID}`, 30);
    await redis.expire(`whiteboardMeta:${SESSION_ID}`, 30);
    teacher.disconnect();

    // 재연결 (join_room 시 TTL 갱신)
    const teacher2 = await joinAsTeacher();
    await new Promise((r) => setTimeout(r, 100));

    const wbTtl = await redis.ttl(`whiteboard:${SESSION_ID}`);
    const metaTtl = await redis.ttl(`whiteboardMeta:${SESSION_ID}`);

    // 30초에서 SESSION_TTL_SECONDS(21600) 근처로 복원됐는지 확인
    expect(wbTtl).toBeGreaterThan(100);
    expect(metaTtl).toBeGreaterThan(100);

    teacher2.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 엣지케이스: Redis miss (두 케이스 분리)
// ─────────────────────────────────────────────────────────────────────────
describe('엣지케이스: Redis miss', () => {
  test('케이스 A — whiteboard만 삭제, meta 존재 → full, serverTick은 meta 값 유지', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    const savedTick = await getCurrentTick();
    teacher.disconnect();

    await redis.del(`whiteboard:${SESSION_ID}`);

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', { lastTick: 0 });
    const state = await syncPromise;

    expect(state.mode).toBe('full');
    expect(state.strokes.length).toBe(0);
    expect(state.serverTick).toBe(savedTick); // meta 값 유지

    teacher2.disconnect();
  });

  test('케이스 B — whiteboard + meta 모두 삭제 → full, serverTick=0', async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    teacher.disconnect();

    await redis.del(`whiteboard:${SESSION_ID}`, `whiteboardMeta:${SESSION_ID}`);

    const teacher2 = await joinAsTeacher();
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', { lastTick: 5 });
    const state = await syncPromise;

    expect(state.mode).toBe('full');
    expect(state.serverTick).toBe(0);

    teacher2.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 엣지케이스: de without ds
// ─────────────────────────────────────────────────────────────────────────
describe('엣지케이스: de without ds', () => {
  test('ds 없이 de만 보내도 기본값으로 저장된다', async () => {
    const teacher = await joinAsTeacher();

    teacher.emit('draw:append', { e: 'de', sId: 99, r: SESSION_ID, pts: [] });
    await new Promise((r) => setTimeout(r, 200));

    const raw = await redis.get(`whiteboard:${SESSION_ID}`);
    const board = JSON.parse(raw);
    const stroke = board.strokes.find((s) => s.sId === 99);

    expect(stroke).toBeDefined();
    expect(stroke.x).toBe(0);
    expect(stroke.y).toBe(0);
    expect(stroke.c).toBe('#000000');
    expect(stroke.w).toBe(2);

    teacher.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 엣지케이스: lastTick 유효성 검증
// ─────────────────────────────────────────────────────────────────────────
describe('엣지케이스: lastTick 유효성', () => {
  beforeEach(async () => {
    const teacher = await joinAsTeacher();
    await sendDe(teacher, 1);
    teacher.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  test.each([
    ['음수', -1],
    ['소수', 1.5],
    ['null', null],
    ['문자열', 'abc'],
  ])('lastTick=%s → full sync', async (label, lastTick) => {
    const teacher = await joinAsTeacher();
    const syncPromise = waitFor(teacher, 'sync:state');
    teacher.emit('sync:request', { lastTick });
    const state = await syncPromise;
    expect(state.mode).toBe('full');
    teacher.disconnect();
  });
});
