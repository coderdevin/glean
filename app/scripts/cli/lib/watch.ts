/**
 * Poll a submission until the AI pipeline reaches a resting state.
 *
 * Note: the web `isTerminal` is only published|rejected (the success page keeps
 * polling `ready`/`failed` because an editor may still act). For a CLI watch the
 * submitter cares about the AI finishing, so we rest on ready|published|rejected|failed.
 */
import type { Config } from "./config";
import { getStatus, type StatusView } from "./api";
import { renderStatus } from "./render";

const REST = new Set(["ready", "published", "rejected", "failed"]);
const POLL_MS = 3000;
const MAX_POLLS = 80; // ~4 min cap so a stuck pipeline doesn't hang the terminal
const MAX_CONSECUTIVE_ERRORS = 5; // tolerate transient 5xx hiccups before giving up

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function watchStatus(config: Config, id: string, json: boolean): Promise<number> {
  let last = "";
  let consecutiveErrors = 0;
  for (let i = 0; i < MAX_POLLS; i++) {
    let v: StatusView;
    try {
      v = await getStatus(config, id);
      consecutiveErrors = 0;
    } catch (err) {
      // The status endpoint can intermittently fail (transient 5xx). Don't let a
      // single hiccup abort a watch that's otherwise progressing — keep polling
      // and only give up after a sustained run of failures.
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) throw err;
      await sleep(POLL_MS);
      continue;
    }
    if (json) {
      console.log(JSON.stringify({ id, ...v }));
    } else if (v.status !== last) {
      console.log(renderStatus(id, v));
      console.log("");
      last = v.status;
    }
    if (REST.has(v.status)) {
      return v.status === "rejected" || v.status === "failed" ? 5 : 0;
    }
    await sleep(POLL_MS);
  }
  if (!json) console.log("still processing — check again later with: glean status " + id);
  return 0;
}
