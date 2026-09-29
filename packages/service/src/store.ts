import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Clock = () => number;

export interface FileMeta {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: number;
  expires_at: number;
}

export function genId(): string {
  return randomBytes(12).toString("base64url"); // 16 url-safe chars
}

/** ids are genId() output; anything else never touches the filesystem. */
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
export const isValidId = (id: string): boolean => ID_RE.test(id);

export class Store {
  private db: Database.Database;

  constructor(private dataDir: string, private clock: Clock = Date.now) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "drip.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );`);
  }

  private pathFor(id: string): string {
    return join(this.dataDir, id);
  }

  put(bytes: Uint8Array, filename: string, contentType: string, ttlMs: number): FileMeta {
    const now = this.clock();
    const meta: FileMeta = {
      id: genId(),
      filename,
      content_type: contentType,
      size: bytes.byteLength,
      created_at: now,
      expires_at: now + ttlMs,
    };
    writeFileSync(this.pathFor(meta.id), bytes);
    this.db.prepare(
      `INSERT INTO files (id, filename, content_type, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(meta.id, meta.filename, meta.content_type, meta.size, meta.created_at, meta.expires_at);
    return meta;
  }

  get(id: string): { meta: FileMeta; bytes: Buffer } | null {
    if (!isValidId(id)) return null;
    const meta = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileMeta | undefined;
    if (!meta) return null;
    if (meta.expires_at <= this.clock()) return null;
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    return { meta, bytes: readFileSync(path) };
  }

  list(limit: number): FileMeta[] {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : 20;
    return this.db
      .prepare(`SELECT * FROM files WHERE expires_at > ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(this.clock(), n) as FileMeta[];
  }

  delete(id: string): boolean {
    if (!isValidId(id)) return false;
    const path = this.pathFor(id);
    if (existsSync(path)) unlinkSync(path); // unlink first; if it throws, the row stays for retry
    const info = this.db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  sweep(): number {
    const now = this.clock();
    const expired = this.db.prepare(`SELECT id FROM files WHERE expires_at <= ?`).all(now) as { id: string }[];
    let n = 0;
    for (const { id } of expired) {
      try { this.delete(id); n++; }
      catch (e) { console.error(`sweep failed for ${id}`, e); }
    }
    return n;
  }

  close(): void { this.db.close(); }
}
