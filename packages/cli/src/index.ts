#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { DripClient, DripError, type UploadResult } from "@drip/shared";
import { loadCliConfig } from "./config.js";
import { contentTypeFor, extensionFor } from "./mime.js";
import { defaultDeps, readClipboard, writeClipboardBytes, writeClipboardText } from "./clipboard.js";
import { openTerminal } from "./tui/term.js";
import { runTui } from "./tui/app.js";
import { lookFromEnv } from "./tui/render.js";
import { route } from "./args.js";
import { humanSize, humanAge } from "./format.js";

const VERSION: string = process.env.DRIP_VERSION ?? "dev"; // baked by bun --define

const HELP = `drip — push files to your homelab, get an auto-expiring URL

usage:
  drip                      open the browser in a terminal (same as drip tui); help otherwise
  drip <file> [file...]     upload one or more files (prints + copies the URL)
  drip clip                 upload the file(s) or image on the clipboard
  drip list [-n N] [--json] list the N most recent files (default 20)
  drip get <id|url> [-o P]  download a file to CWD; -o P writes to P, -o - to stdout
  drip tui                  browse current drips: copy url/contents, save, change ttl, delete (alias: browse)
  drip send <file>...       alias of the bare upload form
  drip raycast [--dir P]    install the "Send to drip" Raycast script command
  drip upgrade              reinstall the latest drip
  drip --version | -v       print version
  drip --help  | -h         this help

base URL defaults to the value baked at build time; override with DRIP_BASE_URL.`;

function report(results: UploadResult[]): void {
  for (const r of results) console.log(r.url);
  const copied = writeClipboardText(results.map((r) => r.url).join("\n"), defaultDeps());
  console.error(copied ? `copied ${results.length} url(s) to clipboard` : `(clipboard copy unavailable — URL printed above)`);
}

async function main(): Promise<void> {
  const cmd = route(process.argv.slice(2));

  switch (cmd.kind) {
    case "help": console.log(HELP); return;
    case "version": console.log(VERSION); return;
    case "usage-error": console.error(HELP); process.exit(2);
    case "tui":
      // Scripts, pipes and agents run bare `drip` to learn the commands; only a person gets the browser.
      if (cmd.bare && !(process.stdin.isTTY && process.stdout.isTTY)) { console.error(HELP); process.exit(2); }
      break;
  }

  const cfg = loadCliConfig();
  if (cmd.kind === "upgrade") {
    const base = cfg.baseUrl.replace(/\/+$/, "");
    execFileSync("sh", ["-c", 'curl -fsSL "$DRIP_INSTALL_BASE/install.sh" | sh'], {
      stdio: "inherit",
      env: { ...process.env, DRIP_INSTALL_BASE: base },
    });
    return;
  }
  const client = new DripClient(cfg);

  switch (cmd.kind) {
    case "raycast": {
      const dir = cmd.dir ?? join(homedir(), ".raycast-scripts");
      const res = await fetch(new URL("/raycast/send-to-drip.sh", cfg.baseUrl));
      if (!res.ok) throw new Error(`could not fetch Raycast script: ${res.status}`);
      const script = await res.text();
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, "send-to-drip.sh");
      writeFileSync(dest, script, { mode: 0o755 });
      console.log(`installed "Send to drip" Raycast script command → ${dest}`);
      console.error(`one-time setup: Raycast → Settings → Extensions → Script Commands → "Add Directories" → ${dir}`);
      return;
    }
    case "clip": {
      const content = readClipboard(defaultDeps());
      if (content.kind === "files") {
        const files = content.paths.map((p) => ({
          bytes: new Uint8Array(readFileSync(p)),
          filename: basename(p),
          contentType: contentTypeFor(p),
        }));
        report(await client.uploadFiles(files));
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `clip-${stamp}.${extensionFor(content.contentType)}`;
      report([await client.uploadBytes(content.bytes, name, content.contentType)]);
      return;
    }
    case "upload": {
      const files = cmd.files.map((p) => ({ bytes: new Uint8Array(readFileSync(p)), filename: basename(p), contentType: contentTypeFor(p) }));
      report(await client.uploadFiles(files));
      return;
    }
    case "list": {
      const items = await client.list(cmd.n);
      if (cmd.json) { console.log(JSON.stringify(items, null, 2)); return; }
      const now = Date.now();
      console.log(`${"ID".padEnd(16)}  ${"AGE".padStart(5)}  ${"SIZE".padStart(9)}  ${"EXPIRES".padStart(7)}  FILENAME`);
      for (const it of items) {
        console.log(
          `${it.id.padEnd(16)}  ${humanAge(now - Date.parse(it.created_at)).padStart(5)}  ` +
          `${humanSize(it.size).padStart(9)}  ${humanAge(Date.parse(it.expires_at) - now).padStart(7)}  ${it.filename}`,
        );
      }
      return;
    }
    case "tui": {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("drip tui needs a terminal; use drip list");
        process.exit(2);
      }
      const term = openTerminal();
      try {
        await runTui(term, {
          client,
          copyText: (t) => writeClipboardText(t, defaultDeps()),
          copyBytes: (b, ct) => writeClipboardBytes(b, ct, defaultDeps()),
          exists: existsSync,
          writeFile: (p, b) => writeFileSync(p, b, { flag: "wx" }),
          home: homedir(),
          now: Date.now,
          look: lookFromEnv(process.env),
        }, new URL(cfg.baseUrl).host);
      } finally {
        term.close();
      }
      process.exit(0);
    }
    case "get": {
      let r;
      try { r = await client.get(cmd.target); }
      catch (e) {
        if (e instanceof DripError && e.status === 404) throw new Error(`not found or expired: ${cmd.target}`);
        throw e;
      }
      if (cmd.out === "-") { process.stdout.write(r.bytes); return; }
      const dest = cmd.out ?? r.filename;
      if (!cmd.out && existsSync(dest)) throw new Error(`refusing to overwrite ${dest} (use -o to choose a path)`);
      writeFileSync(dest, r.bytes);
      console.log(resolve(dest));
      return;
    }
  }
}

main().catch((e) => {
  console.error(e instanceof DripError ? `drip: server said ${e.status}: ${e.message}` : `drip: ${(e as Error).message}`);
  process.exit(1);
});
