import { lookup, extension } from "mime-types";

export function contentTypeFor(filename: string): string {
  return lookup(filename) || "application/octet-stream";
}

// Inverse of contentTypeFor: pick a file extension for a clipboard blob whose
// type the compositor told us. Parameters (`;charset=…`) are not part of the
// type and break the lookup table, so strip them first.
export function extensionFor(contentType: string): string {
  const bare = contentType.split(";")[0]!.trim();
  return extension(bare) || "bin";
}
