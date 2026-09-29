import { describe, it, expect } from "vitest";
import { detectBackend, macosBackend, readClipboard, waylandBackend, writeClipboardBytes, x11Backend, type Runner, type RunOptions, type TempWriter } from "./clipboard.js";

// Fakes the subprocess layer: keys are the argv joined by spaces.
function fakeRunner(responses: Record<string, string | Uint8Array | { stderr: string }>) {
  const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  const run: Runner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = [cmd, ...args].join(" ");
    const v = responses[key];
    if (v === undefined) throw new Error(`no such tool or target: ${key}`);
    if (typeof v === "object" && "stderr" in v) {
      const err = new Error(`Command failed: ${key}`) as Error & { stderr: string };
      err.stderr = v.stderr;
      throw err;
    }
    return Buffer.from(v as Uint8Array);
  };
  return { run, calls };
}

const nothingExists = () => false;
const allExist = () => true;

describe("wayland backend read", () => {
  it("returns the first image target offered, not PNG by preference", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "image/jpeg\nimage/png\ntext/plain\n",
      "wl-paste --no-newline --type image/jpeg": "JPEGBYTES",
    });
    const got = waylandBackend(run, nothingExists).read();
    expect(got).toEqual({ kind: "blob", bytes: new Uint8Array(Buffer.from("JPEGBYTES")), contentType: "image/jpeg" });
  });

  it("ignores duplicate and parameterised targets when picking an image", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "text/plain;charset=utf-8\nTEXT\nimage/png\nimage/png\n",
      "wl-paste --no-newline --type image/png": "PNGBYTES",
    });
    const got = waylandBackend(run, nothingExists).read();
    expect(got).toMatchObject({ kind: "blob", contentType: "image/png" });
  });

  it("prefers a uri-list of files over an image on the same clipboard", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "text/uri-list\nimage/png\n",
      "wl-paste --no-newline --type text/uri-list": "file:///home/user/a.png\r\nfile:///home/user/b.pdf\r\n",
    });
    const got = waylandBackend(run, allExist).read();
    expect(got).toEqual({ kind: "files", paths: ["/home/user/a.png", "/home/user/b.pdf"] });
  });

  it("percent-decodes uri-list paths", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "text/uri-list\n",
      "wl-paste --no-newline --type text/uri-list": "file:///home/user/my%20shot%20(1).png\nfile:///home/user/caf%C3%A9.jpg\n",
    });
    const got = waylandBackend(run, allExist).read();
    expect(got).toEqual({ kind: "files", paths: ["/home/user/my shot (1).png", "/home/user/café.jpg"] });
  });

  it("drops GNOME's leading verb line and non-file schemes", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "x-special/gnome-copied-files\n",
      "wl-paste --no-newline --type x-special/gnome-copied-files":
        "copy\nfile:///home/user/a.png\nhttps://example.com/b.png\n",
    });
    const got = waylandBackend(run, allExist).read();
    expect(got).toEqual({ kind: "files", paths: ["/home/user/a.png"] });
  });

  it("falls through to the image branch when the uri-list names no existing file", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "text/uri-list\nimage/png\n",
      "wl-paste --no-newline --type text/uri-list": "file:///tmp/deleted-yesterday.png\n",
      "wl-paste --no-newline --type image/png": "PNGBYTES",
    });
    const got = waylandBackend(run, nothingExists).read();
    expect(got).toMatchObject({ kind: "blob", contentType: "image/png" });
  });

  it("errors with the deduped list of types actually held", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": "text/plain;charset=utf-8\ntext/plain\ntext/html\n",
    });
    expect(() => waylandBackend(run, allExist).read()).toThrow(
      "nothing to send: no file or image on the clipboard (it holds: text/plain, text/html)",
    );
  });

  it("errors clearly on a wholly empty clipboard", () => {
    const { run } = fakeRunner({ "wl-paste --list-types": "\n" });
    expect(() => waylandBackend(run, allExist).read()).toThrow("nothing to send: the clipboard is empty");
  });
});

