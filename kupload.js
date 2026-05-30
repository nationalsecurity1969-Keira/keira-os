#!/usr/bin/env node
// kupload.js — заливает локальные фотки в Cloudinary, сохраняя структуру папок.
// Пропускает то, что уже есть в Cloudinary (по library.json).
//
// Запуск:
//   node kupload.js               → дефолтная локальная папка ~/Pictures/Keira
//   node kupload.js /custom/path  → своя локальная папка
//
// Требует: npm install (один раз) + .env с CLOUDINARY_*

const fs = require('fs');
const path = require('path');
const os = require('os');

// ───────── load .env ─────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n✗ Не найден .env. Скопируй .env.example в .env и заполни.\n');
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
const CLOUD  = env.CLOUDINARY_CLOUD;
const KEY    = env.CLOUDINARY_KEY;
const SECRET = env.CLOUDINARY_SECRET;
const ROOT_CLOUD = env.CLOUDINARY_ROOT_FOLDER || 'Keira';

if (!CLOUD || !KEY || !SECRET) {
  console.error('\n✗ В .env нужны CLOUDINARY_CLOUD / CLOUDINARY_KEY / CLOUDINARY_SECRET.\n');
  process.exit(1);
}

// ───────── load cloudinary SDK ─────────
let cloudinary;
try {
  cloudinary = require('cloudinary').v2;
} catch (e) {
  console.error('\n✗ Не установлен модуль cloudinary.');
  console.error('  Запусти один раз: cd ~/Documents/keira-os && npm install\n');
  process.exit(1);
}

cloudinary.config({ cloud_name: CLOUD, api_key: KEY, api_secret: SECRET });

// ───────── local source folder ─────────
const LOCAL_ROOT = process.argv[2] || env.LOCAL_PICTURES_ROOT || path.join(os.homedir(), 'Pictures', 'Keira');

if (!fs.existsSync(LOCAL_ROOT)) {
  console.error(`\n✗ Локальная папка не найдена: ${LOCAL_ROOT}`);
  console.error(`  Создай её (mkdir -p), или передай свой путь:`);
  console.error(`  node kupload.js /твой/путь/к/Keira\n`);
  process.exit(1);
}

// ───────── load library.json (чтобы знать что уже есть) ─────────
let LIBRARY = { photos: [] };
const libPath = path.join(__dirname, 'library.json');
if (fs.existsSync(libPath)) {
  LIBRARY = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
}

// быстрый lookup: "folder/filename" → true
const existing = new Set();
LIBRARY.photos.forEach(p => {
  const filename = p.public_id.includes('/')
    ? p.public_id.split('/').pop()
    : p.public_id;
  const folder = p.folder || '';
  existing.add(`${folder}/${filename}`);
});

// ───────── walk локальной папки ─────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function walk(dir, base = dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    if (entry.name.startsWith('.')) return; // .DS_Store и т.п.
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath, base));
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push({
        fullPath,
        rel: path.relative(base, fullPath)
      });
    }
  });
  return out;
}

// ───────── main ─────────
(async () => {
  console.log(`\n→ Локальная папка: ${LOCAL_ROOT}`);
  console.log(`→ Корень в Cloudinary: ${ROOT_CLOUD}/`);
  console.log(`→ Сканирую локально...`);

  const files = walk(LOCAL_ROOT);
  console.log(`  найдено: ${files.length} изображений`);

  if (files.length === 0) {
    console.log(`\n  Положи фотки в ${LOCAL_ROOT} (с подпапками yen/home/outside/...) и запусти снова.\n`);
    process.exit(0);
  }

  let uploaded = 0, skipped = 0, errors = 0;

  for (const f of files) {
    // subPath: путь от корня без имени файла. Например "yen/CorvoBianco/WhiteDress" или "."
    const subPath = path.dirname(f.rel);
    const targetFolder = subPath === '.' ? ROOT_CLOUD : `${ROOT_CLOUD}/${subPath}`;
    const filename = path.basename(f.rel, path.extname(f.rel));
    const lookupKey = `${targetFolder}/${filename}`;

    if (existing.has(lookupKey)) {
      skipped++;
      continue;
    }

    process.stdout.write(`  ↑ ${f.rel} → ${targetFolder}/${filename} ... `);
    try {
      await cloudinary.uploader.upload(f.fullPath, {
        folder: targetFolder,
        public_id: filename,
        use_filename: false,
        unique_filename: false,
        overwrite: false,
        resource_type: 'image'
      });
      console.log(`OK`);
      uploaded++;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.log(`✗ ${msg}`);
      errors++;
    }
  }

  console.log(`\n  залито: ${uploaded}`);
  console.log(`  пропущено (уже есть): ${skipped}`);
  if (errors) console.log(`  ошибки: ${errors}`);

  console.log(`\n→ Готово. Дальше: ksync обновит library.json, kpush запушит на GitHub.\n`);
})();
