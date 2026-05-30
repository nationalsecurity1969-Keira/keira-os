#!/usr/bin/env node
// sync.js — тянет всю библиотеку из Cloudinary и пишет library.json
// Поддерживает оба режима папок Cloudinary: fixed и dynamic.
// Запуск: node sync.js

const fs = require('fs');
const path = require('path');

// ───────── загрузка .env ─────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n✗ Не найден .env рядом со скриптом.');
    console.error('  Скопируй .env.example в .env и заполни:');
    console.error('  cp .env.example .env\n');
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
const CLOUD = env.CLOUDINARY_CLOUD;
const KEY = env.CLOUDINARY_KEY;
const SECRET = env.CLOUDINARY_SECRET;
const ROOT = env.CLOUDINARY_ROOT_FOLDER || 'Keira';

if (!CLOUD || !KEY || !SECRET) {
  console.error('\n✗ Не хватает переменных в .env.');
  console.error('  Нужны: CLOUDINARY_CLOUD, CLOUDINARY_KEY, CLOUDINARY_SECRET\n');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(KEY + ':' + SECRET).toString('base64');

// ───────── список через Search API (возвращает etag) ─────────
async function listAll() {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    page++;
    const body = {
      expression: 'resource_type:image',
      max_results: 500,
      with_field: ['tags', 'context']
    };
    if (cursor) body.next_cursor = cursor;

    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/resources/search`, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error(`\n✗ Cloudinary Search API вернул ${r.status}:`);
      console.error(txt);
      if (r.status === 401) console.error('\n  → Проверь API_KEY / API_SECRET в .env');
      if (r.status === 404) console.error('\n  → Проверь CLOUDINARY_CLOUD в .env');
      process.exit(1);
    }
    const data = await r.json();
    const got = data.resources || [];
    all.push(...got);
    cursor = data.next_cursor;
    console.log(`  страница ${page}: +${got.length} фото${cursor ? '' : ' (последняя)'}`);
  } while (cursor);
  return all;
}

// ───────── получить путь к папке из ресурса (оба режима) ─────────
function getFolder(r) {
  // dynamic folders: asset_folder заполнен, public_id — короткий id без пути
  if (r.asset_folder) return r.asset_folder;
  // fixed folders: путь лежит в public_id перед последним "/"
  const idx = r.public_id.lastIndexOf('/');
  return idx > 0 ? r.public_id.substring(0, idx) : '';
}

// ───────── теги из пути (после корневой папки) ─────────
function deriveTags(folder) {
  if (!folder) return [];
  let path = folder;
  if (path === ROOT) return [];
  if (path.startsWith(ROOT + '/')) path = path.substring(ROOT.length + 1);
  // если папка не начинается с ROOT — берём весь путь как теги
  return path ? path.split('/').filter(Boolean) : [];
}

// ───────── фильтр: только из корневой папки и её подпапок ─────────
function inRoot(folder) {
  if (!folder) return false;
  return folder === ROOT || folder.startsWith(ROOT + '/');
}

// ───────── main ─────────
(async () => {
  console.log(`\n→ Cloudinary: ${CLOUD}`);
  console.log(`→ Корневая папка-фильтр: ${ROOT}/`);
  console.log(`→ Тяну ВСЮ библиотеку (отфильтрую локально)...\n`);

  let resources;
  try {
    resources = await listAll();
  } catch (e) {
    console.error('\n✗ Не удалось получить данные:', e.message);
    process.exit(1);
  }

  console.log(`\n  → Всего в аккаунте: ${resources.length} фото`);

  // диагностика — показать как Cloudinary хранит папки
  if (resources.length > 0) {
    const sample = resources[0];
    console.log(`\n  Пример ресурса (для диагностики):`);
    console.log(`    public_id: ${sample.public_id}`);
    console.log(`    asset_folder: ${sample.asset_folder ?? '(пусто — fixed-folders режим)'}`);
  }

  // фильтруем по корневой папке
  const inRootRes = resources.filter(r => inRoot(getFolder(r)));
  console.log(`  → В папке ${ROOT}/ и подпапках: ${inRootRes.length} фото`);

  if (inRootRes.length === 0 && resources.length > 0) {
    console.warn(`\n⚠ Папка "${ROOT}" не найдена среди ${resources.length} фоток в аккаунте.`);
    console.warn(`  Проверь как реально называется твоя корневая папка.`);
    console.warn(`  Топ-10 встречающихся папок в твоём аккаунте:`);
    const folders = {};
    resources.forEach(r => {
      const f = getFolder(r) || '(без папки / корень)';
      folders[f] = (folders[f] || 0) + 1;
    });
    Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([f, n]) => {
      console.warn(`    ${String(n).padStart(4)}  ${f}`);
    });
    console.warn(`\n  Поменяй CLOUDINARY_ROOT_FOLDER в .env на правильное имя и запусти снова.\n`);
  }

  // строим библиотеку
  const photos = inRootRes.map(r => {
    const folder = getFolder(r);
    const tags = deriveTags(folder);
    return {
      public_id: r.public_id,
      folder,
      tags,
      url: r.secure_url,
      thumb: `https://res.cloudinary.com/${CLOUD}/image/upload/w_400,h_533,c_fill,q_auto,f_auto/v${r.version}/${r.public_id}.${r.format}`,
      format: r.format,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      etag: r.etag, // MD5 файла — нужен для kclean чтобы безопасно сопоставлять дубли
      created_at: r.created_at
    };
  });

  photos.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const out = {
    cloud: CLOUD,
    root: ROOT,
    synced_at: new Date().toISOString(),
    count: photos.length,
    photos
  };
  const outPath = path.join(__dirname, 'library.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\n✓ Записано: library.json (${photos.length} фото)`);

  if (photos.length > 0) {
    const byFolder = {};
    photos.forEach(p => {
      const key = p.folder || '(корень)';
      byFolder[key] = (byFolder[key] || 0) + 1;
    });
    console.log('\nПо папкам:');
    Object.entries(byFolder).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => {
      console.log(`  ${String(n).padStart(4)}  ${f}`);
    });

    const byTag = {};
    photos.forEach(p => p.tags.forEach(t => { byTag[t] = (byTag[t] || 0) + 1; }));
    if (Object.keys(byTag).length) {
      console.log('\nПо тегам (из имён папок):');
      Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([t, n]) => {
        console.log(`  ${String(n).padStart(4)}  ${t}`);
      });
    }
  }

  console.log('\n→ Готово.\n');
})();
