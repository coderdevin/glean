/**
 * Read the Cloudflare Access identity from a request. Cloudflare injects this
 * header on every request that passes its Access policy. The app never trusts
 * it for non-/admin routes (middleware enforces that).
 */
export function readAccessEmail(request: Request): string | null {
  return request.headers.get("cf-access-authenticated-user-email");
}

/**
 * Sign a short HMAC token for double-opt-in / unsubscribe links.
 * Payload format: `<base64url-data>.<base64url-sig>`.
 */
export async function signToken(
  secret: string,
  payload: Record<string, string | number>,
): Promise<string> {
  const data = base64url(JSON.stringify(payload));
  const sig = await hmac(secret, data);
  return `${data}.${sig}`;
}

export async function verifyToken(
  secret: string,
  token: string,
): Promise<Record<string, string | number> | null> {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = await hmac(secret, data);
  if (!timingSafeEq(sig, expected)) return null;
  try {
    const json = JSON.parse(b64urlDecode(data));
    return json as Record<string, string | number>;
  } catch {
    return null;
  }
}

export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64url(new Uint8Array(sig));
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
