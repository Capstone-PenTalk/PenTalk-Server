/**
 * GET /materials/:materialId/download-url 권한 테스트
 *
 * 실행: npx jest tests/materials-download-url-session-access.test.js --runInBand --forceExit
 *
 * 배경: ClassMember만 확인하던 기존 로직 때문에 QR/비밀번호로 세션에 참여한 학생(ClassMember 아님)이
 * 원본 PDF 다운로드에서 403(NOT_CLASS_MEMBER)을 받던 문제를 수정. ClassMember가 아니어도
 * SessionParticipant(세션 종료 후에도 영구 보존되는 참여 기록) 기준으로 sessionId+materialId가
 * 일치하면 허용하도록 fallback을 추가했다. 퀴즈 통과 여부는 이 엔드포인트와 무관(원본 다운로드에는
 * 퀴즈 게이트 없음).
 *
 * Prisma, S3: jest.mock 처리
 */
require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');

const PORT = 3106;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const MATERIAL_ID = 'test-material-download-1';
const CLASS_ID = 'test-class-download-1';
const SESSION_ID = 'test-session-download-1';
const USER_ID = 'test-user-download-1';
const MATERIAL_URL_KEY = 'pdfs/test-teacher/sample.pdf';

// ── Prisma mock ────────────────────────────────────────────────────────────
const mockMaterialFindUnique = jest.fn();
const mockClassMemberFindFirst = jest.fn();
const mockSessionParticipantFindFirst = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    material: { findUnique: mockMaterialFindUnique },
    classMember: { findFirst: mockClassMemberFindFirst },
    sessionParticipant: { findFirst: mockSessionParticipantFindFirst },
  })),
}));

// ── S3 mock ────────────────────────────────────────────────────────────────
jest.mock('../src/lib/s3', () => ({
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
  uploadString: jest.fn().mockResolvedValue(undefined),
  downloadString: jest.fn().mockResolvedValue(''),
  getPresignedUrl: jest.fn().mockResolvedValue('https://example.com/presigned-download'),
}));

let serverInstance;
let ioInstance;

function makeToken(userId = USER_ID, role = 'student') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

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
  mockMaterialFindUnique.mockResolvedValue({ url: MATERIAL_URL_KEY, classId: CLASS_ID });
});

describe('GET /materials/:materialId/download-url', () => {
  test('토큰 없음 → 401', async () => {
    const res = await get(`/materials/${MATERIAL_ID}/download-url`);
    expect(res.status).toBe(401);
  });

  test('자료 없음 → 404 MATERIAL_NOT_FOUND', async () => {
    mockMaterialFindUnique.mockResolvedValue(null);

    const res = await get(`/materials/${MATERIAL_ID}/download-url`, makeToken());

    expect(res.status).toBe(404);
    expect(res.json?.code).toBe('MATERIAL_NOT_FOUND');
  });

  test('ClassMember면 sessionId 없이도 다운로드 URL 발급', async () => {
    mockClassMemberFindFirst.mockResolvedValue({ id: 'membership-1' });

    const res = await get(`/materials/${MATERIAL_ID}/download-url`, makeToken());

    expect(res.status).toBe(200);
    expect(res.json?.url).toBe('https://example.com/presigned-download');
    expect(mockSessionParticipantFindFirst).not.toHaveBeenCalled();
  });

  test('ClassMember 아니어도 sessionId로 세션 참여 이력이 있으면 다운로드 URL 발급', async () => {
    mockClassMemberFindFirst.mockResolvedValue(null);
    mockSessionParticipantFindFirst.mockResolvedValue({ id: 'participant-1' });

    const res = await get(
      `/materials/${MATERIAL_ID}/download-url?sessionId=${SESSION_ID}`,
      makeToken(),
    );

    expect(res.status).toBe(200);
    expect(res.json?.url).toBe('https://example.com/presigned-download');
    expect(mockSessionParticipantFindFirst).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        session: { id: SESSION_ID, classId: CLASS_ID, materialId: MATERIAL_ID },
      },
      select: { id: true },
    });
  });

  test('ClassMember 아니고 세션 참여 이력도 없으면 403 NOT_CLASS_MEMBER', async () => {
    mockClassMemberFindFirst.mockResolvedValue(null);
    mockSessionParticipantFindFirst.mockResolvedValue(null);

    const res = await get(
      `/materials/${MATERIAL_ID}/download-url?sessionId=${SESSION_ID}`,
      makeToken(),
    );

    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('FORBIDDEN');
  });

  test('ClassMember 아니고 sessionId도 안 보내면 403 NOT_CLASS_MEMBER (DB fallback 조회 자체를 안 함)', async () => {
    mockClassMemberFindFirst.mockResolvedValue(null);

    const res = await get(`/materials/${MATERIAL_ID}/download-url`, makeToken());

    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('FORBIDDEN');
    expect(mockSessionParticipantFindFirst).not.toHaveBeenCalled();
  });

  test('다른 세션의 SessionParticipant 기록이 있어도, 그 세션이 요청 materialId/classId와 안 맞으면 403 (findFirst 조건에 위임되어 결과 null)', async () => {
    mockClassMemberFindFirst.mockResolvedValue(null);
    // 참여자 테이블엔 기록이 있지만, where 조건(session.id/classId/materialId 불일치)에 안 걸려 null 반환된 상황을 모킹
    mockSessionParticipantFindFirst.mockResolvedValue(null);

    const res = await get(
      `/materials/${MATERIAL_ID}/download-url?sessionId=other-session`,
      makeToken(),
    );

    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('FORBIDDEN');
    expect(mockSessionParticipantFindFirst).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        session: { id: 'other-session', classId: CLASS_ID, materialId: MATERIAL_ID },
      },
      select: { id: true },
    });
  });
});
