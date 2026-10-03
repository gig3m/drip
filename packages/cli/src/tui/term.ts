import type { ReadStream, WriteStream } from "node:tty";

export type KeyName =
  | "up" | "down" | "left" | "right" | "pageup" | "pagedown" | "home" | "end"
  | "enter" | "esc" | "backspace" | "tab" | "ctrl-c" | "ctrl-u" | "char";

export interface Key { name: KeyName; ch?: string }

const CSI: Record<string, KeyName> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
  "1~": "home", "7~": "home", "4~": "end", "8~": "end", "5~": "pageup", "6~": "pagedown",
};
const SS3: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CONTROL: Record<string, KeyName> = {
  "\r": "enter", "\n": "enter", "\x7f": "backspace", "\b": "backspace", "\t": "tab", "\x03": "ctrl-c", "\x15": "ctrl-u",
};

/** Turn one chunk of raw-mode stdin into keys. Unknown escape sequences are dropped whole. */
export function decodeKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i]!;
    if (c === "\x1b") {
      const next = data[i + 1];
      if (next === "[") {
        // CSI: parameter/intermediate bytes, then one final byte in @..~
        let j = i + 2;
        while (j < data.length && !/[@-~]/.test(data[j]!)) j++;
        const name = CSI[data.slice(i + 2, j + 1)];
        if (name) keys.push({ name });
        i = j + 1;
        continue;
      }
      if (next === "O" && i + 2 < data.length) {
        const name = SS3[data[i + 2]!];
        if (name) keys.push({ name });
        i += 3;
        continue;
      }
      keys.push({ name: "esc" });
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(data.codePointAt(i)!);
    i += ch.length;
    if (CONTROL[ch]) keys.push({ name: CONTROL[ch] });
    else if (ch >= " ") keys.push({ name: "char", ch });
  }
  return keys;
}

export interface Terminal {
  readonly cols: number;
  readonly rows: number;
  write(s: string): void;
  onKeys(cb: (keys: Key[]) => void): void;
  onResize(cb: () => void): void;
  /** Idempotent. Leaves the alt screen, shows the cursor, leaves raw mode. */
  close(): void;
}

export function openTerminal(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Terminal {
  const offs: (() => void)[] = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const off of offs) off();
    output.write("\x1b[?25h\x1b[?1049l");
    input.setRawMode(false);
    input.pause();
  };
  // Raw mode delivers Ctrl-C as a key, so SIGINT never arrives; these cover kill/hangup.
  const onSignal = () => { close(); process.exit(130); };
  process.once("exit", close);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  offs.push(() => {
    process.off("exit", close);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  });

  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  output.write("\x1b[?1049h\x1b[?25l");

  return {
    get cols() { return output.columns || 80; },
    get rows() { return output.rows || 24; },
    write: (s) => { output.write(s); },
    onKeys(cb) {
      const h = (d: string) => cb(decodeKeys(d));
      input.on("data", h);
      offs.push(() => input.off("data", h));
    },
    onResize(cb) {
      output.on("resize", cb);
      offs.push(() => output.off("resize", cb));
    },
    close,
  };
}
