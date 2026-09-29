// Injected at compile time by `bun build --define process.env.DRIP_BAKED_BASE_URL=...`.
// In a plain tsc/test build this is a normal (usually undefined) env lookup.
const BAKED_BASE_URL: string | undefined = process.env.DRIP_BAKED_BASE_URL;

export function loadCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  baked: string | undefined = BAKED_BASE_URL,
): { baseUrl: string; token?: string } {
  const baseUrl = env.DRIP_BASE_URL || baked;
  if (!baseUrl) throw new Error("DRIP_BASE_URL is required (export it in your shell profile)");
  return { baseUrl, token: env.DRIP_TOKEN || undefined };
}
