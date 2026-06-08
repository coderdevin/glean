/**
 * The public POST /api/submit endpoint answers with a 303 whose Location encodes
 * the outcome (it has no JSON branch — and we deliberately don't add one to a
 * public endpoint). This turns that Location into a typed outcome. Pure +
 * unit-tested; no network.
 */
export type SubmitOutcome =
  | { kind: "submitted"; id: string }
  | { kind: "duplicate"; id: string }
  | { kind: "published"; slug: string }
  | { kind: "error"; code: string };

export function parseSubmitLocation(location: string | null | undefined): SubmitOutcome {
  if (!location) return { kind: "error", code: "no_location" };

  let path = location;
  let query = "";
  try {
    if (/^https?:\/\//i.test(location)) {
      const u = new URL(location);
      path = u.pathname;
      query = u.search.replace(/^\?/, "");
    } else {
      const qi = location.indexOf("?");
      if (qi >= 0) {
        path = location.slice(0, qi);
        query = location.slice(qi + 1);
      }
    }
  } catch {
    return { kind: "error", code: "bad_location" };
  }

  const params = new URLSearchParams(query);

  if (path === "/submit/success") {
    const id = params.get("id") ?? "";
    if (!id) return { kind: "error", code: "no_id" };
    return params.get("dup") === "1"
      ? { kind: "duplicate", id }
      : { kind: "submitted", id };
  }
  if (path.startsWith("/a/")) {
    return { kind: "published", slug: path.slice(3) };
  }
  if (path === "/submit") {
    return { kind: "error", code: params.get("error") ?? "unknown" };
  }
  return { kind: "error", code: "unexpected_redirect" };
}

/** Map a submit error code (or rejection reason) to a readable line. */
export function submitErrorMessage(code: string): string {
  switch (code) {
    case "rate_limit":
      return "rate limited — too many submissions from this IP (10/hour). Try again later.";
    case "bad_url":
      return "the URL was rejected (must be a valid http(s) URL ≤ 2048 chars).";
    case "turnstile":
      return "CAPTCHA check failed (should not happen for JSON submissions).";
    case "honeypot":
      return "submission flagged as spam.";
    case "server":
      return "the server failed to accept the submission. Try again.";
    case "no_location":
      return "no redirect returned by the server (unexpected response).";
    case "no_id":
      return "the server accepted the link but returned no id.";
    default:
      return `submission failed (${code}).`;
  }
}
