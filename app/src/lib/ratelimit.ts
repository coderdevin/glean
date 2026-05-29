/**
 * KV sliding-window rate limiter.
 *
 * Key shape: `rl:<bucket>:<windowStart>`. We bump the counter for the current
 * window (with an `expirationTtl` of one full window) and sum the previous
 * window weighted by how much of it the current window still overlaps. Cheap
 * and good enough for "10 per IP per hour" on /submit.
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function rateLimit(
  kv: KVNamespace,
  bucket: string,
  limit: number,
  windowSeconds: number,
  ip: string,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const prevStart = windowStart - windowSeconds;
  const elapsed = now - windowStart;
  const prevWeight = Math.max(0, 1 - elapsed / windowSeconds);

  const hashed = await hashIp(ip);
  const currKey = `rl:${bucket}:${hashed}:${windowStart}`;
  const prevKey = `rl:${bucket}:${hashed}:${prevStart}`;

  const [currStr, prevStr] = await Promise.all([kv.get(currKey), kv.get(prevKey)]);
  const curr = Number(currStr ?? 0);
  const prev = Number(prevStr ?? 0);
  const estimate = Math.floor(prev * prevWeight) + curr;

  if (estimate >= limit) {
    return {
      ok: false,
      remaining: 0,
      resetSeconds: windowSeconds - elapsed,
    };
  }

  await kv.put(currKey, String(curr + 1), { expirationTtl: windowSeconds * 2 });
  return {
    ok: true,
    remaining: limit - estimate - 1,
    resetSeconds: windowSeconds - elapsed,
  };
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`glean:${ip}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export async function ipHash(ip: string): Promise<string> {
  return hashIp(ip);
}
