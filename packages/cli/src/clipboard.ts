import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

// Every clipboard subprocess in the CLI lives here. index.ts keeps only policy:
// what to upload and what to print. Backends take an injectable runner so the
// parsing can be tested without a compositor.

export type ClipContent =
  | { kind: "files"; paths: string[] }
  | { kind: "blob"; bytes: Uint8Array; contentType: string };

export type RunOptions = {
  input?: string | Uint8Array;
  // Selection-owning writers (wl-copy, xclip -i) fork a background process that
  // keeps serving the clipboard after we exit. See writeText() below.
  detach?: boolean;
};

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Buffer;

export interface ClipboardBackend {
  readonly name: "macos" | "wayland" | "x11";
  read(): ClipContent;
  writeText(text: string): boolean;
  /** Put raw content of the given MIME type on the clipboard. False when unsupported or failed. */
  writeBytes(bytes: Uint8Array, contentType: string): boolean;
}

export class ClipboardError extends Error {}

export type TempWriter = (bytes: Uint8Array, ext: string) => { path: string; cleanup: () => void };

export const defaultTempWriter: TempWriter = (bytes, ext) => {
  const dir = mkdtempSync(join(tmpdir(), "drip-"));
  const path = join(dir, `clip.${ext}`);
  writeFileSync(path, bytes);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// AppleScript can only put image data on the pasteboard for types it has a class for.
const MAC_IMAGE: Record<string, { cls: string; ext: string }> = {
  "image/png": { cls: "\u00abclass PNGf\u00bb", ext: "png" },
  "image/jpeg": { cls: "JPEG picture", ext: "jpg" },
};

/** Targets that carry file references rather than content, in preference order. */
const FILE_TARGETS = ["text/uri-list", "x-special/gnome-copied-files"];

const bareType = (t: string): string => t.split(";")[0]!.trim();

function parseTargets(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// A uri-list is one URI per line. GNOME prefixes a `copy`/`cut` verb line and
// other apps may include `#` comments or non-file schemes; all are non-file://
// and fall out of the same filter.
function parseUriList(raw: string, exists: (p: string) => boolean): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("file://"))
    .map((l) => decodeURIComponent(l.slice("file://".length)))
    .filter(exists);
}

// X11 advertises protocol atoms alongside real MIME types; none of them tell a
// human what is on the clipboard.
const X11_META = new Set(["TARGETS", "MULTIPLE", "TIMESTAMP", "SAVE_TARGETS", "DELETE", "INSERT_SELECTION", "INSERT_PROPERTY"]);
const X11_TEXT = new Set(["UTF8_STRING", "STRING", "TEXT", "COMPOUND_TEXT"]);

/** The types worth naming back to the user, in offered order. */
function describeTargets(targets: string[]): string[] {
  const named: string[] = [];
  let text = false;
  for (const t of targets.map(bareType)) {
    if (X11_META.has(t)) continue;
    if (X11_TEXT.has(t)) { text = true; continue; }
    named.push(t);
  }
  if (text && !named.some((t) => t.startsWith("text/"))) named.push("text");
  return [...new Set(named)];
}

