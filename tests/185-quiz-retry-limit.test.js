/**
 * #185 일일 재응시 횟수 제한 회귀 테스트
 *
 * 실행: npx jest tests/185-quiz-retry-limit.test.js --runInBand --forceExit
 *
 * 전제: Redis 실행 중
 * Prisma: jest.mock 처리
 *
 * 검증 대상: POST /sessions/:sessionId/quiz/submit 의 isRetryStart 플래그 기반
 * 일일 재응시 횟수 제한. 첫 응시(당일 최초 3문항)는 카운트되지 않고, isRetryStart:true로
 * 시작한 재응시 세트만 하루 최대 2회로 제한됨을 확인한다.
 */
require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');

const PORT = 3103;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_ID = `test-session-185-${Date.now()}`;
const CLASS_ID = 'test-class-185';
const VALID_QUESTION_IDS = ['q1', 'q2', 'q3'];
const INVALID_QUESTION_ID = 'bad-question-id';

const mockSessionFindUnique = jest.fn();
const mockClassMemberFindFirst = jest.fn();
const mockQuizQuestionFindFirst = jest.fn();
const mockQuizAnswerUpsert = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    session: { findUnique: mockSessionFindUnique },
    classMember: { findFirst: mockClassMemberFindFirst },
    quizQuestion: { findFirst: mockQuizQuestionFindFirst },
    quizAnswer: { upsert: mockQuizAnswerUpsert },
  })),
}));

let serverInstance;
let ioInstance;

function post(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
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
    req.write(bodyStr);
    req.end();
  });
}

function makeToken(userId) {
  return jwt.sign({ userId, role: 'student' }, JWT_SECRET, { expiresIn: '1h' });
}

function getKSTDateString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

function dailyKeyFor(userId) {
  return `quiz:count:${userId}:${getKSTDateString()}`;
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

beforeEach(() => {
  jest.clearAllMocks();

  mockSessionFindUnique.mockResolvedValue({ classId: CLASS_ID, status: 'ARCHIVED' });
  mockClassMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockQuizQuestionFindFirst.mockImplementation(({ where }) =>
    VALID_QUESTION_IDS.includes(where.id) ? Promise.resolve({ answer: 'O' }) : Promise.resolve(null),
  );
  mockQuizAnswerUpsert.mockResolvedValue({});
});

test('1. isRetryStart 없이 첫 응시 3문항을 제출해도 daily count가 증가하지 않는다', async () => {
  const userId = `student-185-1-${Date.now()}`;
  const token = makeToken(userId);

  for (const questionId of VALID_QUESTION_IDS) {
    const res = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId, answer: 'O' }, token);
    expect(res.status).toBe(200);
  }

  const count = await redis.get(dailyKeyFor(userId));
  expect(count).toBeNull();

  await redis.del(dailyKeyFor(userId));
});

test('2~3. 재응시 시작 1회, 2회는 통과하고 3번째 재응시 시작은 429를 반환한다', async () => {
  const userId = `student-185-2-${Date.now()}`;
  const token = makeToken(userId);

  // 1차 재응시 세트 (첫 문항만 isRetryStart:true)
  const retry1 = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: 'q1', answer: 'O', isRetryStart: true }, token);
  expect(retry1.status).toBe(200);
  const retry1Rest = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: 'q2', answer: 'O' }, token);
  expect(retry1Rest.status).toBe(200);

  // 2차 재응시 세트
  const retry2 = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: 'q1', answer: 'X', isRetryStart: true }, token);
  expect(retry2.status).toBe(200);

  // 3차 재응시 세트 — 한도 초과
  const retry3 = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: 'q1', answer: 'O', isRetryStart: true }, token);
  expect(retry3.status).toBe(429);
  expect(retry3.json.code).toBe('QUIZ_DAILY_LIMIT_EXCEEDED');

  await redis.del(dailyKeyFor(userId));
});

test('4. isRetryStart가 boolean이 아니면 400을 반환한다', async () => {
  const userId = `student-185-4-${Date.now()}`;
  const token = makeToken(userId);

  const res = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: 'q1', answer: 'O', isRetryStart: 'true' }, token);
  expect(res.status).toBe(400);

  await redis.del(dailyKeyFor(userId));
});

test('5. 잘못된 questionId로 재응시를 시작하면 404를 반환하고 daily count는 소모되지 않는다', async () => {
  const userId = `student-185-5-${Date.now()}`;
  const token = makeToken(userId);

  const badRes = await post(
    `/sessions/${SESSION_ID}/quiz/submit`,
    { questionId: INVALID_QUESTION_ID, answer: 'O', isRetryStart: true },
    token,
  );
  expect(badRes.status).toBe(404);

  const count = await redis.get(dailyKeyFor(userId));
  expect(count).toBeNull();

  // 정상 questionId로 재응시를 시작하면 여전히 1회차로 처리되어야 함
  const goodRes = await post(
    `/sessions/${SESSION_ID}/quiz/submit`,
    { questionId: 'q1', answer: 'O', isRetryStart: true },
    token,
  );
  expect(goodRes.status).toBe(200);
  expect(await redis.get(dailyKeyFor(userId))).toBe('1');

  await redis.del(dailyKeyFor(userId));
});
