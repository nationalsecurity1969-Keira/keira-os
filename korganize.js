#!/usr/bin/env node
// korganize.js — раскидывает плоские локальные файлы по подпапкам так,
// как они организованы в Cloudinary (по library.json).
//
// Безопасно: только перемещает (mv), ничего не удаляет.
// Если в локальной папке нет файла, который есть в Cloudinary — скачивает.
//
// Запуск:
//   node korganize.js            → использует LOCAL_PICTURES_ROOT из .env
//   node korganize.js /custom    → своя локальная папка

const fs = require('fs');
const path = require('path');
const os = require('os');

// ───────── .env ─────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) { console.error('\n✗ Не найден .env.\n'); process.exit(1); }
  const env = {};
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return env;
}

const env = loadEnv();
const ROOT_CLOUD = env.CLOUDINARY_ROOT_FOLDER || 'Keira';
const LOCAL_ROOT = process.argv[2] || env.LOCAL_PICTURES_ROOT || path.join(os.homedir(), 'Pictures', 'Keira');

// ───────── library.json ─────────
const libPath = path.join(__dirname, 'library.json');
if (!fs.existsSync(libPath)) {
  console.error('\n✗ library.json не найден. Сначала запусти ksync.\n');
  process.exit(1);
}
const LIBRARY = JSON.parse(fs.readFileSync(libPath, 'utf-8'));

if (!fs.existsSync(LOCAL_ROOT)) {
  console.error(`\n✗ Локальная папка не найдена: ${LOCAL_ROOT}\n`);
  process.exit(1);
}

// ───────── helpers ─────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function relFromCloudFolder(cloudFolder) {
  if (!cloudFolder) return '';
  if (cloudFolder === ROOT_CLOUD) return '';
  if (cloudFolder.startsWith(ROOT_CLOUD + '/')) {
    return cloudFolder.substring(ROOT_CLOUD.length + 1);
  }
  return cloudFolder;
}

function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    if (entry.name.startsWith('.')) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push({
        full,
        rel: path.relative(base, full),
        basename: path.basename(entry.name, path.extname(entry.name))
      });
    }
  });
  return out;
}

// ───────── main ─────────
(async () => {
  console.log(`\n→ Локальная папка: ${LOCAL_ROOT}`);
  console.log(`→ Cloudinary в library.json: ${LIBRARY.photos.length} фото\n`);

  // 1. индекс локальных файлов по basename
  const localFiles = walk(LOCAL_ROOT);
  console.log(`  локально найдено: ${localFiles.length} файлов`);

  const byBasename = {};
  localFiles.forEach(f => {
    if (!byBasename[f.basename]) byBasename[f.basename] = [];
    byBasename[f.basename].push(f);
  });

  // 2. идём по library.json: для каждого Cloudinary-фото находим локальное место
  let moved = 0, ok = 0, downloaded = 0, missing = 0, errors = 0;

  for (const p of LIBRARY.photos) {
    const cloudBasename = p.public_id.includes('/')
      ? p.public_id.split('/').pop()
      : p.public_id;
    const targetRel = relFromCloudFolder(p.folder);
    const targetDir = targetRel ? path.join(LOCAL_ROOT, targetRel) : LOCAL_ROOT;
    const targetPath = path.join(targetDir, `${cloudBasename}.${p.format || 'jpg'}`);

    // уже на месте?
    if (fs.existsSync(targetPath)) {
      ok++;
      continue;
    }

    // есть локально где-то ещё?
    const matches = byBasename[cloudBasename];
    if (matches && matches.length > 0) {
      // берём первое совпадение, перемещаем
      const src = matches[0];
      fs.mkdirSync(targetDir, { recursive: true });
      try {
        fs.renameSync(src.full, targetPath);
        const fromRel = src.rel;
        const toRel = path.relative(LOCAL_ROOT, targetPath);
        console.log(`  → moved: ${fromRel}  →  ${toRel}`);
        moved++;
      } catch (e) {
        console.log(`  ✗ ошибка move ${src.rel}: ${e.message}`);
        errors++;
      }
      continue;
    }

    // нет локально вообще — скачаем из Cloudinary
    fs.mkdirSync(targetDir, { recursive: true });
    process.stdout.write(`  ↓ download: ${targetRel ? targetRel + '/' : ''}${cloudBasename}.${p.format} ... `);
    try {
      const r = await fetch(p.url);
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(targetPath, buf);
      const kb = buf.length / 1024;
      console.log(kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`);
      downloaded++;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      missing++;
    }
  }

  // 3. summary
  console.log(`\n  уже на правильных местах: ${ok}`);
  console.log(`  перемещено локально:      ${moved}`);
  console.log(`  скачано из Cloudinary:    ${downloaded}`);
  if (missing) console.log(`  не получилось скачать:    ${missing}`);
  if (errors)  console.log(`  ошибки перемещения:       ${errors}`);

  // 4. что осталось локально, но НЕ в Cloudinary
  // (это может быть mp4, посторонние файлы, новые ещё незагруженные)
  const afterFiles = walk(LOCAL_ROOT);
  const cloudBasenames = new Set(LIBRARY.photos.map(p =>
    p.public_id.includes('/') ? p.public_id.split('/').pop() : p.public_id
  ));
  const unknownLocal = afterFiles.filter(f => !cloudBasenames.has(f.basename));
  if (unknownLocal.length > 0) {
    console.log(`\n  файлы локально, которых нет в Cloudinary (${unknownLocal.length}):`);
    unknownLocal.slice(0, 10).forEach(f => console.log(`    ${f.rel}`));
    if (unknownLocal.length > 10) console.log(`    ... и ещё ${unknownLocal.length - 10}`);
    console.log(`  это либо новые (для kupload), либо мусор — посмотри глазами.`);
  }

  console.log(`\n→ Готово. Локальная структура теперь зеркалит Cloudinary.\n`);
})();
