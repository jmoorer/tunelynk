const MAX_LENGTH = 512;

// Accepts only same-site absolute paths, so a crafted link can't bounce a
// freshly signed-in user to another origin.
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > MAX_LENGTH) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.startsWith("/\\")) return undefined;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
}
