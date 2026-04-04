import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

/** How many bytes to read from the end of the file to find sops metadata.
 * The sops: block with KMS/MAC data is typically ~830 bytes. Use 2048 for safety. */
const TAIL_BYTES = 2048;

const SOPS_PATTERNS = [/\.sops\./];
const MAYBE_SOPS_PATTERNS = [/\.enc\.(yaml|yml|json)$/];

export function isDefinitelySops(filename: string): boolean {
  const base = basename(filename);
  return SOPS_PATTERNS.some((p) => p.test(base));
}

export function isMaybeSops(filename: string): boolean {
  const base = basename(filename);
  return MAYBE_SOPS_PATTERNS.some((p) => p.test(base));
}

/**
 * Check if a file contains SOPS metadata by reading only the tail.
 * The sops: block is always appended at the end of the file.
 */
export async function hasSopsMetadata(filepath: string): Promise<boolean> {
  let fh;
  try {
    const s = await stat(filepath);
    fh = await open(filepath, "r");
    const offset = Math.max(0, s.size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(s.size, TAIL_BYTES));
    await fh.read(buf, 0, buf.length, offset);
    const tail = buf.toString("utf-8");
    return tail.includes("\nsops:\n") || tail.includes('"sops":');
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

export function getLanguageId(filename: string): string {
  const match = filename.match(/\.(yaml|yml|json|ini|env)$/);
  const ext = match?.[1];
  switch (ext) {
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
      return "json";
    case "ini":
      return "ini";
    case "env":
      return "dotenv";
    default:
      return "yaml";
  }
}
