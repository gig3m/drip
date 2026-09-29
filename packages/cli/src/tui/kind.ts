// Which clipboard treatment (and which colour) a drip's content type gets.
const TEXT_APP = new Set([
  "application/json", "application/xml", "application/javascript", "application/x-javascript",
  "application/yaml", "application/x-yaml", "application/toml", "application/x-sh", "application/sql",
]);

export const bareType = (t: string) => t.split(";")[0]!.trim().toLowerCase();

export function contentKind(contentType: string): "image" | "text" | "other" {
  const t = bareType(contentType);
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("text/") || TEXT_APP.has(t) || t.endsWith("+json") || t.endsWith("+xml")) return "text";
  return "other";
}

