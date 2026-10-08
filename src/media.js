const fs = require("fs");
const path = require("path");

const MAX_BYTES = 10 * 1024 * 1024;

async function downloadTelegramFile(token, fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!infoRes.ok) throw new Error(`getFile failed: ${infoRes.status}`);
  const info = await infoRes.json();
  if (!info.ok || !info.result?.file_path) throw new Error("getFile returned no path");
  const filePath = info.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, remotePath: filePath };
}

function toDataUri(buffer, mime) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function saveToWorkspace(dir, name, buffer) {
  const target = path.join(dir, ".telecode-files");
  fs.mkdirSync(target, { recursive: true });
  const stamp = Date.now();
  const safe = `${stamp}-${name.replace(/[^\w.\-]+/g, "_")}`;
  const full = path.join(target, safe);
  fs.writeFileSync(full, buffer);
  return full;
}

module.exports = { downloadTelegramFile, toDataUri, saveToWorkspace, MAX_BYTES };
