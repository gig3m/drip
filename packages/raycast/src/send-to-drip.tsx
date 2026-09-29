import { getPreferenceValues, getSelectedFinderItems, Clipboard, showToast, Toast, showHUD } from "@raycast/api";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { lookup } from "mime-types";
import { DripClient, type UploadResult, type UploadFile } from "./drip-client.js";

interface Prefs {
  baseUrl: string;
  token?: string;
  ttl?: string;
}

// Raycast's GUI-launched Node process often does not inherit the shell PATH,
// so bare `execFileSync("pngpaste", ...)` can fail to find the binary even
// when it's installed. Prefer known absolute Homebrew locations first, then
// fall back to a bare lookup in case PATH is inherited after all.
function resolvePngpaste(): string {
  const candidates = ["/opt/homebrew/bin/pngpaste", "/usr/local/bin/pngpaste"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "pngpaste";
}

function fileToUpload(path: string): UploadFile {
  return {
    bytes: new Uint8Array(readFileSync(path)),
    filename: basename(path),
    contentType: lookup(path) || "application/octet-stream",
  };
}

async function collectPayload(): Promise<UploadFile[]> {
  // Default: send whatever is on the clipboard.
  // 1) A file on the clipboard
  const clip = await Clipboard.read();
  if (clip.file) {
    return [fileToUpload(decodeURIComponent(clip.file.replace(/^file:\/\//, "")))];
  }

  // 2) A raw clipboard image via pngpaste
  const tmp = join(tmpdir(), `drip-clip-${Date.now()}.png`);
  try {
    execFileSync(resolvePngpaste(), [tmp]);
    return [fileToUpload(tmp)];
  } catch {
    /* no clipboard image — fall through to the Finder selection */
  }

  // 3) Fallback: the current Finder selection
  try {
    const items = await getSelectedFinderItems();
    if (items.length > 0) return items.map((i) => fileToUpload(i.path));
  } catch {
    /* Finder not frontmost / no selection */
  }

  throw new Error("Nothing to send: no clipboard file/image or Finder selection.");
}

export default async function main(): Promise<void> {
  const prefs = getPreferenceValues<Prefs>();
  const client = new DripClient({ baseUrl: prefs.baseUrl, token: prefs.token || undefined });

  await showToast({ style: Toast.Style.Animated, title: "Sending to drip…" });

  try {
    const payload = await collectPayload();
    const results: UploadResult[] = await client.uploadFiles(payload, { ttl: prefs.ttl || undefined });
    await Clipboard.copy(results.map((r) => r.url).join("\n"));
    await showHUD(`Copied ✓ ${results.length} url(s) · expires ${prefs.ttl || "24h"}`);
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "drip failed", message: (e as Error).message });
  }
}
