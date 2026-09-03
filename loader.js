/**
 * loader.js — shared json/sqlite loader for the static board package.
 *
 * loadBoardData(kind, src) resolves paths relative to THIS file's location,
 * so flow/ and world/ pages work identically wherever the folder is hosted
 * (GitHub Pages, a subpath, local http.server).
 *
 *   kind: 'flow' | 'world'
 *   src:  'json'   → fetch <kind>/data.json
 *         'sqlite' → sql.js opens demo/demo.db and SELECTs payload WHERE
 *                    kind=? — the payload table holds the exact same JSON
 *                    documents, so pages need zero schema logic.
 */
const ROOT = new URL('.', import.meta.url);
const SQLJS = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';

let _SQL = null;

/** sql.js is a UMD classic script (no ES exports): load it as a <script> tag,
 *  which puts `var initSqlJs` on window. */
function loadClassic(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function initSql() {
  if (_SQL) return _SQL;
  await loadClassic(SQLJS + 'sql-wasm.js');
  const initSqlJs = window.initSqlJs;
  if (!initSqlJs) throw new Error('sql.js failed to initialize');
  _SQL = await initSqlJs({ locateFile: (f) => SQLJS + f });
  return _SQL;
}

export async function loadBoardData(kind, src = 'json') {
  if (src !== 'sqlite') {
    const r = await fetch(new URL(`${kind}/data.json`, ROOT));
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  const SQL = await initSql();
  const buf = await (await fetch(new URL('demo/demo.db', ROOT))).arrayBuffer();
  const db = new SQL.Database(new Uint8Array(buf));   // ArrayBuffer alone reads as empty
  try {
    const stmt = db.prepare('SELECT json FROM payload WHERE kind = ?');
    stmt.bind([kind]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    if (!row) throw new Error(`payload '${kind}' not in demo.db — regenerate with scripts/export_static_board.py`);
    return JSON.parse(row.json);
  } finally {
    db.close();
  }
}
