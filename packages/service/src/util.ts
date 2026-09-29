import { basename } from "node:path";

/** Strip path components and dangerous characters; never empty. */
export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[/\\]/g, "").replace(/\.{2,}/g, ".").trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}
