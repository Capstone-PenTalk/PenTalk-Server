// src/upload/uploadStorage.js
// ✅ #93: PDF 업로드 모듈
// 디스크 저장은 multer.diskStorage가 담당하고, saveFile()은 저장된 파일의 접근 URL을 생성하는 역할.
// S3 전환 시: multer storage를 multer-s3로 교체하고 saveFile()에서 S3 URL을 반환하도록 수정.

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PDF_DIR = path.join(__dirname, '..', '..', 'storage', 'pdfs');
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PDF_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

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

// ── URL 생성 ──────────────────────────────────────────────────
// ⚠️ req.protocol은 nginx/EC2 등 reverse proxy 뒤에서 http로 잘못 잡힐 수 있음.
//    배포 환경에서는 server.js에 app.set('trust proxy', 1) 설정 여부를 확인할 것.
async function saveFile(req, file) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/pdfs/${file.filename}`;
  return { url };
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

module.exports = { upload, saveFile };
