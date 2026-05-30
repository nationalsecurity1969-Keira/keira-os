#!/usr/bin/env node
// kclean.js — чистит локальные дубли по MD5.
//
// Логика:
//   1. Для каждой Cloudinary-фотки знаем её ожидаемый локальный путь (по folder).
//   2. Для каждого локального файла считаем MD5.
//   3. Если MD5 совпал с какой-то Cloudinary-фоткой:
//      - файл лежит на ожидаемом месте → keep (это организованный download)
//      - файл лежит в другом месте → DELETE (это старый дубль)
//   4. Если MD5 не совпал ни с чем → keep (новый файл, не в Cloudinary)
//
// БЕЗ --yes делает только dry-run (показывает что будет удалено, не трогает).
// С --yes удаляет.
//
// Запуск:
//   node kclean.js          ← dry run, посмотреть
//   node kclean.js --yes    ← реально удалить

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ───────── env ─────────
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
const LOCAL_ROOT = env.LOCAL_PICTURES_ROOT || path.join(os.homedir(), 'Pictures', 'Keira');
const DRY_RUN = !process.argv.includes('--yes');

// ───────── library.json ─────────
const libPath = path.join(__dirname, 'library.json');
if (!fs.existsSync(libPath)) {
  console.error('\n✗ library.json не найден. Сначала ksync.\n');
  process.exit(1);
}
const LIBRARY = JSON.parse(fs.readFileSync(libPath, 'utf-8'));

const withoutEtag = LIBRARY.photos.filter(p => !p.etag).length;
if (withoutEtag === LIBRARY.photos.length) {
  console.error('\n✗ В library.json нет etag-ов. Запусти ksync ещё раз (sync.js обновлён).\n');
  process.exit(1);
}
if (withoutEtag > 0) {
  console.warn(`⚠ ${withoutEtag} фоток без etag — их пропустим (запусти ksync для свежих данных).\n`);
}

if (!fs.existsSync(LOCAL_ROOT)) {
  console.error(`\n✗ Локальная папка не найдена: ${LOCAL_ROOT}\n`);
  process.exit(1);
}

// ───────── helpers ─────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function relFromCloudFolder(cloudFolder) {
  if (!cloudFolder) return '';
  if (cloudFolder === ROOT_CLOUD) return '';
  if (cloudFolder.startsWith(ROOT_CLOUD + '/')) return cloudFolder.substring(ROOT_CLOUD.length + 1);
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
      out.push({ full, rel: path.relative(base, full) });
    }
  });
  return out;
}

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// ───────── main ─────────
(async () => {
  console.log(`\n→ ${DRY_RUN ? 'DRY RUN' : 'РЕАЛЬНОЕ УДАЛЕНИЕ'} (флаг --yes ${DRY_RUN ? 'не задан' : 'задан'})`);
  console.log(`→ Локальная папка: ${LOCAL_ROOT}`);
  console.log(`→ В Cloudinary: ${LIBRARY.photos.length} фото (с etag: ${LIBRARY.photos.length - withoutEtag})\n`);

  // Map: etag → ожидаемый локальный путь
  const expectedByEtag = {};
  LIBRARY.photos.forEach(p => {
    if (!p.etag) return;
    const rel = relFromCloudFolder(p.folder);
    const dir = rel ? path.join(LOCAL_ROOT, rel) : LOCAL_ROOT;
    const basename = p.public_id.includes('/') ? p.public_id.split('/').pop() : p.public_id;
    const expectedPath = path.join(dir, `${basename}.${p.format || 'jpg'}`);
    if (!expectedByEtag[p.etag]) expectedByEtag[p.etag] = [];
    expectedByEtag[p.etag].push(expectedPath);
  });

  // Walk local files
  const localFiles = walk(LOCAL_ROOT);
  console.log(`  локально найдено: ${localFiles.length} файлов\n`);

  let kept = 0, toDelete = [], unique = 0, errors = 0;

  for (const f of localFiles) {
    try {
      const buf = fs.readFileSync(f.full);
      const hash = md5(buf);
      const expectedPaths = expectedByEtag[hash];

      if (!expectedPaths || expectedPaths.length === 0) {
        // нет такого хеша в Cloudinary → уникальный файл, не трогаем
        unique++;
        continue;
      }

      // нормализуем пути для сравнения (чтобы UTF-8 не подвёл)
      const normSelf = path.normalize(f.full);
      const isAtExpected = expectedPaths.some(ep => path.normalize(ep) === normSelf);

      if (isAtExpected) {
        kept++;
      } else {
        toDelete.push({ local: f, expectedAt: expectedPaths[0] });
      }
    } catch (e) {
      console.log(`  ✗ ошибка чтения ${f.rel}: ${e.message}`);
      errors++;
    }
  }

  // отчёт
  console.log(`  уже на правильных местах:           ${kept}`);
  console.log(`  уникальные (не в Cloudinary):        ${unique}`);
  console.log(`  ${DRY_RUN ? 'будет удалено (дубли):' : 'удаляем (дубли):           '}      ${toDelete.length}\n`);

  if (toDelete.length === 0) {
    console.log(`→ Чисто. Дублей не найдено.\n`);
    return;
  }

  // показать первые 20 кандидатов
  const showMax = Math.min(toDelete.length, 20);
  console.log(`  ${DRY_RUN ? 'кандидаты на удаление' : 'удаляю'} (первые ${showMax} из ${toDelete.length}):`);
  for (let i = 0; i < showMax; i++) {
    const t = toDelete[i];
    console.log(`    ✗ ${path.relative(LOCAL_ROOT, t.local.full)}`);
    console.log(`         (есть копия в правильном месте: ${path.relative(LOCAL_ROOT, t.expectedAt)})`);
  }
  if (toDelete.length > showMax) console.log(`    ... и ещё ${toDelete.length - showMax}`);

  if (DRY_RUN) {
    console.log(`\n→ DRY RUN. Ничего не удалено.`);
    console.log(`  Если согласна — запусти снова с флагом:  kclean --yes\n`);
    return;
  }

  // реально удаляем
  let deleted = 0, delErrors = 0;
  for (const t of toDelete) {
    try {
      fs.unlinkSync(t.local.full);
      deleted++;
    } catch (e) {
      console.log(`  ✗ не удалось удалить ${t.local.rel}: ${e.message}`);
      delErrors++;
    }
  }

  // удалим пустые директории
  function cleanEmptyDirs(dir) {
    if (!fs.existsSync(dir) || dir === LOCAL_ROOT) return;
    const entries = fs.readdirSync(dir).filter(n => !n.startsWith('.'));
    if (entries.length === 0) {
      try { fs.rmdirSync(dir); } catch {}
      cleanEmptyDirs(path.dirname(dir));
    }
  }
  // soft cleanup пустых поддиректорий
  const dirs = new Set(toDelete.map(t => path.dirname(t.local.full)));
  dirs.forEach(cleanEmptyDirs);

  console.log(`\n  удалено: ${deleted}`);
  if (delErrors) console.log(`  ошибки удаления: ${delErrors}`);
  console.log(`\n→ Готово. Локальная папка вычищена от дублей.\n`);
})();
