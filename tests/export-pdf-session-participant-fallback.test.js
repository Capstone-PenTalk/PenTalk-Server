/**
 * POST /export/pdf - Redis participants Set 미스/장애 시 SessionParticipant DB fallback 테스트
 *
 * 실행: npx jest tests/export-pdf-session-participant-fallback.test.js --runInBand --forceExit
 *
 * 배경: 세션 종료 후 Redis `session:{id}:participants` Set은 TTL(최대 몇 시간)로 사라진다.
 * 그 이후에도 정상 참여 이력이 있는 사용자는 export가 되어야 하므로, Redis 미스/에러 시
 * 영구 보존되는 SessionParticipant 테이블로 한 번 더 확인하도록 fallback을 추가했다.
 * 단 이 fallback은 "참여 여부"만 대체할 뿐, 퀴즈 통과 게이트(학생만 2문제 이상 정답)는 그대로 유지된다.
 *
 * Prisma: jest.mock 처리. Redis: jest.mock으로 sismember만 제어(다른 redis 메서드는 실 인스턴스 사용 안 함).
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');

const PORT = 3107;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_ID = 'test-session-export-fallback-1';
const CLASS_ID = 'test-class-export-fallback-1';
const MATERIAL_URL = 'https://test-storage.example.com/export-fallback-sample.pdf';

// ── Prisma mock ────────────────────────────────────────────────────────────
const mockSessionFindUnique = jest.fn();
const mockClassMemberFindFirst = jest.fn();
const mockSessionParticipantFindUnique = jest.fn();
const mockQuizAnswerCount = jest.fn();
const mockUserFindUnique = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    session: { findUnique: mockSessionFindUnique },
    classMember: { findFirst: mockClassMemberFindFirst },
    sessionParticipant: { findUnique: mockSessionParticipantFindUnique },
    quizAnswer: { count: mockQuizAnswerCount },
    user: { findUnique: mockUserFindUnique },
  })),
}));

// ── Redis mock (sismember만 제어) ────────────────────────────────────────────
const mockSismember = jest.fn();
jest.mock('../src/lib/redis', () => ({
  sismember: (...args) => mockSismember(...args),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  mget: jest.fn().mockResolvedValue([]),
  quit: jest.fn().mockResolvedValue('OK'),
}));

let serverInstance;
let ioInstance;
let minimalPdfBuffer;
let originalFetch;

function makeToken(userId = 'test-student-export-fallback', role = 'student') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

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
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function makeSession(overrides = {}) {
  return {
    id: SESSION_ID,
    classId: CLASS_ID,
    status: 'ARCHIVED',
    drawingPath: null,
    material: { url: MATERIAL_URL },
    ...overrides,
  };
}

beforeAll(async () => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([595, 842]);
  minimalPdfBuffer = Buffer.from(await pdfDoc.save());

  originalFetch = global.fetch;
  global.fetch = jest.fn((url) => {
    if (url === MATERIAL_URL) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => {
          const ab = new ArrayBuffer(minimalPdfBuffer.length);
          new Uint8Array(ab).set(minimalPdfBuffer);
          return ab;
        },
      });
    }
    return Promise.reject(new Error(`unmocked fetch: ${url}`));
  });

  const { server, io } = require('../src/server');
  serverInstance = server;
  ioInstance = io;
  await new Promise((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  global.fetch = originalFetch;
  ioInstance.close();
  await new Promise((resolve) => serverInstance.close(resolve));
}, 20000);

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionFindUnique.mockResolvedValue(makeSession());
  mockClassMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockUserFindUnique.mockResolvedValue({ name: '테스트학생' });
  // 학생 퀴즈 통과 기본값: 2문제 이상 정답
  mockQuizAnswerCount.mockResolvedValue(2);
});

describe('POST /export/pdf - SessionParticipant fallback', () => {
  test('Redis participants 미스 + DB 참여 기록 있음 → 200 성공', async () => {
    mockSismember.mockResolvedValue(0);
    mockSessionParticipantFindUnique.mockResolvedValue({ id: 'participant-1' });

    const res = await post('/export/pdf', { sessionId: SESSION_ID, strokes: [] }, makeToken());

    expect(res.status).toBe(200);
    expect(mockSessionParticipantFindUnique).toHaveBeenCalledWith({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: 'test-student-export-fallback' } },
      select: { id: true },
    });
  });

  test('Redis sismember가 에러로 throw해도 DB 참여 기록으로 fallback → 200 성공', async () => {
    mockSismember.mockRejectedValue(new Error('redis connection lost'));
    mockSessionParticipantFindUnique.mockResolvedValue({ id: 'participant-1' });

    const res = await post('/export/pdf', { sessionId: SESSION_ID, strokes: [] }, makeToken());

    expect(res.status).toBe(200);
    expect(mockSessionParticipantFindUnique).toHaveBeenCalled();
  });

  test('Redis 미스 + DB 참여 기록도 없음 → 403 NOT_SESSION_MEMBER', async () => {
    mockSismember.mockResolvedValue(0);
    mockSessionParticipantFindUnique.mockResolvedValue(null);

    const res = await post('/export/pdf', { sessionId: SESSION_ID, strokes: [] }, makeToken());

    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('FORBIDDEN');
    expect(res.json?.message).toBe('NOT_SESSION_MEMBER');
  });

  test('Redis에 참여 기록 있으면 DB는 조회하지 않음', async () => {
    mockSismember.mockResolvedValue(1);

    const res = await post('/export/pdf', { sessionId: SESSION_ID, strokes: [] }, makeToken());

    expect(res.status).toBe(200);
    expect(mockSessionParticipantFindUnique).not.toHaveBeenCalled();
  });

  test('DB 참여 기록으로 통과해도 학생 퀴즈 미통과면 여전히 403 QUIZ_NOT_PASSED', async () => {
    mockSismember.mockResolvedValue(0);
    mockSessionParticipantFindUnique.mockResolvedValue({ id: 'participant-1' });
    mockQuizAnswerCount.mockResolvedValue(1); // 2문제 미만 → 미통과

    const res = await post('/export/pdf', { sessionId: SESSION_ID, strokes: [] }, makeToken());

    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('QUIZ_NOT_PASSED');
  });
});
