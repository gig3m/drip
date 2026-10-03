import qrcode from "qrcode-generator";

const QUIET = 2;
const cache = new Map<string, string[]>();

/**
 * A QR code for `text` as half-block rows, two modules per character cell.
 * Light modules (quiet zone included) are drawn as ink, so paint it light-on-dark.
 */
export function qrLines(text: string): string[] {
  const hit = cache.get(text);
  if (hit) return hit;
  const q = qrcode(0, "L");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const size = n + QUIET * 2;
  const light = (r: number, c: number) => {
    if (r >= size) return false;
    const y = r - QUIET, x = c - QUIET;
    return !(y >= 0 && x >= 0 && y < n && x < n && q.isDark(y, x));
  };
  const out: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let row = "";
    for (let c = 0; c < size; c++) {
      const top = light(r, c), bottom = light(r + 1, c);
      row += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    out.push(row);
  }
  if (cache.size > 64) cache.clear();
  cache.set(text, out);
  return out;
}
