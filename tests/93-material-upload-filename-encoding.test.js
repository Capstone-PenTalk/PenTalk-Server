/**
 * POST /materials/pdf 한글 파일명 인코딩 회귀 테스트
 *
 * 실행: npx jest tests/93-material-upload-filename-encoding.test.js --runInBand --forceExit
 *
 * multipart/form-data는 파일명 인코딩을 명시하지 않아 multer(busboy)가 기본적으로
 * latin1로 디코딩한다. 클라이언트가 UTF-8로 보낸 한글 파일명을 그대로 저장하면 깨지므로,
 * saveFile()이 latin1 -> utf8로 재해석한 이름을 반환하는지 검증한다.
 *
 * Prisma, S3: jest.mock 처리
 */
require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');

const PORT = 3102;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CLASS_ID = 'test-class-93';
const TEACHER_ID = 'test-teacher-93';

// ── Prisma mock ────────────────────────────────────────────────────────────
const mockClassFindUnique = jest.fn();
const mockMaterialCreate = jest.fn();
const mockMaterialDelete = jest.fn();
const mockMaterialPageCreateMany = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    class: { findUnique: mockClassFindUnique },
    material: { create: mockMaterialCreate, delete: mockMaterialDelete },
    materialPage: { createMany: mockMaterialPageCreateMany },
  })),
}));

// ── S3 mock ────────────────────────────────────────────────────────────────
jest.mock('../src/lib/s3', () => ({
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
  uploadString: jest.fn().mockResolvedValue(undefined),
  downloadString: jest.fn().mockResolvedValue(''),
  getPresignedUrl: jest.fn().mockResolvedValue('https://example.com/presigned'),
}));

// ── PDF 래스터화 mock (실제 pdftoppm 바이너리/유효한 PDF 구조 불필요) ────────────
jest.mock('../src/upload/pdfRasterize', () => ({
  rasterizePdfToPages: jest.fn().mockResolvedValue([
    { pageNumber: 1, imageKey: 'pdfs/pages/material-93/1.png', width: 100, height: 100 },
  ]),
}));

let serverInstance;
let ioInstance;

function makeToken(userId = TEACHER_ID, role = 'teacher') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// multer/busboy가 실제로 겪는 상황을 그대로 재현: 파일명을 UTF-8 바이트로 헤더에 실어 보낸다.
function postMultipartPdf({ classId, filename, token }) {
  return new Promise((resolve, reject) => {
    const boundary = `----jestBoundary${Date.now()}`;
    const filenameBytes = Buffer.from(filename, 'utf8');

    const preFile = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="classId"\r\n\r\n` +
      `${classId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="`,
      'utf8',
    );
    const postFile = Buffer.from(
      `"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`,
      'utf8',
    );
    const pdfBody = Buffer.from('%PDF-1.4 fake pdf content', 'utf8');
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    const body = Buffer.concat([preFile, filenameBytes, postFile, pdfBody, closing]);

    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: '/materials/pdf',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
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
    req.write(body);
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
  mockClassFindUnique.mockResolvedValue({ id: CLASS_ID, teacherId: TEACHER_ID });
  mockMaterialCreate.mockImplementation(({ data }) =>
    Promise.resolve({ id: 'material-93', type: data.type, url: data.url, name: data.name, classId: data.classId, createdAt: new Date() }),
  );
  mockMaterialPageCreateMany.mockResolvedValue({ count: 1 });
  mockMaterialDelete.mockResolvedValue({});
});

describe('POST /materials/pdf 파일명 인코딩', () => {
  test('한글 파일명이 깨지지 않고 그대로 저장됨', async () => {
    const filename = '수업자료_1주차.pdf';

    const res = await postMultipartPdf({ classId: CLASS_ID, filename, token: makeToken() });

    expect(res.status).toBe(201);
    expect(res.json?.name).toBe(filename);
    expect(mockMaterialCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: filename }) }),
    );
  });

  test('영문 파일명도 그대로 저장됨 (회귀 방지)', async () => {
    const filename = 'lecture-note-01.pdf';

    const res = await postMultipartPdf({ classId: CLASS_ID, filename, token: makeToken() });

    expect(res.status).toBe(201);
    expect(res.json?.name).toBe(filename);
  });
});
