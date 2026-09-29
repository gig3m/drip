import { describe, it, expect } from "vitest";
import { contentTypeFor, extensionFor } from "./mime.js";
describe("contentTypeFor", () => {
  it("maps known extensions", () => {
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.pdf")).toBe("application/pdf");
  });
  it("falls back to octet-stream", () => {
    expect(contentTypeFor("mystery")).toBe("application/octet-stream");
  });
});

describe("extensionFor", () => {
  it("maps known image types", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpeg");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("image/svg+xml")).toBe("svg");
  });
  it("strips parameters before lookup", () => {
    expect(extensionFor("text/plain;charset=utf-8")).toBe("txt");
    expect(extensionFor("image/png; charset=binary")).toBe("png");
  });
  it("falls back to bin for unknown types", () => {
    expect(extensionFor("application/x-nonsense")).toBe("bin");
    expect(extensionFor("")).toBe("bin");
  });
});
