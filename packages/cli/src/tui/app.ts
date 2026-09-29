import { DripError, type DripClient, type FileListItem } from "@drip/shared";
import { humanSize } from "../format.js";
import { bareType, contentKind } from "./kind.js";

export { contentKind };
import type { Key, Terminal } from "./term.js";
import { clearStatus, fitView, initialState, reduce, removeItem, withItems, withStatus, type Effect, type State } from "./state.js";
import { listHeight, render } from "./render.js";

export const LIST_LIMIT = 200;

export interface AppDeps {
  client: Pick<DripClient, "list" | "get" | "delete">;
  copyText(text: string): boolean;
  copyBytes(bytes: Uint8Array, contentType: string): boolean;
  exists(path: string): boolean;
  /** Must fail rather than overwrite (flag "wx"). */
  writeFile(path: string, bytes: Uint8Array): void;
  home: string;
  now(): number;
  /** False under NO_COLOR or TERM=dumb: attributes only, no colours. */
  color: boolean;
  /** How long a finished status stays up. Default 4000. */
  fadeMs?: number;
}

type WorkEffect = Exclude<Effect, { kind: "quit" }>;

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? home + path.slice(1) : path;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function urlFallback(item: FileListItem, s: State, deps: AppDeps, why: string): State {
  return withStatus(s, deps.copyText(item.url) ? `${why}; copied url` : `${why}; clipboard unavailable`, "warn");
}

async function copyContents(item: FileListItem, s: State, deps: AppDeps): Promise<State> {
  const kind = contentKind(item.content_type);
  if (kind === "other") return urlFallback(item, s, deps, `no clipboard support for ${item.content_type}`);
  const { bytes, contentType } = await deps.client.get(item.id);
  if (kind === "text") {
    const ok = deps.copyText(new TextDecoder().decode(bytes));
    return ok ? withStatus(s, `copied ${humanSize(bytes.length)} text`, "ok") : withStatus(s, "clipboard unavailable", "warn");
  }
  if (deps.copyBytes(bytes, bareType(contentType))) return withStatus(s, `copied ${humanSize(bytes.length)} image`, "ok");
  return urlFallback(item, s, deps, `could not copy ${item.content_type} image`);
}

export async function runEffect(effect: WorkEffect, s: State, deps: AppDeps, height: number): Promise<State> {
  try {
    switch (effect.kind) {
      case "refresh": {
        const items = await deps.client.list(LIST_LIMIT);
        return withStatus(withItems(s, items, height), `${items.length} drips`);
      }
      case "copy-url":
        return deps.copyText(effect.item.url)
          ? withStatus(s, "copied url", "ok")
          : withStatus(s, `clipboard unavailable — ${effect.item.url}`, "warn");
      case "copy-contents":
        return await copyContents(effect.item, s, deps);
      case "save": {
        const path = expandHome(effect.path, deps.home);
        if (deps.exists(path)) return withStatus(s, `refusing to overwrite ${effect.path}`, "warn");
        const { bytes } = await deps.client.get(effect.item.id);
        deps.writeFile(path, bytes);
        return withStatus(s, `saved ${effect.path}`, "ok");
      }
      case "delete":
        await deps.client.delete(effect.item.id);
        return withStatus(removeItem(s, effect.item.id, height), `deleted ${effect.item.filename}`, "ok");
    }
  } catch (e) {
    if (e instanceof DripError && e.status === 404 && "item" in effect) {
      return withStatus(removeItem(s, effect.item.id, height), "expired or already deleted", "warn");
    }
    return withStatus({ ...s, loading: false }, message(e), "err");
  }
}

/** Runs until the user quits. The caller owns term.close(). */
export function runTui(term: Terminal, deps: AppDeps, host: string): Promise<void> {
  let state = initialState();
  let done = false;
  let fadingSeq = -1;
  const height = () => listHeight(term.rows);
  const draw = () => {
    if (done) return;
    const lines = render(state, term.cols, term.rows, deps.now(), host, deps.color);
    // Synchronized update + clear-each-line-then-write: no trailing erase, which would
    // eat the last cell of a full-width row sitting in the pending-wrap position.
    term.write("\x1b[?2026h\x1b[H" + lines.map((l) => "\x1b[2K" + l).join("\r\n") + "\x1b[?2026l");
    scheduleFade();
  };
  // A finished message clears itself; a newer message (higher seq) makes the old timer a no-op.
  const scheduleFade = () => {
    const seq = state.statusSeq;
    if (!state.status || state.statusKind === "busy" || seq === fadingSeq) return;
    fadingSeq = seq;
    const t = setTimeout(() => { state = clearStatus(state, seq); if (state.statusSeq === seq) draw(); }, deps.fadeMs ?? 4000);
    t.unref?.();
  };

  return new Promise<void>((resolve, reject) => {
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (job: () => Promise<void>) => { chain = chain.then(job).catch((e) => { done = true; reject(e); }); };

    const handle = async (key: Key) => {
      if (done) return;
      const step = reduce(state, key, height());
      state = step.state;
      if (step.effect?.kind === "quit") { done = true; resolve(); return; }
      if (step.effect) {
        state = withStatus(state, "working…", "busy");
        draw();
        state = await runEffect(step.effect, state, deps, height());
      }
      draw();
    };

    term.onKeys((keys) => { for (const k of keys) enqueue(() => handle(k)); });
    term.onResize(() => { state = fitView(state, height()); draw(); });
    enqueue(async () => {
      draw();
      state = await runEffect({ kind: "refresh" }, state, deps, height());
      draw();
    });
  });
}
