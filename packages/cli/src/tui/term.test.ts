import { describe, it, expect } from "vitest";
import { decodeKeys } from "./term.js";

const names = (s: string) => decodeKeys(s).map((k) => (k.name === "char" ? k.ch : k.name));

describe("decodeKeys", () => {
  it("decodes arrows in CSI and SS3 form", () => {
    expect(names("\x1b[A\x1b[B\x1bOA\x1bOB")).toEqual(["up", "down", "up", "down"]);
  });
  it("decodes paging and home/end variants", () => {
    expect(names("\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~")).toEqual(["pageup", "pagedown", "home", "end", "home", "end"]);
  });
  it("treats a lone escape as esc", () => {
    expect(names("\x1b")).toEqual(["esc"]);
    expect(names("\x1bq")).toEqual(["esc", "q"]);
  });
  it("skips unknown CSI sequences whole", () => {
    expect(names("\x1b[1;5Ax")).toEqual(["x"]);
  });
  it("maps control bytes", () => {
    expect(names("\r\x7f\b\t\x03\x15")).toEqual(["enter", "backspace", "backspace", "tab", "ctrl-c", "ctrl-u"]);
  });
  it("ignores other control bytes", () => {
    expect(names("\x01a\x1f")).toEqual(["a"]);
  });
  it("keeps multi-byte characters whole", () => {
    expect(names("é😀")).toEqual(["é", "😀"]);
  });
  it("splits pasted text into one key per character", () => {
    expect(names("ab/")).toEqual(["a", "b", "/"]);
  });
});
