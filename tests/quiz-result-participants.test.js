/**
 * GET /sessions/:sessionId/quiz/result 권한 체크 회귀 테스트
 *
 * 실행: npx jest tests/quiz-result-participants.test.js --runInBand --forceExit
 *
 * 전제: Redis 실행 중
 * Prisma: jest.mock 처리
 *
 * 검증 대상: quiz/result가 ClassMember 대신 session:{sessionId}:participants
 * Redis Set 기준으로 권한을 확인하는지 확인. QR로 입장해 ClassMember 레코드가 없는
 * 학생도 participants Set에만 등록돼 있으면 403 없이 조회할 수 있어야 한다.
 */
require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');

const PORT = 3104;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_ID = `test-session-quiz-result-${Date.now()}`;
const PARTICIPANT_USER_ID = `test-student-quiz-result-1-${Date.now()}`;
const NON_PARTICIPANT_USER_ID = `test-student-quiz-result-2-${Date.now()}`;

const mockSessionFindUnique = jest.fn();
const mockQuizAnswerCount = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    session: { findUnique: mockSessionFindUnique },
    quizAnswer: { count: mockQuizAnswerCount },
  })),
}));

let serverInstance;
let ioInstance;

function get(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: urlPath,
        method: 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString()); } catch (_) {}
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function makeToken(userId, role = 'student') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

async function cleanupRedis() {
  await redis.del(`session:${SESSION_ID}:participants`);
}

beforeAll(async () => {
  const { server, io } = require('../src/server');
  serverInstance = server;
  ioInstance = io;
  await new Promise((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  await cleanupRedis();
  ioInstance.close();
  await new Promise((resolve) => serverInstance.close(resolve));
}, 20000);

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanupRedis();

  mockSessionFindUnique.mockResolvedValue({ status: 'ARCHIVED' });
  mockQuizAnswerCount.mockResolvedValue(2);
  await redis.sadd(`session:${SESSION_ID}:participants`, PARTICIPANT_USER_ID);
});

test('QR 입장 학생(ClassMember 없음)도 participants Set에 있으면 403 없이 결과를 조회한다', async () => {
  const token = makeToken(PARTICIPANT_USER_ID);

  const res = await get(`/sessions/${SESSION_ID}/quiz/result`, token);
  expect(res.status).toBe(200);
  expect(res.json.ok).toBe(true);
  expect(res.json.passed).toBe(true);
  expect(res.json.correctCount).toBe(2);
});

test('participants Set에 없는 사용자는 403 NOT_SESSION_MEMBER를 반환한다', async () => {
  const token = makeToken(NON_PARTICIPANT_USER_ID);

  const res = await get(`/sessions/${SESSION_ID}/quiz/result`, token);
  expect(res.status).toBe(403);
  expect(res.json.code).toBe('FORBIDDEN');
  expect(res.json.message).toBe('NOT_SESSION_MEMBER');
});