describe("x11 backend read", () => {
  it("queries TARGETS and reads the chosen type via xclip", () => {
    const { run } = fakeRunner({
      "xclip -selection clipboard -t TARGETS -o": "TIMESTAMP\nimage/png\ntext/plain\n",
      "xclip -selection clipboard -t image/png -o": "PNGBYTES",
    });
    const got = x11Backend(run, nothingExists, "xclip").read();
    expect(got).toMatchObject({ kind: "blob", contentType: "image/png" });
  });

  it("reads a uri-list via xclip", () => {
    const { run } = fakeRunner({
      "xclip -selection clipboard -t TARGETS -o": "text/uri-list\n",
      "xclip -selection clipboard -t text/uri-list -o": "file:///home/user/a.png\n",
    });
    expect(x11Backend(run, allExist, "xclip").read()).toEqual({ kind: "files", paths: ["/home/user/a.png"] });
  });

  it("xsel can still deliver files but names xclip for images", () => {
    const withFiles = fakeRunner({ "xsel --clipboard --output": "file:///home/user/a.png\n" });
    expect(x11Backend(withFiles.run, allExist, "xsel").read()).toEqual({
      kind: "files",
      paths: ["/home/user/a.png"],
    });
    const withText = fakeRunner({ "xsel --clipboard --output": "just some text\n" });
    expect(() => x11Backend(withText.run, allExist, "xsel").read()).toThrow(
      "nothing to send: no file on the clipboard (install xclip for image support)",
    );
  });
});

