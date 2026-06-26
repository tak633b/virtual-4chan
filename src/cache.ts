// The cache IS the world. It is not a perf optimization layered on top of the
// internet — it is the internet's persistence. Once a URL is generated, that page
// exists forever (until WORLD_EPOCH changes), byte-for-byte, across restarts.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config';

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS pages (
    key        TEXT PRIMARY KEY,
    real_url   TEXT NOT NULL,
    title      TEXT,
    html       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS serps (
    key        TEXT PRIMARY KEY,
    query      TEXT NOT NULL,
    html       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export interface PageRecord { key: string; real_url: string; title: string | null; html: string; created_at: number; }
export interface SerpRecord { key: string; query: string; html: string; created_at: number; }

const selPage = db.prepare('SELECT * FROM pages WHERE key = ?');
const insPage = db.prepare('INSERT OR REPLACE INTO pages (key, real_url, title, html, created_at) VALUES (?, ?, ?, ?, ?)');
const selSerp = db.prepare('SELECT * FROM serps WHERE key = ?');
const insSerp = db.prepare('INSERT OR REPLACE INTO serps (key, query, html, created_at) VALUES (?, ?, ?, ?)');
const countPages = db.prepare('SELECT COUNT(*) AS n FROM pages');
const countSerps = db.prepare('SELECT COUNT(*) AS n FROM serps');

export function getPage(key: string): PageRecord | undefined { return selPage.get(key) as PageRecord | undefined; }
export function putPage(key: string, realUrl: string, title: string, html: string): void {
  insPage.run(key, realUrl, title, html, Date.now());
}
export function getSerp(key: string): SerpRecord | undefined { return selSerp.get(key) as SerpRecord | undefined; }
export function putSerp(key: string, query: string, html: string): void {
  insSerp.run(key, query, html, Date.now());
}
export function worldStats(): { pages: number; serps: number } {
  return { pages: (countPages.get() as any).n, serps: (countSerps.get() as any).n };
}

// ---- generic settings key/value (backs src/settings.ts) -------------------
const selSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const insSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
export function getSetting(key: string): string | undefined { return (selSetting.get(key) as any)?.value; }
export function setSetting(key: string, value: string): void { insSetting.run(key, value); }
