import { DripError, type DripClient, type FileListItem } from "@drip/shared";
import { humanAge, humanSize } from "../format.js";
import { bareType, contentKind } from "./kind.js";

export { contentKind };
import type { Key, Terminal } from "./term.js";
import {
  advance, animating, clearStatus, fitView, FRAME_MS, initialState, reduce, removeItem, replaceItem, startAnim, TTLS,
  withItems, withStatus, type Effect, type State,
} from "./state.js";
import { DEFAULT_LOOK, listHeight, render, type Look } from "./render.js";

export const LIST_LIMIT = 200;

export interface AppDeps {
  client: Pick<DripClient, "list" | "get" | "delete" | "setTtl">;
  copyText(text: string): boolean;
  copyBytes(bytes: Uint8Array, contentType: string): boolean;
  exists(path: string): boolean;
  /** Must fail rather than overwrite (flag "wx"). */
  writeFile(path: string, bytes: Uint8Array): void;
  home: string;
  now(): number;
  /** Palette, Nerd Font glyphs and animations. Default: truecolor, icons, animated. */
  look?: Look;
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
        const next = withStatus(withItems(s, items, height, deps.now()), `${items.length} drips synced`, "ok");
        return animate(next, "refresh", deps);
      }
      case "copy-url":
        return deps.copyText(effect.item.url)
          ? animate(withStatus(s, "copied url · paste it to your agent", "ok"), "copy", deps)
          : withStatus(s, `clipboard unavailable — ${effect.item.url}`, "warn");
      case "copy-contents": {
        const next = await copyContents(effect.item, s, deps);
        return next.statusKind === "ok" ? animate(next, "copy", deps) : next;
      }
      case "set-ttl": {
        const item = await deps.client.setTtl(effect.item.id, effect.ttl);
        // Say the ttl that was picked, unless the server capped it ("3d" would read back as 2d23h → "2d").
        const ms = Date.parse(item.expires_at) - deps.now();
        const picked = TTLS.find(([label]) => label === effect.ttl)?.[1];
        const left = picked !== undefined && ms > picked - 60_000 ? effect.ttl : humanAge(ms);
        return withStatus(replaceItem(s, item, height), `${item.filename} now expires in ${left}`, "ok");
      }
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
    const offline = effect.kind === "refresh" && !(e instanceof DripError);
    return withStatus({ ...s, loading: false, ...(offline ? { online: false } : {}) }, message(e), "err");
  }
}

const animate = (s: State, kind: "refresh" | "copy", deps: AppDeps): State =>
  deps.look?.animations === false ? s : startAnim(s, kind);

/** Runs until the user quits. The caller owns term.close(). */
export function runTui(term: Terminal, deps: AppDeps, host: string): Promise<void> {
  let state = initialState();
  let done = false;
  let fadingSeq = -1;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const look = deps.look ?? DEFAULT_LOOK;
  const height = () => listHeight(term.rows);
  const draw = () => {
    if (done) return;
    const lines = render(state, term.cols, term.rows, deps.now(), host, look);
    // Synchronized update + clear-each-line-then-write: no trailing erase, which would
    // eat the last cell of a full-width row sitting in the pending-wrap position.
    term.write("\x1b[?2026h\x1b[H" + lines.map((l) => "\x1b[2K" + l).join("\r\n") + "\x1b[?2026l");
    scheduleFade();
    scheduleTick();
  };
  // Spinners and one-shot animations run off one frame timer that only lives while something moves.
  const scheduleTick = () => {
    const moving = look.animations && animating(state) && !done;
    if (moving && !ticker) {
      ticker = setInterval(() => { state = advance(state); draw(); }, FRAME_MS);
      ticker.unref?.();
    } else if (!moving && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
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
    const enqueue = (job: () => Promise<void>) => {
      chain = chain.then(job).catch((e) => { done = true; scheduleTick(); reject(e); });
    };

    const handle = async (key: Key) => {
      if (done) return;
      const step = reduce(state, key, height());
      state = step.state;
      if (step.effect?.kind === "quit") { done = true; scheduleTick(); resolve(); return; }
      if (step.effect) {
        state = step.effect.kind === "refresh"
          ? { ...withStatus(state, ""), loading: true }
          : withStatus(state, "working…", "busy");
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
