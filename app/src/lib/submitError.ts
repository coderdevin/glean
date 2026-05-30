/**
 * Build the `/submit` error-redirect URL, preserving what the visitor typed.
 *
 * The submit API answers every rejection with a 303 → GET /submit, which
 * re-renders a fresh form. Without echoing the input back, the URL and note
 * the visitor entered are lost and they have to retype everything (especially
 * painful on the turnstile path, where a re-verify is already required).
 *
 * We round-trip `url` and `note` through query params so submit.astro can
 * prefill them. Values are length-capped to match the form's own limits and
 * to keep the redirect URL bounded.
 */

const MAX_URL = 2048; // matches Body.url .max(2048)
const MAX_NOTE = 500; // matches the note textarea maxlength / Body.note .max(500)

export interface SubmitErrorFields {
  url?: string | null;
  note?: string | null;
}

export function buildSubmitError(error: string, fields?: SubmitErrorFields): string {
  const params = new URLSearchParams({ error });
  const url = fields?.url?.trim();
  if (url) params.set("url", url.slice(0, MAX_URL));
  const note = fields?.note?.trim();
  if (note) params.set("note", note.slice(0, MAX_NOTE));
  return `/submit?${params.toString()}`;
}
