/**
 * 퀴즈 재응시 채점 회귀 테스트
 *
 * 실행: npx jest tests/quiz-submit-retake.test.js --runInBand --forceExit
 *
 * 전제: Redis 실행 중
 * Prisma: jest.mock 처리
 *
 * 검증 대상: POST /sessions/:sessionId/quiz/submit 에서
 * 같은 문항에 재응시(오답 → 정답)했을 때 upsert로 최신 답안 기준 재채점되는지 확인.
 * (기존 create+P2002 캐치 방식은 재응시 시 예전 결과를 그대로 반환하는 버그가 있었음)
 */
require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');

const PORT = 3102;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_ID = `test-session-quiz-${Date.now()}`;
const CLASS_ID = 'test-class-quiz';
const QUESTION_ID = 'test-question-quiz-1';
const USER_ID = `test-student-quiz-1-${Date.now()}`;
const USER_ID_2 = `test-student-quiz-2-${Date.now()}`;

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

function makeToken(userId = USER_ID, role = 'student') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

async function cleanupRedis() {
  const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  await redis.del(`quiz:count:${USER_ID}:${kstDate}`);
  await redis.del(`quiz:count:${USER_ID_2}:${kstDate}`);
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

  mockSessionFindUnique.mockResolvedValue({ classId: CLASS_ID, status: 'ARCHIVED' });
  mockClassMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockQuizQuestionFindFirst.mockResolvedValue({ answer: 'O' });
  mockQuizAnswerUpsert.mockResolvedValue({});
});

test('오답 제출 후 재응시로 정답 제출 시 isCorrect가 true로 갱신된다', async () => {
  const token = makeToken();

  // 1차 시도: 오답
  const first = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: QUESTION_ID, answer: 'X' }, token);
  expect(first.status).toBe(200);
  expect(first.json.isCorrect).toBe(false);
  expect(first.json.submittedAnswer).toBe('X');

  // 2차 시도(재응시): 정답
  const second = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: QUESTION_ID, answer: 'O' }, token);
  expect(second.status).toBe(200);
  expect(second.json.isCorrect).toBe(true);
  expect(second.json.submittedAnswer).toBe('O');
  expect(second.json.correctAnswer).toBe('O');

  // upsert가 두 번 호출됐고, 두 번째 호출은 최신(정답) 답안으로 update 되었는지 확인
  expect(mockQuizAnswerUpsert).toHaveBeenCalledTimes(2);
  const secondCallArgs = mockQuizAnswerUpsert.mock.calls[1][0];
  expect(secondCallArgs.where).toEqual({
    sessionId_questionId_userId: { sessionId: SESSION_ID, questionId: QUESTION_ID, userId: USER_ID },
  });
  expect(secondCallArgs.update).toEqual({ submittedAnswer: 'O', isCorrect: true });
});

test('정답을 최초 제출하면 isCorrect가 true로 내려온다', async () => {
  const token = makeToken(USER_ID_2);

  const res = await post(`/sessions/${SESSION_ID}/quiz/submit`, { questionId: QUESTION_ID, answer: 'O' }, token);
  expect(res.status).toBe(200);
  expect(res.json.isCorrect).toBe(true);
  expect(res.json.submittedAnswer).toBe('O');
});