// These tools exit non-zero both when the display is unreachable and when the
// clipboard simply has no owner, so the exit code alone cannot tell those apart
// — only stderr can. Guessing "display broken" for both sends someone chasing a
// working DISPLAY when their clipboard was merely empty.
function isDisplayFailure(e: unknown): boolean {
  const stderr = String((e as { stderr?: unknown } | null)?.stderr ?? "");
  return /(can'?t|cannot|unable to) open display|failed to connect to (a|the) wayland|no wayland (display|compositor)/i.test(stderr);
}

function tryRead(read: () => Buffer, tool: string, surface: string, envVar: string): Buffer {
  try {
    return read();
  } catch (e) {
    if (isDisplayFailure(e)) {
      throw new ClipboardError(
        `could not read the ${surface} clipboard (${tool} failed — is ${envVar} set to a running ${surface === "X11" ? "display" : "compositor"}?)`,
      );
    }
    throw new ClipboardError("nothing to send: the clipboard is empty");
  }
}

function pickImageTarget(targets: string[]): string | undefined {
  // Offered order is the source's own preference — a copied JPEG stays a JPEG.
  return targets.find((t) => bareType(t).startsWith("image/"));
}

function nothingUsable(targets: string[]): never {
  const held = describeTargets(targets);
  if (held.length === 0) throw new ClipboardError("nothing to send: the clipboard is empty");
  throw new ClipboardError(`nothing to send: no file or image on the clipboard (it holds: ${held.join(", ")})`);
}

/** Shared shape: list the targets, try files, then the first image, else explain. */
function readByTargets(
  targets: string[],
  readTarget: (t: string) => Buffer,
  exists: (p: string) => boolean,
): ClipContent {
  for (const t of FILE_TARGETS) {
    if (!targets.some((o) => bareType(o) === t)) continue;
    const paths = parseUriList(readTarget(t).toString("utf8"), exists);
    // A stale uri-list naming deleted files must not mask a real image.
    if (paths.length > 0) return { kind: "files", paths };
  }
  const image = pickImageTarget(targets);
  if (image) return { kind: "blob", bytes: new Uint8Array(readTarget(image)), contentType: bareType(image) };
  nothingUsable(targets);
}

export function macosBackend(
  run: Runner,
  exists: (p: string) => boolean,
  writeTemp: TempWriter = defaultTempWriter,
): ClipboardBackend {
  return {
    name: "macos",
    read() {
      // A file copied in Finder lands on the pasteboard as a file URL; AppleScript
      // coerces the clipboard to a file reference and `POSIX path of` yields the
      // path (or osascript errors when the clipboard holds no file).
      try {
        const out = run("osascript", ["-e", "POSIX path of (the clipboard as \u00abclass furl\u00bb)"]).toString("utf8").trim();
        if (out && exists(out)) return { kind: "files", paths: [out] };
      } catch {
        // fall through to the image branch
      }
      try {
        return { kind: "blob", bytes: new Uint8Array(run("pngpaste", ["-"])), contentType: "image/png" };
      } catch {
        throw new ClipboardError(
          "nothing to send: no file or image on the clipboard (for images, install pngpaste)",
        );
      }
    },
    writeText(text) {
      try { run("pbcopy", [], { input: text }); return true; } catch { return false; }
    },
    writeBytes(bytes, contentType) {
      const kind = MAC_IMAGE[bareType(contentType)];
      if (!kind) return false;
      let tmp: ReturnType<TempWriter> | undefined;
      try {
        tmp = writeTemp(bytes, kind.ext);
        run("osascript", ["-e", `set the clipboard to (read (POSIX file "${tmp.path}") as ${kind.cls})`]);
        return true;
      } catch {
        return false;
      } finally {
        tmp?.cleanup();
      }
    },
  };
}

export function waylandBackend(run: Runner, exists: (p: string) => boolean): ClipboardBackend {
  return {
    name: "wayland",
    read() {
      const targets = parseTargets(
        tryRead(() => run("wl-paste", ["--list-types"]), "wl-paste", "Wayland", "WAYLAND_DISPLAY").toString("utf8"),
      );
      return readByTargets(targets, (t) => run("wl-paste", ["--no-newline", "--type", t]), exists);
    },
    writeText(text) {
      // wl-copy forks a background process that keeps serving the selection after
      // we exit. That child inherits our stdout/stderr, so without detach the
      // runner blocks until the clipboard is next replaced. And never pass
      // --foreground: it defeats the fork and hangs drip outright.
      try { run("wl-copy", [], { input: text, detach: true }); return true; } catch { return false; }
    },
    writeBytes(bytes, contentType) {
      try { run("wl-copy", ["--type", bareType(contentType)], { input: bytes, detach: true }); return true; } catch { return false; }
    },
  };
}

export function x11Backend(
  run: Runner,
  exists: (p: string) => boolean,
  tool: "xclip" | "xsel",
): ClipboardBackend {
  return {
    name: "x11",
    read() {
      if (tool === "xsel") {
        // xsel cannot query TARGETS, so it is text/URI-only by construction.
        const raw = tryRead(() => run("xsel", ["--clipboard", "--output"]), "xsel", "X11", "DISPLAY");
        const paths = parseUriList(raw.toString("utf8"), exists);
        if (paths.length > 0) return { kind: "files", paths };
        throw new ClipboardError("nothing to send: no file on the clipboard (install xclip for image support)");
      }
      const targets = parseTargets(
        tryRead(
          () => run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]),
          "xclip", "X11", "DISPLAY",
        ).toString("utf8"),
      );
      return readByTargets(targets, (t) => run("xclip", ["-selection", "clipboard", "-t", t, "-o"]), exists);
    },
    writeText(text) {
      // Same forking selection-owner problem as wl-copy above.
      const args = tool === "xsel" ? ["--clipboard", "--input"] : ["-selection", "clipboard", "-i"];
      try { run(tool, args, { input: text, detach: true }); return true; } catch { return false; }
    },
    writeBytes(bytes, contentType) {
      // xsel has no way to name a MIME type; the caller falls back to the URL.
      if (tool === "xsel") return false;
      try {
        run("xclip", ["-selection", "clipboard", "-t", bareType(contentType), "-i"], { input: bytes, detach: true });
        return true;
      } catch { return false; }
    },
  };
}

