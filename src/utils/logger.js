// src/utils/logger.js
function nowIso() {
  return new Date().toISOString();
}

function formatMeta(meta) {
  if (!meta) return "";
  return Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

function write(level, message, meta) {
  const metaStr = formatMeta(meta);
  const line = `[${level}] ${nowIso()} ${message}${metaStr ? " | " + metaStr : ""}`;

  if (level === "ERROR") console.error(line);
  else console.log(line);
}

const logger = {
  info: (msg, meta) => write("INFO", msg, meta),
  warn: (msg, meta) => write("WARN", msg, meta),
  error: (msg, meta) => write("ERROR", msg, meta),
};

module.exports = { logger };
