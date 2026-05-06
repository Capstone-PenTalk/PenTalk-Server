/**
 * #61 PDF export 통합 테스트
 *
 * 실행: npx jest tests/61-export-pdf.test.js --runInBand --forceExit
 *
 * 전제: Redis 실행 중
 * Prisma: jest.mock 처리
 * fetch: global.fetch mock 처리 (MATERIAL_URL만 가로챔)
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const redis = require('../src/lib/redis');
const { PDFDocument } = require('pdf-lib');

const PORT = 3101;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const SESSION_ID = `test-session-61-${Date.now()}`;
const CLASS_ID = 'test-class-61';
const MATERIAL_URL = 'https://test-storage.example.com/sample.pdf';

// ── Prisma mock ────────────────────────────────────────────────────────────
// "mock"으로 시작하는 변수는 jest.mock factory 내에서 참조 가능 (Jest 특례)
const mockFindUnique = jest.fn();
const mockFindFirst = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    session: { findUnique: mockFindUnique },
    classMember: { findFirst: mockFindFirst },
  })),
}));

// ── 전역 변수 ──────────────────────────────────────────────────────────────
let minimalPdfBuffer;
let tmpDrawingPath;
let serverInstance;
let ioInstance;
let originalFetch;

// 학생 필기 샘플
const SAMPLE_STUDENT_STROKES = [
  {
    sId: 'student-s1',
    c: '#0000FF',
    w: 2,
    page: 1,
    points: [
      { x: 0.5, y: 0.5, p: 0.8 },
      { x: 0.6, y: 0.6, p: 0.8 },
    ],
  },
];

// ── HTTP 헬퍼 ──────────────────────────────────────────────────────────────
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
          resolve({ status: res.statusCode, headers: res.headers, buf, json });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function makeToken(userId = 'test-user-61', role = 'student') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function makePdfFetchResponse() {
  return Promise.resolve({
    ok: true,
    arrayBuffer: async () => {
      const ab = new ArrayBuffer(minimalPdfBuffer.length);
      new Uint8Array(ab).set(minimalPdfBuffer);
      return ab;
    },
  });
}

function makeSession(overrides = {}) {
  return {
    id: SESSION_ID,
    classId: CLASS_ID,
    status: 'ACTIVE',
    drawingPath: null,
    material: { url: MATERIAL_URL },
    ...overrides,
  };
}

async function cleanupRedis() {
  await redis.del(`whiteboard:${SESSION_ID}`);
}

// ── 셋업 / 정리 ───────────────────────────────────────────────────────────
beforeAll(async () => {
  // 최소 테스트용 PDF 생성 (A4 1페이지)
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([595, 842]);
  minimalPdfBuffer = Buffer.from(await pdfDoc.save());

  // 교사 판서 임시 파일 (ARCHIVED 세션 테스트용)
  tmpDrawingPath = path.join(os.tmpdir(), `wb-61-${Date.now()}.json`);
  fs.writeFileSync(tmpDrawingPath, JSON.stringify({
    strokes: [
      {
        sId: 'teacher-s1', c: '#FF0000', w: 3, page: 1, t: 1,
        points: [{ x: 0.1, y: 0.1, p: 0.8 }, { x: 0.2, y: 0.2, p: 0.8 }],
      },
    ],
  }));

  // global.fetch mock: MATERIAL_URL만 처리, 그 외는 에러
  originalFetch = global.fetch;
  global.fetch = jest.fn((url) => {
    if (url === MATERIAL_URL) return makePdfFetchResponse();
    return Promise.reject(new Error(`unmocked fetch: ${url}`));
  });

  const { server, io } = require('../src/server');
  serverInstance = server;
  ioInstance = io;
  await new Promise((resolve) => server.listen(PORT, resolve));
});

afterAll(async () => {
  try { fs.unlinkSync(tmpDrawingPath); } catch (_) {}
  await cleanupRedis();
  global.fetch = originalFetch;
  ioInstance.close();
  await new Promise((resolve) => serverInstance.close(resolve));
}, 20000);

beforeEach(async () => {
  jest.clearAllMocks();

  // fetch mock 기본값 복원 (clearAllMocks로 구현체가 초기화됨)
  global.fetch.mockImplementation((url) => {
    if (url === MATERIAL_URL) return makePdfFetchResponse();
    return Promise.reject(new Error(`unmocked fetch: ${url}`));
  });

  // Redis 교사 판서 기본값 (ACTIVE 세션 테스트용)
  await redis.set(
    `whiteboard:${SESSION_ID}`,
    JSON.stringify({
      strokes: [
        {
          sId: 'teacher-s1', c: '#FF0000', w: 2, page: 1, t: 1,
          points: [{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.2, y: 0.2, p: 0.5 }],
        },
      ],
    }),
    'EX', 3600,
  );

  // 기본값: 클래스 멤버
  mockFindFirst.mockResolvedValue({ id: 'membership-1' });
});

afterEach(async () => {
  await cleanupRedis();
});

// ──────────────────────────────────────────────────────────────────────────
describe('POST /export/pdf', () => {

  // ── 정상 케이스 ──────────────────────────────────────────────────────────
  describe('정상 케이스', () => {
    test('ACTIVE 세션: 교사 판서(Redis) + 학생 필기 합성 → PDF binary 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession({ status: 'ACTIVE' }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: SAMPLE_STUDENT_STROKES },
        makeToken(),
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch('application/pdf');
      expect(res.headers['content-disposition']).toContain(SESSION_ID);
      expect(res.buf.length).toBeGreaterThan(0);
    });

    test('ARCHIVED 세션: 교사 판서(파일) + 학생 필기 합성 → PDF binary 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession({
        status: 'ARCHIVED',
        drawingPath: tmpDrawingPath,
      }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: SAMPLE_STUDENT_STROKES },
        makeToken(),
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch('application/pdf');
    });

    test('strokes 필드 없음 → 교사 판서만 합성 → PDF 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession());

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID },
        makeToken(),
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch('application/pdf');
    });

    test('strokes 빈 배열 → PDF 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession());

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });

    test('page 범위 초과 stroke → skip 후 PDF 정상 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession());

      const strokes = [
        {
          sId: 'out', c: '#000000', w: 2, page: 99, // PDF는 1페이지
          points: [{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.2, y: 0.2, p: 0.5 }],
        },
      ];

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });

    test('eraser stroke → skip 후 PDF 정상 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession());

      const strokes = [
        {
          sId: 'e1', tool: 'eraser', page: 1,
          points: [{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.2, y: 0.2, p: 0.5 }],
        },
      ];

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });

    test('Flutter ARGB int color → PDF 정상 렌더링', async () => {
      mockFindUnique.mockResolvedValue(makeSession());

      const strokes = [
        {
          sId: 'f1',
          color: 4278190080, // Flutter Color.value: 0xFF000000 (black)
          width: 3.0,
          page: 1,
          points: [{ x: 0.1, y: 0.1, p: 0.8 }, { x: 0.2, y: 0.2, p: 0.8 }],
        },
      ];

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });

    test('NaN/Infinity 좌표 stroke → 해당 선분 skip 후 PDF 정상 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession());

      const strokes = [
        {
          sId: 'nan1', c: '#000000', w: 2, page: 1,
          points: [
            { x: NaN, y: 0.1, p: 0.5 },
            { x: 0.2, y: Infinity, p: 0.5 },
            { x: 0.3, y: 0.3, p: 0.5 }, // 이 선분은 앞 점이 Infinity라 skip
            { x: 0.4, y: 0.4, p: 0.5 }, // 정상 선분
          ],
        },
      ];

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });
  });

  // ── 인증 / 권한 ──────────────────────────────────────────────────────────
  describe('인증 / 권한', () => {
    test('토큰 없음 → 401', async () => {
      const res = await post('/export/pdf', { sessionId: SESSION_ID });
      expect(res.status).toBe(401);
    });

    test('유효하지 않은 토큰 → 401', async () => {
      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID },
        'invalid.token.here',
      );
      expect(res.status).toBe(401);
    });

    test('클래스 비멤버 → 403 FORBIDDEN', async () => {
      mockFindUnique.mockResolvedValue(makeSession());
      mockFindFirst.mockResolvedValue(null); // 멤버십 없음

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(403);
      expect(res.json?.code).toBe('FORBIDDEN');
    });
  });

  // ── 입력 검증 ────────────────────────────────────────────────────────────
  describe('입력 검증', () => {
    test('sessionId 없음 → 400 PAYLOAD_INVALID', async () => {
      const res = await post('/export/pdf', {}, makeToken());
      expect(res.status).toBe(400);
      expect(res.json?.code).toBe('PAYLOAD_INVALID');
    });

    test('strokes가 배열이 아닌 값 → 400 PAYLOAD_INVALID', async () => {
      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: 'not-an-array' },
        makeToken(),
      );
      expect(res.status).toBe(400);
      expect(res.json?.code).toBe('PAYLOAD_INVALID');
    });

    test('strokes 수 초과 (3001개) → 400 PAYLOAD_INVALID', async () => {
      const tooMany = Array.from({ length: 3001 }, (_, i) => ({
        sId: `s${i}`, c: '#000000', w: 1, page: 1,
        points: [{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.2, y: 0.2, p: 0.5 }],
      }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: tooMany },
        makeToken(),
      );

      expect(res.status).toBe(400);
      expect(res.json?.code).toBe('PAYLOAD_INVALID');
    });

    test('총 point 수 초과 (100stroke × 600pt = 60000 > 50000) → 400 PAYLOAD_INVALID', async () => {
      const heavyStrokes = Array.from({ length: 100 }, (_, i) => ({
        sId: `s${i}`, c: '#000000', w: 1, page: 1,
        points: Array.from({ length: 600 }, () => ({ x: 0.1, y: 0.1, p: 0.5 })),
      }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: heavyStrokes },
        makeToken(),
      );

      expect(res.status).toBe(400);
      expect(res.json?.code).toBe('PAYLOAD_INVALID');
    });
  });

  // ── 데이터 에러 ──────────────────────────────────────────────────────────
  describe('데이터 에러', () => {
    test('세션 없음 → 404 SESSION_NOT_FOUND', async () => {
      mockFindUnique.mockResolvedValue(null);

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(404);
      expect(res.json?.code).toBe('SESSION_NOT_FOUND');
    });

    test('material 없음 → 400 MATERIAL_NOT_FOUND', async () => {
      mockFindUnique.mockResolvedValue(makeSession({ material: null }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(400);
      expect(res.json?.code).toBe('MATERIAL_NOT_FOUND');
    });

    test('PDF fetch 실패 (원격 4xx/5xx) → 502 PDF_FETCH_FAILED', async () => {
      mockFindUnique.mockResolvedValue(makeSession());
      global.fetch.mockImplementation((url) => {
        if (url === MATERIAL_URL) return Promise.resolve({ ok: false, status: 404 });
        return Promise.reject(new Error(`unmocked: ${url}`));
      });

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(502);
      expect(res.json?.code).toBe('PDF_FETCH_FAILED');
    });

    test('PDF fetch 네트워크 에러 → 502 PDF_FETCH_FAILED', async () => {
      mockFindUnique.mockResolvedValue(makeSession());
      global.fetch.mockImplementation(() => Promise.reject(new Error('network error')));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(502);
      expect(res.json?.code).toBe('PDF_FETCH_FAILED');
    });

    test('ARCHIVED + drawingPath 있는데 파일 없음 → 500 PDF_EXPORT_FAILED', async () => {
      mockFindUnique.mockResolvedValue(makeSession({
        status: 'ARCHIVED',
        drawingPath: '/nonexistent/path/drawing-61.json',
      }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: [] },
        makeToken(),
      );

      expect(res.status).toBe(500);
      expect(res.json?.code).toBe('PDF_EXPORT_FAILED');
    });
  });

  // ── soft fail (응답 성공) ─────────────────────────────────────────────────
  describe('soft fail (응답은 성공)', () => {
    test('ACTIVE 세션 Redis miss → 교사 판서 없이 PDF 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession({ status: 'ACTIVE' }));
      await cleanupRedis(); // Redis miss 유도

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: SAMPLE_STUDENT_STROKES },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });

    test('ARCHIVED + drawingPath null → 교사 판서 없이 PDF 반환', async () => {
      mockFindUnique.mockResolvedValue(makeSession({
        status: 'ARCHIVED',
        drawingPath: null,
      }));

      const res = await post(
        '/export/pdf',
        { sessionId: SESSION_ID, strokes: SAMPLE_STUDENT_STROKES },
        makeToken(),
      );

      expect(res.status).toBe(200);
    });
  });
});