// ---- selection -------------------------------------------------------------

export type ClipboardDeps = {
  platform: string;
  env: NodeJS.ProcessEnv;
  hasTool: (name: string) => boolean;
  run: Runner;
  exists: (p: string) => boolean;
};

/**
 * darwin                                  -> macos
 * WAYLAND_DISPLAY set && wl-paste found   -> wayland
 * DISPLAY set && (xclip|xsel) found       -> x11
 * otherwise                               -> undefined
 *
 * Probe for the binary, not just the env var: a Wayland session running an
 * Xwayland app sets both, and a Wayland session without wl-clipboard installed
 * should fall through to X11 rather than hard-fail.
 */
export function detectBackend(d: ClipboardDeps): ClipboardBackend | undefined {
  if (d.platform === "darwin") return macosBackend(d.run, d.exists);
  if (d.env.WAYLAND_DISPLAY && d.hasTool("wl-paste")) return waylandBackend(d.run, d.exists);
  if (d.env.DISPLAY) {
    for (const tool of ["xclip", "xsel"] as const) {
      if (d.hasTool(tool)) return x11Backend(d.run, d.exists, tool);
    }
  }
  return undefined;
}

// Written for the environment actually detected. Telling someone on a headless
// SSH session to install a package would be a wild goose chase; telling them to
// pass a path is the actual answer.
function noBackendError(env: NodeJS.ProcessEnv): ClipboardError {
  if (env.WAYLAND_DISPLAY) return new ClipboardError("no clipboard tool found: install wl-clipboard");
  if (env.DISPLAY) return new ClipboardError("no clipboard tool found: install xclip");
  return new ClipboardError(
    "no clipboard on this session (no WAYLAND_DISPLAY or DISPLAY) — pass a file path instead: drip <file>",
  );
}

export function readClipboard(d: ClipboardDeps): ClipContent {
  const backend = detectBackend(d);
  if (!backend) throw noBackendError(d.env);
  return backend.read();
}

export function writeClipboardText(text: string, d: ClipboardDeps): boolean {
  return detectBackend(d)?.writeText(text) ?? false;
}

export function writeClipboardBytes(bytes: Uint8Array, contentType: string, d: ClipboardDeps): boolean {
  return detectBackend(d)?.writeBytes(bytes, contentType) ?? false;
}

// ---- production wiring -----------------------------------------------------

// Resolved by scanning PATH rather than shelling out to `which` — a tool probe
// runs on every invocation and should not cost a subprocess.
function toolOnPath(name: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, name)));
}

export function defaultDeps(): ClipboardDeps {
  return {
    platform: process.platform,
    env: process.env,
    hasTool: toolOnPath,
    exists: existsSync,
    run: (cmd, args, opts) =>
      execFileSync(cmd, args, {
        input: opts?.input,
        maxBuffer: 512 * 1024 * 1024,
        // Detached writers keep serving the selection after we exit; inheriting
        // our pipes would make execFileSync wait for them.
        stdio: opts?.detach ? ["pipe", "ignore", "ignore"] : ["pipe", "pipe", "pipe"],
      }) ?? Buffer.alloc(0),
  };
}
