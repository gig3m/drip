import type { UploadResult, UploadManyResult, UploadOptions, FileListItem } from "./types.js";

export class DripError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "DripError";
  }
}

export function filenameFromDisposition(h: string | null): string | undefined {
  if (!h) return undefined;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(h);
  return m?.[1];
}

export interface DripClientConfig { baseUrl: string; token?: string }

export class DripClient {
  constructor(private cfg: DripClientConfig) {}

  private headers(): Record<string, string> {
    return this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {};
  }

  async uploadBytes(bytes: Uint8Array, filename: string, contentType: string, opts: UploadOptions = {}): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as ArrayBuffer], { type: contentType }), filename);
    const json = await this.post(form, opts);
    return "items" in json ? json.items[0] : json;
  }

  async uploadFiles(files: { bytes: Uint8Array; filename: string; contentType: string }[], opts: UploadOptions = {}): Promise<UploadResult[]> {
    const form = new FormData();
    for (const f of files) form.append("file", new Blob([f.bytes as unknown as ArrayBuffer], { type: f.contentType }), f.filename);
    const json = await this.post(form, opts);
    return "items" in json ? json.items : [json];
  }

  private async post(form: FormData, opts: UploadOptions): Promise<UploadResult | UploadManyResult> {
    const url = new URL("/upload", this.cfg.baseUrl);
    if (opts.ttl) url.searchParams.set("ttl", opts.ttl);
    const res = await fetch(url, { method: "POST", body: form, headers: this.headers() });
    if (!res.ok) throw new DripError(res.status, `upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as UploadResult | UploadManyResult;
  }

  async list(limit?: number): Promise<FileListItem[]> {
    const url = new URL("/files", this.cfg.baseUrl);
    if (limit != null) url.searchParams.set("limit", String(limit));
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new DripError(res.status, `list failed: ${res.status}`);
    return (await res.json()) as FileListItem[];
  }

  async get(idOrUrl: string): Promise<{ bytes: Uint8Array; filename: string; contentType: string }> {
    const url = /^https?:\/\//.test(idOrUrl)
      ? idOrUrl
      : new URL(`/f/${encodeURIComponent(idOrUrl)}`, this.cfg.baseUrl).toString();
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new DripError(res.status, `get failed: ${res.status} ${await res.text().catch(() => "")}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? "download";
    return { bytes, filename, contentType };
  }

  /** Re-arm a drip to expire `ttl` (e.g. "24h") from now. The server caps it at its max ttl. */
  async setTtl(id: string, ttl: string): Promise<FileListItem> {
    const url = new URL(`/f/${encodeURIComponent(id)}`, this.cfg.baseUrl);
    url.searchParams.set("ttl", ttl);
    const res = await fetch(url, { method: "PATCH", headers: this.headers() });
    if (!res.ok) throw new DripError(res.status, `ttl failed: ${res.status}`);
    return (await res.json()) as FileListItem;
  }

  async delete(id: string): Promise<void> {
    const url = new URL(`/f/${encodeURIComponent(id)}`, this.cfg.baseUrl);
    const res = await fetch(url, { method: "DELETE", headers: this.headers() });
    if (!res.ok) throw new DripError(res.status, `delete failed: ${res.status}`);
  }
}