describe("backend detection", () => {
  const detect = (env: Record<string, string>, tools: string[], platform = "linux") =>
    detectBackend({ platform, env, hasTool: (t) => tools.includes(t), run: () => Buffer.alloc(0), exists: allExist });

  it("uses macOS on darwin whatever the display env says", () => {
    expect(detect({ WAYLAND_DISPLAY: "wayland-1" }, [], "darwin")?.name).toBe("macos");
  });

  it("prefers wayland when WAYLAND_DISPLAY is set and wl-paste is installed", () => {
    expect(detect({ WAYLAND_DISPLAY: "wayland-1" }, ["wl-paste"])?.name).toBe("wayland");
  });

  it("still prefers wayland under Xwayland, where both display vars are set", () => {
    expect(detect({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" }, ["wl-paste", "xclip"])?.name).toBe("wayland");
  });

  it("falls through to X11 when WAYLAND_DISPLAY is set but wl-clipboard is not installed", () => {
    expect(detect({ WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" }, ["xclip"])?.name).toBe("x11");
  });

  it("accepts xsel when xclip is absent", () => {
    expect(detect({ DISPLAY: ":0" }, ["xsel"])?.name).toBe("x11");
  });

  it("finds nothing on a headless session", () => {
    expect(detect({}, ["xclip"])).toBeUndefined();
  });

  it("finds nothing when a display is set but no tool is installed", () => {
    expect(detect({ DISPLAY: ":0" }, [])).toBeUndefined();
  });
});

describe("no-backend errors name the right remedy", () => {
  const read = (env: Record<string, string>) =>
    readClipboard({ platform: "linux", env, hasTool: () => false, run: () => Buffer.alloc(0), exists: allExist });

  it("tells a headless session to pass a path instead of installing anything", () => {
    expect(() => read({})).toThrow(
      "no clipboard on this session (no WAYLAND_DISPLAY or DISPLAY) — pass a file path instead: drip <file>",
    );
  });

  it("names wl-clipboard under Wayland", () => {
    expect(() => read({ WAYLAND_DISPLAY: "wayland-1" })).toThrow("no clipboard tool found: install wl-clipboard");
  });

  it("names xclip under X11", () => {
    expect(() => read({ DISPLAY: ":0" })).toThrow("no clipboard tool found: install xclip");
  });
});

describe("writing the URL back to the clipboard", () => {
  it("detaches wl-copy and never passes --foreground", () => {
    const { run, calls } = fakeRunner({ "wl-copy": "" });
    expect(waylandBackend(run, allExist).writeText("https://drip/f/abc")).toBe(true);
    expect(calls[0]!.cmd).toBe("wl-copy");
    expect(calls[0]!.args).not.toContain("--foreground");
    expect(calls[0]!.opts).toMatchObject({ input: "https://drip/f/abc", detach: true });
  });

  it("detaches xclip too", () => {
    const { run, calls } = fakeRunner({ "xclip -selection clipboard -i": "" });
    expect(x11Backend(run, allExist, "xclip").writeText("u")).toBe(true);
    expect(calls[0]!.opts).toMatchObject({ detach: true });
  });

  it("reports failure rather than throwing when the tool dies", () => {
    const { run } = fakeRunner({});
    expect(waylandBackend(run, allExist).writeText("u")).toBe(false);
  });
});

describe("macos backend keeps today's behaviour", () => {
  const FURL = ["-e", "POSIX path of (the clipboard as «class furl»)"];

  it("returns a Finder-copied file", () => {
    const { run } = fakeRunner({ [`osascript ${FURL.join(" ")}`]: "/Users/user/a.png\n" });
    expect(macosBackend(run, allExist).read()).toEqual({ kind: "files", paths: ["/Users/user/a.png"] });
  });

  it("falls back to pngpaste when the clipboard holds no file", () => {
    const { run } = fakeRunner({ "pngpaste -": "PNGBYTES" });
    expect(macosBackend(run, allExist).read()).toMatchObject({ kind: "blob", contentType: "image/png" });
  });

  it("names pngpaste when there is neither a file nor an image", () => {
    const { run } = fakeRunner({});
    expect(() => macosBackend(run, allExist).read()).toThrow(
      "nothing to send: no file or image on the clipboard (for images, install pngpaste)",
    );
  });

  it("writes with pbcopy", () => {
    const { run, calls } = fakeRunner({ pbcopy: "" });
    expect(macosBackend(run, allExist).writeText("u")).toBe(true);
    expect(calls[0]!.cmd).toBe("pbcopy");
  });
});

describe("a present tool that cannot reach the display", () => {
  it("does not leak xclip's raw subprocess failure", () => {
    const { run } = fakeRunner({
      "xclip -selection clipboard -t TARGETS -o": { stderr: "Error: Can't open display: :0\n" },
    });
    expect(() => x11Backend(run, allExist, "xclip").read()).toThrow(
      "could not read the X11 clipboard (xclip failed — is DISPLAY set to a running display?)",
    );
  });

  it("does not leak wl-paste's raw subprocess failure", () => {
    const { run } = fakeRunner({
      "wl-paste --list-types": { stderr: "failed to connect to a Wayland compositor\n" },
    });
    expect(() => waylandBackend(run, allExist).read()).toThrow(
      "could not read the Wayland clipboard (wl-paste failed — is WAYLAND_DISPLAY set to a running compositor?)",
    );
  });
});

// Both found by running the real checklist under Xvfb against real xclip.
describe("regressions from the real X11 run", () => {
  it("an unowned X11 clipboard is empty, not a broken display", () => {
    const { run } = fakeRunner({
      "xclip -selection clipboard -t TARGETS -o": { stderr: "Error: target TARGETS not available\n" },
    });
    expect(() => x11Backend(run, allExist, "xclip").read()).toThrow("nothing to send: the clipboard is empty");
  });

  it("reports X11 text atoms as text rather than listing TARGETS and UTF8_STRING", () => {
    const { run } = fakeRunner({
      "xclip -selection clipboard -t TARGETS -o": "TIMESTAMP\nTARGETS\nMULTIPLE\nSAVE_TARGETS\nUTF8_STRING\nSTRING\nTEXT\n",
    });
    expect(() => x11Backend(run, allExist, "xclip").read()).toThrow(
      "nothing to send: no file or image on the clipboard (it holds: text)",
    );
  });

  it("treats a clipboard holding only X11 meta-atoms as empty", () => {
    const { run } = fakeRunner({ "xclip -selection clipboard -t TARGETS -o": "TIMESTAMP\nTARGETS\nMULTIPLE\n" });
    expect(() => x11Backend(run, allExist, "xclip").read()).toThrow("nothing to send: the clipboard is empty");
  });

  it("still names real MIME types when the clipboard has them", () => {
    const { run } = fakeRunner({
      "xclip -selection clipboard -t TARGETS -o": "TARGETS\ntext/html\nUTF8_STRING\ntext/plain\n",
    });
    expect(() => x11Backend(run, allExist, "xclip").read()).toThrow("(it holds: text/html, text/plain)");
  });
});

describe("writeBytes", () => {
  const PNG = new Uint8Array([137, 80, 78, 71]);

  it("wayland pipes bytes to wl-copy --type, detached", () => {
    const { run, calls } = fakeRunner({ "wl-copy --type image/png": "" });
    expect(waylandBackend(run, nothingExists).writeBytes(PNG, "image/png")).toBe(true);
    expect(calls[0]).toEqual({ cmd: "wl-copy", args: ["--type", "image/png"], opts: { input: PNG, detach: true } });
  });

  it("xclip pipes bytes with -t <mime>, detached", () => {
    const { run, calls } = fakeRunner({ "xclip -selection clipboard -t image/jpeg -i": "" });
    expect(x11Backend(run, nothingExists, "xclip").writeBytes(PNG, "image/jpeg")).toBe(true);
    expect(calls[0]!.opts).toEqual({ input: PNG, detach: true });
  });

  it("xsel cannot carry a MIME type, so it declines without running anything", () => {
    const { run, calls } = fakeRunner({});
    expect(x11Backend(run, nothingExists, "xsel").writeBytes(PNG, "image/png")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports false when the tool fails", () => {
    const { run } = fakeRunner({});
    expect(waylandBackend(run, nothingExists).writeBytes(PNG, "image/png")).toBe(false);
  });

  it("macos sets the clipboard from a temp file as PNGf and cleans up", () => {
    let cleaned = 0;
    const writeTemp: TempWriter = (_b, ext) => ({ path: `/tmp/d/clip.${ext}`, cleanup: () => { cleaned++; } });
    const script = 'set the clipboard to (read (POSIX file "/tmp/d/clip.png") as «class PNGf»)';
    const { run, calls } = fakeRunner({ [`osascript -e ${script}`]: "" });
    expect(macosBackend(run, nothingExists, writeTemp).writeBytes(PNG, "image/png")).toBe(true);
    expect(calls[0]!.args).toEqual(["-e", script]);
    expect(cleaned).toBe(1);
  });

  it("macos cleans up even when osascript fails", () => {
    let cleaned = 0;
    const writeTemp: TempWriter = (_b, ext) => ({ path: `/tmp/d/clip.${ext}`, cleanup: () => { cleaned++; } });
    const { run } = fakeRunner({});
    expect(macosBackend(run, nothingExists, writeTemp).writeBytes(PNG, "image/jpeg")).toBe(false);
    expect(cleaned).toBe(1);
  });

  it("macos declines image types AppleScript has no class for", () => {
    const { run, calls } = fakeRunner({});
    expect(macosBackend(run, nothingExists, () => { throw new Error("unused"); }).writeBytes(PNG, "image/webp")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("writeClipboardBytes returns false with no backend", () => {
    const { run } = fakeRunner({});
    expect(writeClipboardBytes(PNG, "image/png", { platform: "linux", env: {}, hasTool: () => false, run, exists: nothingExists })).toBe(false);
  });
});
