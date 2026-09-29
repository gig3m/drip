import { describe, it, expect } from "vitest";
import { humanSize, humanAge } from "./format.js";

describe("humanSize", () => {
  it("formats bytes/KB/MB", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(95_000_000)).toBe("90.6 MB");
  });
});

describe("humanAge", () => {
  it("formats a duration compactly, floors negatives to 0s", () => {
    expect(humanAge(5_000)).toBe("5s");
    expect(humanAge(90_000)).toBe("1m");
    expect(humanAge(3_600_000)).toBe("1h");
    expect(humanAge(90_000_000)).toBe("1d");
    expect(humanAge(-5_000)).toBe("0s");
  });
});
