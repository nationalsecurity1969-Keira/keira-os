#!/usr/bin/env node
// kdownload.js — скачивает фотки из Cloudinary в локальную папку,
// сохраняя структуру подпапок. Skip того что уже есть локально.
//
// Запуск:
//   node kdownload.js               → в ~/Pictures/Keira
//   node kdownload.js /custom/path  → в свою папку
//
// Требует: library.json (запусти ksync если устарела) + .env

const fs = require('fs');
const path = require('path');
const os = require('os');

// ───────── load .env (нужен только ROOT_FOLDER) ─────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n✗ Не найден .env.\n');
    process.exit(1);
  }
  const env = {};
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return env;
}

const env = loadEnv();
const ROOT_CLOUD = env.CLOUDINARY_ROOT_FOLDER || 'Keira';

// ───────── загрузка library.json ─────────
const libPath = path.join(__dirname, 'library.json');
if (!fs.existsSync(libPath)) {
  console.error('\n✗ library.json не найден. Сначала запусти ksync, чтобы он его создал.\n');
  process.exit(1);
}
const LIBRARY = JSON.parse(fs.readFileSync(libPath, 'utf-8'));

// ───────── локальный целевой корень ─────────
const LOCAL_ROOT = process.argv[2] || env.LOCAL_PICTURES_ROOT || path.join(os.homedir(), 'Pictures', 'Keira');
fs.mkdirSync(LOCAL_ROOT, { recursive: true });

// ───────── helper: cloud folder → local subpath ─────────
function relFromCloudFolder(cloudFolder) {
  if (!cloudFolder) return '';
  if (cloudFolder === ROOT_CLOUD) return '';
  if (cloudFolder.startsWith(ROOT_CLOUD + '/')) {
    return cloudFolder.substring(ROOT_CLOUD.length + 1);
  }
  return cloudFolder;
}

// ───────── main ─────────
(async () => {
  console.log(`\n→ Источник: Cloudinary (через library.json, ${LIBRARY.photos.length} фото)`);
  console.log(`→ Цель: ${LOCAL_ROOT}\n`);

  let downloaded = 0, skipped = 0, errors = 0, totalBytes = 0;

  for (let i = 0; i < LIBRARY.photos.length; i++) {
    const p = LIBRARY.photos[i];
    const rel = relFromCloudFolder(p.folder);
    const localDir = rel ? path.join(LOCAL_ROOT, rel) : LOCAL_ROOT;
    const baseName = p.public_id.includes('/') ? p.public_id.split('/').pop() : p.public_id;
    const filename = `${baseName}.${p.format || 'jpg'}`;
    const localPath = path.join(localDir, filename);

    const display = rel ? `${rel}/${filename}` : filename;

    if (fs.existsSync(localPath)) {
      skipped++;
      continue;
    }

    fs.mkdirSync(localDir, { recursive: true });
    process.stdout.write(`  [${i + 1}/${LIBRARY.photos.length}] ↓ ${display} ... `);

    try {
      const r = await fetch(p.url);
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(localPath, buf);
      totalBytes += buf.length;
      const kb = buf.length / 1024;
      console.log(kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`);
      downloaded++;
    } catch (e) {
      console.log(`✗ ${(e && e.message) || e}`);
      errors++;
    }
  }

  const totalMB = totalBytes / 1024 / 1024;
  console.log(`\n  скачано: ${downloaded} файлов · ${totalMB.toFixed(2)} MB`);
  console.log(`  пропущено (уже было локально): ${skipped}`);
  if (errors) console.log(`  ошибки: ${errors}`);
  console.log(`\n→ Готово. Локальная папка теперь зеркалит Cloudinary.\n`);
})();
