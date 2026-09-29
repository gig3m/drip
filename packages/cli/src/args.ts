export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "usage-error" }
  | { kind: "upgrade" }
  | { kind: "clip" }
  | { kind: "upload"; files: string[] }
  | { kind: "list"; n: number; json: boolean }
  | { kind: "get"; target: string; out?: string }
  | { kind: "raycast"; dir?: string }
  /** bare: no arguments at all, so a non-terminal caller gets help instead. */
  | { kind: "tui"; bare: boolean };

const SUBCOMMANDS = new Set(["clip", "send", "list", "get", "upgrade", "raycast", "tui", "browse"]);

export function route(argv: string[]): Command {
  const first = argv[0];
  if (first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version" || first === "-v") return { kind: "version" };
  if (argv.length === 0) return { kind: "tui", bare: true };

  // A token is a subcommand only if it exactly matches a known verb (no slash).
  if (SUBCOMMANDS.has(first)) {
    const rest = argv.slice(1);
    if (first === "clip") return { kind: "clip" };
    if (first === "tui" || first === "browse") return { kind: "tui", bare: false };
    if (first === "upgrade") return { kind: "upgrade" };
    if (first === "raycast") {
      let dir: string | undefined;
      for (let i = 0; i < rest.length; i++) if (rest[i] === "--dir") dir = rest[++i];
      return { kind: "raycast", dir };
    }
    if (first === "send") return rest.length ? { kind: "upload", files: rest } : { kind: "usage-error" };
    if (first === "list") {
      let n = 20;
      let json = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "-n") { n = Number(rest[++i]); if (!Number.isFinite(n)) n = 20; }
        else if (rest[i] === "--json") json = true;
      }
      return { kind: "list", n, json };
    }
    if (first === "get") {
      let out: string | undefined;
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "-o") out = rest[++i];
        else positional.push(rest[i]);
      }
      return positional[0] ? { kind: "get", target: positional[0], out } : { kind: "usage-error" };
    }
  }
  return { kind: "upload", files: argv };
}
