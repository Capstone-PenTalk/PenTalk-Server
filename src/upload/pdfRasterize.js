// src/upload/pdfRasterize.js
// 교사/학생 기기별 PDF 렌더러(PDFKit vs PdfRenderer) 차이로 판서 좌표가 어긋나는 문제 해결.
// 업로드 시점에 PDF 각 페이지를 서버가 PNG로 래스터화해서 S3에 저장 -> 모든 클라이언트가 동일 이미지 기준으로 렌더링.

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument } = require('pdf-lib');
const { uploadBuffer } = require('../lib/s3');
const { APP_CONFIG } = require('../../config/appConfig');
const { logger } = require('../utils/logger');

const execFileAsync = promisify(execFile);

const PAGE_FILE_PATTERN = /^page-?(\d+)\.png$/;

// pdftoppm 출력은 항상 유효한 PNG이므로 IHDR 헤더(오프셋 16/20)에서 직접 치수 추출 (별도 의존성 불필요)
function readPngDimensions(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function rasterizePdfToPages(pdfBuffer, materialId) {
  const tmpDir = path.join(os.tmpdir(), `pdfraster-${materialId}-${uuidv4()}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    const inputPath = path.join(tmpDir, 'input.pdf');
    await fsp.writeFile(inputPath, pdfBuffer);

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const expectedPageCount = pdfDoc.getPageCount();

    const outPrefix = path.join(tmpDir, 'page');
    try {
      await execFileAsync('pdftoppm', ['-png', '-r', String(APP_CONFIG.PDF_RASTERIZE_DPI), inputPath, outPrefix]);
    } catch (err) {
      logger.error('pdftoppm rasterize failed', {
        materialId,
        code: err.code,
        stderr: err.stderr,
      });
      throw err;
    }

    const entries = await fsp.readdir(tmpDir);
    const pageFiles = entries
      .map((name) => {
        const match = name.match(PAGE_FILE_PATTERN);
        return match ? { name, pageNumber: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.pageNumber - b.pageNumber);

    if (pageFiles.length === 0 || pageFiles.length !== expectedPageCount) {
      logger.error('pdftoppm output page count mismatch', {
        materialId,
        expectedPageCount,
        actualPageCount: pageFiles.length,
      });
      throw new Error('PDF_RASTERIZE_PAGE_COUNT_MISMATCH');
    }

    const pages = [];
    for (const { name, pageNumber } of pageFiles) {
      const buf = await fsp.readFile(path.join(tmpDir, name));
      const { width, height } = readPngDimensions(buf);
      const imageKey = `pdfs/pages/${materialId}/${pageNumber}.png`;
      await uploadBuffer(imageKey, buf, 'image/png');
      pages.push({ pageNumber, imageKey, width, height });
    }

    return pages;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { rasterizePdfToPages };
