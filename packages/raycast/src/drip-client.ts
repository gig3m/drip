/**
 * Self-contained drip upload client for the Raycast extension.
 *
 * This intentionally duplicates the shape of `packages/shared/src/client.ts`
 * rather than depending on `@drip/shared`. Raycast's build/publish tooling
 * (esbuild via the `ray` CLI, and `npm` for installing) does not understand
 * pnpm's `workspace:*` protocol, so a workspace dependency would fail to
 * resolve outside this monorepo's pnpm install. Keeping this file
 * dependency-free keeps the extension buildable/publishable on its own.
 */

export interface UploadResult {
  id: string;
  url: string;
  filename: string;
  size: number;
  content_type: string;
  expires_at: string;
}

export interface UploadManyResult {
  items: UploadResult[];
}

export interface UploadOptions {
  ttl?: string;
}

export class DripError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "DripError";
  }
}

export interface DripClientConfig {
  baseUrl: string;
  token?: string;
}

export interface UploadFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export class DripClient {
  constructor(private cfg: DripClientConfig) {}

  private headers(): Record<string, string> {
    return this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {};
  }

  async uploadFiles(files: UploadFile[], opts: UploadOptions = {}): Promise<UploadResult[]> {
    const form = new FormData();
    for (const f of files) {
      form.append("file", new Blob([f.bytes as unknown as ArrayBuffer], { type: f.contentType }), f.filename);
    }
    const json = await this.post(form, opts);
    return "items" in json ? json.items : [json];
  }

  private async post(form: FormData, opts: UploadOptions): Promise<UploadResult | UploadManyResult> {
    const url = new URL("/upload", this.cfg.baseUrl);
    if (opts.ttl) url.searchParams.set("ttl", opts.ttl);
    const res = await fetch(url, { method: "POST", body: form, headers: this.headers() });
    if (!res.ok) {
      throw new DripError(res.status, `upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as UploadResult | UploadManyResult;
  }
}
