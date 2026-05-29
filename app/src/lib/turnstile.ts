/**
 * Cloudflare Turnstile server-side verification.
 *
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Returns true if the token is valid for the given IP. Logs (to console) but
 * never throws — caller decides how to react.
 */

const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  secret: string,
  token: string | null | undefined,
  ip: string | null,
): Promise<boolean> {
  if (!token) return false;
  // Test sitekey + secret pair always succeeds — handy for local dev.
  if (secret === "1x0000000000000000000000000000000AA") return true;

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);

  try {
    const res = await fetch(TURNSTILE_VERIFY, { method: "POST", body });
    const json = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    if (!json.success) {
      console.warn("turnstile fail", json["error-codes"]);
    }
    return Boolean(json.success);
  } catch (err) {
    console.error("turnstile verify error", err);
    return false;
  }
}
