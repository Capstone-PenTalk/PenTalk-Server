/**
 * #45 펜 타입(color, width) 통합 테스트
 *
 * 실행: npx jest tests/45-pen-style.test.js --runInBand --forceExit
 *
 * 전제: Redis 실행 중 (DB 불필요 - lastSession 캐시로 DB 조회 우회)
 */
require('dotenv').config();

const { io: ioc } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');
const { app, server, io } = require('../src/server');

const PORT = 3097;
const BASE_URL = `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_ID = `test-session-45-${Date.now()}`;
const CLASS_ID = 'test-class-45';
let tokenCounter = 0;

// userId와 JWT를 동일한 tokenCounter 기준으로 생성 (불일치 방지)
function makeAuth(role) {
  tokenCounter++;
  const userId = `${role}-${tokenCounter}`;
  const token = jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
  return { userId, token };
}

function connect(token) {
  return ioc(BASE_URL, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
  });
}

function waitFor(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${event}`)), ms);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

function waitForDrawAppend(socket, eType, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: draw:append e=${eType}`)), ms);
    function handler(data) {
      if (data.e === eType) { clearTimeout(t); socket.off('draw:append', handler); resolve(data); }
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

async function joinAs(role) {
  const { userId, token } = makeAuth(role);
  const socket = connect(token);
  await waitFor(socket, 'connect');
  await redis.setex(
    `user:${userId}:lastSession`, 3600,
    JSON.stringify({ sessionId: SESSION_ID, classId: CLASS_ID, materialId: null }),
  );
  socket.emit('join_room', { roomId: SESSION_ID, classId: CLASS_ID });
  await waitFor(socket, 'join_success');
  return socket;
}

beforeAll((done) => {
  server.listen(PORT, done);
});

afterAll(async () => {
  await cleanupRedis();
  io.close();
  await new Promise((r) => server.close(r));
  // redis.quit()는 공용 클라이언트이므로 여기서 종료하지 않음
  // (다른 테스트 파일과 병렬 실행 시 영향 방지)
}, 20000);

beforeEach(async () => {
  await cleanupRedis();
  await redis.setex(
    `session:${SESSION_ID}`, 3600,
    JSON.stringify({ id: SESSION_ID, classId: CLASS_ID, materialId: null, createdAt: Date.now() }),
  );
});

// ─── 시나리오 1. ds 브로드캐스트에 c/w 포함 ───────────────────────────────
describe('시나리오 1. ds 브로드캐스트', () => {
  test('학생이 수신하는 ds 이벤트에 c, w가 포함된다', async () => {
    const teacher = await joinAs('teacher');
    const student = await joinAs('student');

    const dsPromise = waitForDrawAppend(student, 'ds');
    teacher.emit('draw:append', { e: 'ds', sId: 1, r: SESSION_ID, x: 0.1, y: 0.1, c: '#ff0000', w: 5 });
    const ds = await dsPromise;

    expect(ds.c).toBe('#ff0000');
    expect(ds.w).toBe(5);

    teacher.disconnect();
    student.disconnect();
  });
});

// ─── 시나리오 2. de 브로드캐스트에 c/w 포함 ───────────────────────────────
describe('시나리오 2. de 브로드캐스트', () => {
  test('학생이 수신하는 de 이벤트에 ds의 c, w가 포함된다', async () => {
    const teacher = await joinAs('teacher');
    const student = await joinAs('student');

    teacher.emit('draw:append', { e: 'ds', sId: 2, r: SESSION_ID, x: 0.1, y: 0.1, c: '#00ff00', w: 10 });
    teacher.emit('draw:append', { e: 'dm', sId: 2, r: SESSION_ID, x: 0.2, y: 0.2 });

    const dePromise = waitForDrawAppend(student, 'de');
    teacher.emit('draw:append', { e: 'de', sId: 2, r: SESSION_ID, pts: [[0.1, 0.1]] });
    const de = await dePromise;

    expect(de.c).toBe('#00ff00');
    expect(de.w).toBe(10);

    teacher.disconnect();
    student.disconnect();
  });

  test('ds 없이 de만 온 경우 기본값(#000000, 2)으로 브로드캐스트된다', async () => {
    const teacher = await joinAs('teacher');
    const student = await joinAs('student');

    const dePromise = waitForDrawAppend(student, 'de');
    teacher.emit('draw:append', { e: 'de', sId: 98, r: SESSION_ID, pts: [] });
    const de = await dePromise;

    expect(de.c).toBe('#000000');
    expect(de.w).toBe(2);

    teacher.disconnect();
    student.disconnect();
  });
});

// ─── 시나리오 3. Redis 저장 포맷에 c/w 포함 ───────────────────────────────
describe('시나리오 3. Redis 저장', () => {
  test('de 완료 후 Redis stroke에 c, w가 저장된다', async () => {
    const teacher = await joinAs('teacher');

    teacher.emit('draw:append', { e: 'ds', sId: 3, r: SESSION_ID, x: 0.0, y: 0.0, c: '#123456', w: 3 });
    teacher.emit('draw:append', { e: 'de', sId: 3, r: SESSION_ID, pts: [] });
    await new Promise((r) => setTimeout(r, 200));

    const raw = await redis.get(`whiteboard:${SESSION_ID}`);
    const board = JSON.parse(raw);
    const stroke = board.strokes.find((s) => s.sId === 3);

    expect(stroke.c).toBe('#123456');
    expect(stroke.w).toBe(3);

    teacher.disconnect();
  });
});

// ─── 시나리오 4. sync:state에 c/w 포함 ────────────────────────────────────
describe('시나리오 4. sync:state', () => {
  test('재연결 후 sync:state로 받은 strokes에 c, w가 있다', async () => {
    const teacher = await joinAs('teacher');
    teacher.emit('draw:append', { e: 'ds', sId: 4, r: SESSION_ID, x: 0.1, y: 0.1, c: '#abcdef', w: 7 });
    teacher.emit('draw:append', { e: 'de', sId: 4, r: SESSION_ID, pts: [] });
    await new Promise((r) => setTimeout(r, 200));
    teacher.disconnect();

    const teacher2 = await joinAs('teacher');
    const syncPromise = waitFor(teacher2, 'sync:state');
    teacher2.emit('sync:request', {});
    const state = await syncPromise;

    const stroke = state.strokes.find((s) => s.sId === 4);
    expect(stroke?.c).toBe('#abcdef');
    expect(stroke?.w).toBe(7);

    teacher2.disconnect();
  });
});

// ─── 시나리오 5. ds c/w 검증 ──────────────────────────────────────────────
describe('시나리오 5. ds 검증', () => {
  test.each([
    ['문자열 색상명', 'red'],
    ['빈 문자열', ''],
    ['8자리 hex', '#12345678'],
    ['# 없는 hex', '000000'],
  ])('c=%s → PAYLOAD_INVALID', async (label, c) => {
    const teacher = await joinAs('teacher');
    const errPromise = waitFor(teacher, 'server_error');
    teacher.emit('draw:append', { e: 'ds', sId: 99, r: SESSION_ID, x: 0.1, y: 0.1, c, w: 2 });
    const err = await errPromise;
    expect(err.code).toBe('PAYLOAD_INVALID');
    teacher.disconnect();
  });

  test('w > 50 → PAYLOAD_INVALID', async () => {
    const teacher = await joinAs('teacher');
    const errPromise = waitFor(teacher, 'server_error');
    teacher.emit('draw:append', { e: 'ds', sId: 100, r: SESSION_ID, x: 0.1, y: 0.1, c: '#000000', w: 51 });
    const err = await errPromise;
    expect(err.code).toBe('PAYLOAD_INVALID');
    teacher.disconnect();
  });

  test.each([
    ['3자리 hex', '#abc'],
    ['6자리 hex', '#aabbcc'],
    ['대문자 hex', '#AABBCC'],
  ])('c=%s → 정상 처리', async (label, c) => {
    const teacher = await joinAs('teacher');
    const student = await joinAs('student');

    const dsPromise = waitForDrawAppend(student, 'ds');
    teacher.emit('draw:append', { e: 'ds', sId: 101, r: SESSION_ID, x: 0.1, y: 0.1, c, w: 2 });
    const ds = await dsPromise;
    expect(ds.c).toBe(c);

    teacher.disconnect();
    student.disconnect();
  });
});

// ─── 시나리오 6. 구형 데이터 호환성 ───────────────────────────────────────
describe('시나리오 6. 구형 stroke 호환성', () => {
  test('c/w 없는 구형 stroke가 Redis에 있어도 sync:state에서 기본값으로 정규화된다', async () => {
    await redis.set(
      `whiteboard:${SESSION_ID}`,
      JSON.stringify({ strokes: [{ sId: 1, x: 0.1, y: 0.1, pts: [], t: 1 }] }),
      'EX', 3600,
    );
    await redis.set(
      `whiteboardMeta:${SESSION_ID}`,
      JSON.stringify({ serverTick: 1, hasDestructiveChange: false }),
      'EX', 3600,
    );

    const teacher = await joinAs('teacher');
    const syncPromise = waitFor(teacher, 'sync:state');
    teacher.emit('sync:request', { lastTick: 0 });
    const state = await syncPromise;

    const stroke = state.strokes.find((s) => s.sId === 1);
    expect(stroke?.c).toBe('#000000');
    expect(stroke?.w).toBe(2);

    teacher.disconnect();
  });
});
