// src/utils/httpError.js
function sendHttpError(res, status, code, message) {
  return res.status(status).json({ code, message });
}

module.exports = { sendHttpError };
