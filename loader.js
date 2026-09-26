/**
 * loader.js — shared json/sqlite loader for the static board package.
 *
 * loadBoardData(kind, src) resolves paths relative to THIS file's location,
 * so flow/ and world/ pages work identically wherever the folder is hosted
 * (GitHub Pages, a subpath, local http.server).
 *
 *   kind: 'flow' | 'world' | 'luma'
 *   src:  'auto'   → primary (config.json) first, bundled copy on any failure
 *         'r2'     → primary only, falling back to the bundled copy
 *         'github' → bundled copy only (also the `?data=github` override)
 *         'sqlite' → sql.js opens demo/demo.db and SELECTs payload WHERE
 *                    kind=? — the payload table holds the exact same JSON
 *                    documents, so pages need zero schema logic
 *         'json'   → legacy alias for 'auto'
 *
 * The primary lives in config.json next to this file:
 *   { "data": { "primary": "https://board-data.<sub>.workers.dev", "fallback": "data.json" } }
 * Only that public URL may ever go in it — no keys, no signed URLs. An empty,
 * missing or invalid primary means GitHub-only mode, which is exactly what the
 * rollback drill does: set primary to "" and push.
 */
const ROOT = new URL('.', import.meta.url);
const SQLJS = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
const JSON_TIMEOUT_MS = 4000;    // data.json is a few hundred KB
const DB_TIMEOUT_MS = 15000;     // demo.db is ~30MB

let _SQL = null;
let _configPromise = null;

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

/** A bad config.json must not be able to steer the page anywhere: https only,
 *  and only to a workers.dev host. */
function validPrimary(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname.endsWith('.workers.dev');
  } catch (e) {
    return false;
  }
}

/** config.json, fetched once per page load. Cache-busted so a rollback flip
 *  is picked up as soon as Pages serves the new file. */
function loadConfig() {
  if (!_configPromise) {
    _configPromise = (async () => {
      try {
        const r = await fetch(new URL('config.json', ROOT), { cache: 'no-store' });
        const cfg = r.ok ? await r.json() : null;
        const raw = cfg && cfg.data && typeof cfg.data.primary === 'string'
          ? cfg.data.primary.trim().replace(/\/+$/, '') : '';
        return { primary: validPrimary(raw) ? raw : '' };
      } catch (e) {
        return { primary: '' };            // no config / bad json / offline
      }
    })();
  }
  return _configPromise;
}

function srcMode(src) {
  if (src === 'sqlite' || src === 'r2' || src === 'github') return src;
  return 'auto';                            // 'auto', legacy 'json', anything else
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, timeoutMs) {
  const r = await fetchWithTimeout(url, timeoutMs);
  return r.json();                          // strict parse: invalid JSON throws
}

async function fetchBuffer(url, timeoutMs) {
  const r = await fetchWithTimeout(url, timeoutMs);
  return r.arrayBuffer();
}

export async function loadBoardData(kind, src = 'auto') {
  const mode = srcMode(src);

  if (mode === 'sqlite') {
    const SQL = await initSql();
    const cfg = await loadConfig();
    let buf = null;
    if (cfg.primary) {
      try {
        buf = await fetchBuffer(`${cfg.primary}/demo/demo.db`, DB_TIMEOUT_MS);
      } catch (e) {
        console.warn('[loader] primary demo.db failed, using the bundled copy', e);
      }
    }
    if (!buf) buf = await fetchBuffer(new URL('demo/demo.db', ROOT), DB_TIMEOUT_MS);
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

  if (mode === 'r2' || mode === 'auto') {
    const cfg = await loadConfig();
    if (cfg.primary) {
      try {
        return await fetchJson(`${cfg.primary}/${kind}/data.json`, JSON_TIMEOUT_MS);
      } catch (e) {
        if (mode === 'r2') {
          console.warn('[loader] primary failed under ?data=r2, using the bundled copy', e);
        } else {
          console.warn('[loader] primary failed, using the bundled copy', e);
        }
      }
    } else if (mode === 'r2') {
      throw new Error('?data=r2 but config.json has no primary — serving GitHub data');
    }
  }

  return fetchJson(new URL(`${kind}/data.json`, ROOT), JSON_TIMEOUT_MS);
}
