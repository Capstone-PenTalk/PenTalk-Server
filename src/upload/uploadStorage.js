// src/upload/uploadStorage.js
// ✅ #108: PDF 업로드를 S3로 변경. material.url에는 S3 key 저장 (URL 아님). 조회 시 presigned URL로 변환.

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { uploadBuffer } = require('../lib/s3');

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  // mimetype + 확장자 이중 체크 (mimetype은 클라이언트 조작 가능)
  if (file.mimetype === 'application/pdf' && ext === '.pdf') {
    cb(null, true);
  } else {
    const err = new Error('PDF only');
    err.code = 'FILE_TYPE_INVALID';
    cb(err, false);
  }
}

async function saveFile(req, file) {
  // material.url에는 S3 key를 저장 (URL 아님). 조회 시 presigned URL로 변환.
  const key = `pdfs/${req.userId}/${uuidv4()}.pdf`;
  await uploadBuffer(key, file.buffer, 'application/pdf');
  return { url: key };
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

module.exports = { upload, saveFile };
