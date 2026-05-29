/**
 * Transactional email via Resend (https://resend.com).
 *
 * One provider, two entry points: `sendEmail` for single messages (the
 * double-opt-in confirmation) and `sendEmailBatch` for the weekly blast
 * (Resend's /emails/batch accepts up to 100 personalized messages per call,
 * which keeps us well under the Worker subrequest cap).
 *
 * When `RESEND_API_KEY` is unset the functions log to the console and report
 * success — local dev works without a real key, mirroring the Turnstile bypass.
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe for the weekly blast. */
  headers?: Record<string, string>;
}

export interface SendResult {
  to: string;
  ok: boolean;
  id?: string;
  error?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_BATCH_ENDPOINT = "https://api.resend.com/emails/batch";
/** Resend caps a batch request at 100 messages. */
export const EMAIL_BATCH_SIZE = 100;

/** True when a real provider key is configured. */
export function emailEnabled(env: EmailEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

function fromAddress(env: EmailEnv): string {
  return env.EMAIL_FROM || "Glean <onboarding@resend.dev>";
}

function toResendPayload(env: EmailEnv, m: EmailMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: fromAddress(env),
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
  };
  if (env.EMAIL_REPLY_TO) payload.reply_to = env.EMAIL_REPLY_TO;
  if (m.headers) payload.headers = m.headers;
  return payload;
}

/** Send a single message. Never throws — failures come back in `SendResult`. */
export async function sendEmail(env: EmailEnv, m: EmailMessage): Promise<SendResult> {
  if (!emailEnabled(env)) {
    console.log(`[email:dev] would send to ${m.to} — "${m.subject}"`);
    return { to: m.to, ok: true, id: "dev-noop" };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(toResendPayload(env, m)),
    });
    if (!res.ok) {
      return { to: m.to, ok: false, error: `resend ${res.status}: ${await res.text()}` };
    }
    const data = (await res.json()) as { id?: string };
    return { to: m.to, ok: true, id: data.id };
  } catch (err) {
    return { to: m.to, ok: false, error: String(err) };
  }
}

/**
 * Send one chunk (≤ EMAIL_BATCH_SIZE) of personalized messages. Resend's batch
 * endpoint returns one id per message in order; a transport-level failure marks
 * the whole chunk failed (the caller records each recipient accordingly).
 */
async function sendChunk(env: EmailEnv, chunk: EmailMessage[]): Promise<SendResult[]> {
  if (!emailEnabled(env)) {
    for (const m of chunk) console.log(`[email:dev] would send to ${m.to} — "${m.subject}"`);
    return chunk.map((m) => ({ to: m.to, ok: true, id: "dev-noop" }));
  }
  try {
    const res = await fetch(RESEND_BATCH_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(chunk.map((m) => toResendPayload(env, m))),
    });
    if (!res.ok) {
      const error = `resend ${res.status}: ${await res.text()}`;
      return chunk.map((m) => ({ to: m.to, ok: false, error }));
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    return chunk.map((m, i) => ({ to: m.to, ok: true, id: data.data?.[i]?.id }));
  } catch (err) {
    const error = String(err);
    return chunk.map((m) => ({ to: m.to, ok: false, error }));
  }
}

/** Send many messages, chunked into Resend batch calls. Never throws. */
export async function sendEmailBatch(env: EmailEnv, messages: EmailMessage[]): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (let i = 0; i < messages.length; i += EMAIL_BATCH_SIZE) {
    const chunk = messages.slice(i, i + EMAIL_BATCH_SIZE);
    results.push(...(await sendChunk(env, chunk)));
  }
  return results;
}
