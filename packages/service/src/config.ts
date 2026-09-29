export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(m[1]) * mult[m[2]];
}

export function parseSize(s: string): number {
  const m = /^(\d+)(b|kb|mb|gb)$/i.exec(s.trim());
  if (!m) throw new Error(`invalid size: ${s}`);
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1_048_576, gb: 1_073_741_824 };
  return Number(m[1]) * mult[m[2].toLowerCase()];
}

export interface Config {
  baseUrl: string;
  dataDir: string;
  defaultTtlMs: number;
  maxTtlMs: number;
  maxSizeBytes: number;
  token?: string;
  sweepIntervalMs: number;
  port: number;
  publicDir?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = env.DRIP_BASE_URL;
  if (!baseUrl) throw new Error("DRIP_BASE_URL is required");
  try { new URL(baseUrl); } catch { throw new Error(`DRIP_BASE_URL must be a valid URL: ${baseUrl}`); }
  const port = Number(env.PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT: ${env.PORT}`);
  return {
    baseUrl,
    dataDir: env.DRIP_DATA_DIR ?? "/data",
    defaultTtlMs: parseDuration(env.DRIP_DEFAULT_TTL ?? "24h"),
    maxTtlMs: parseDuration(env.DRIP_MAX_TTL ?? "168h"),
    maxSizeBytes: parseSize(env.DRIP_MAX_SIZE ?? "100mb"),
    token: env.DRIP_TOKEN || undefined,
    sweepIntervalMs: parseDuration(env.DRIP_SWEEP_INTERVAL ?? "60s"),
    port,
    publicDir: env.DRIP_PUBLIC_DIR ?? "public",
  };
}
