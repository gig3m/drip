import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";

let dir: string;
let now: number;
const clock = () => now;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "drip-")); now = 1_000_000; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Store", () => {
  it("put returns metadata with computed expiry and stores bytes", () => {
    const s = new Store(dir, clock);
    const m = s.put(new Uint8Array([1, 2, 3]), "x.png", "image/png", 1000);
    expect(m.size).toBe(3);
    expect(m.expires_at).toBe(1_001_000);
    expect(existsSync(join(dir, m.id))).toBe(true);
    s.close();
  });

  it("get returns bytes before expiry, null after", () => {
    const s = new Store(dir, clock);
    const m = s.put(new Uint8Array([9]), "a", "text/plain", 1000);
    expect(s.get(m.id)?.bytes.equals(Buffer.from([9]))).toBe(true);
    now = m.expires_at; // expiry is inclusive
    expect(s.get(m.id)).toBeNull();
    s.close();
  });

  it("get returns null for unknown id", () => {
    const s = new Store(dir, clock);
    expect(s.get("missing")).toBeNull();
    s.close();
  });

  it("delete removes row and byte file", () => {
    const s = new Store(dir, clock);
    const m = s.put(new Uint8Array([1]), "a", "text/plain", 1000);
    expect(s.delete(m.id)).toBe(true);
    expect(existsSync(join(dir, m.id))).toBe(false);
    expect(s.delete(m.id)).toBe(false);
    s.close();
  });

  it("setExpiry moves expires_at to now + ttl and returns the new meta", () => {
    const s = new Store(dir, clock);
    const m = s.put(new Uint8Array([1]), "a", "text/plain", 1000);
    now += 500;
    const r = s.setExpiry(m.id, 5000);
    expect(r).toMatchObject({ id: m.id, created_at: m.created_at, expires_at: now + 5000 });
    expect(s.get(m.id)!.meta.expires_at).toBe(now + 5000);
    s.close();
  });

  it("setExpiry returns null for unknown, invalid or already-expired ids", () => {
    const s = new Store(dir, clock);
    const m = s.put(new Uint8Array([1]), "a", "text/plain", 1000);
    expect(s.setExpiry("missing", 1000)).toBeNull();
    expect(s.setExpiry("../../etc/passwd", 1000)).toBeNull();
    now += 1000;
    expect(s.setExpiry(m.id, 1000)).toBeNull();
    s.close();
  });

  it("sweep deletes only expired entries and returns the count", () => {
    const s = new Store(dir, clock);
    const a = s.put(new Uint8Array([1]), "a", "text/plain", 1000);   // expires 1_001_000
    const b = s.put(new Uint8Array([2]), "b", "text/plain", 5000);   // expires 1_005_000
    now = 1_002_000;
    expect(s.sweep()).toBe(1);
    expect(existsSync(join(dir, a.id))).toBe(false);
    expect(existsSync(join(dir, b.id))).toBe(true);
    s.close();
  });

  it("persists across reopen (WAL/SQLite durability)", () => {
    const s1 = new Store(dir, clock);
    const m = s1.put(new Uint8Array([7]), "a", "text/plain", 10_000);
    s1.close();
    const s2 = new Store(dir, clock);
    expect(s2.get(m.id)?.bytes.equals(Buffer.from([7]))).toBe(true);
    s2.close();
  });

  it("list returns non-expired rows newest-first, clamps limit, excludes expired", () => {
    const s = new Store(dir, clock);
    const a = s.put(new Uint8Array([1]), "a.txt", "text/plain", 5000); now += 10;
    const b = s.put(new Uint8Array([2]), "b.txt", "text/plain", 5000); now += 10;
    const c = s.put(new Uint8Array([3]), "c.txt", "text/plain", 100); // created 1_000_020, expires 1_000_120

    expect(s.list(20).map((m) => m.id)).toEqual([c.id, b.id, a.id]); // newest first
    expect(s.list(2).map((m) => m.id)).toEqual([c.id, b.id]);        // limit
    expect(s.list(0)).toHaveLength(3);                               // 0 -> default 20
    expect(s.list(9999)).toHaveLength(3);                            // clamp high

    now = 1_000_400; // c expired (1_000_120), a & b still valid
    expect(s.list(20).map((m) => m.id)).toEqual([b.id, a.id]);
    s.close();
  });
});
