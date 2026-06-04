/**
 * Reader reading-notes — client glue for /a/[slug].
 *
 * Responsibilities (the robust anchoring math lives in ~/lib/anchor.ts, which
 * is unit-tested; this file is the DOM layer):
 *  - capture a selection inside a section's prose column → a text-quote anchor
 *  - POST it, then paint a <mark> over the live text
 *  - re-locate + paint the reader's saved notes on load (client-side overlay so
 *    the page itself stays publicly cacheable — notes are never SSR'd)
 *  - edit/recolor/delete via a small popover
 *  - prompt inline login when an anonymous reader tries to highlight
 *
 * Bilingual: a highlight is bound to the column it was made in (zh vs en) — the
 * two columns are different translations, so notes never cross over.
 */
import { resolveAnchor, extractContext, type AnchorInput } from "~/lib/anchor";

type Color = "yellow" | "green" | "pink";

interface Note {
  id: string;
  sectionIndex: number;
  lang: "zh" | "en";
  exact: string;
  prefix: string | null;
  suffix: string | null;
  startOffset: number;
  color: Color;
  note: string | null;
}

// Single highlight color (the palette was dropped per feedback). The `color`
// field stays in the data model so any pre-existing colored notes still render.
const HL_COLOR: Color = "yellow";

const body = document.querySelector<HTMLElement>(".av2-body[data-pick-id]");
if (body) init(body);

function init(bodyEl: HTMLElement): void {
  const pickId = bodyEl.dataset.pickId!;
  let loggedIn = false;
  // A highlight the reader started before logging in — applied in-page right
  // after the OTP succeeds (no reload, so it just lives in memory).
  let pendingPayload: Omit<Note, "id"> | null = null;

  const containers = Array.from(
    bodyEl.querySelectorAll<HTMLElement>(".av2-prose[data-sec][data-lang]"),
  );

  // ---- session + initial hydration -------------------------------------
  void hydrate();

  async function hydrate(): Promise<void> {
    try {
      const res = await fetch(`/api/reader/notes?pickId=${encodeURIComponent(pickId)}`, {
        credentials: "include",
      });
      if (res.status === 401) {
        loggedIn = false;
        return;
      }
      loggedIn = true;
      const data = (await res.json()) as { notes: Note[] };
      for (const n of data.notes) paintNote(n);
      focusHashTarget();
    } catch {
      /* network hiccup — notes just won't show this load */
    }
  }

  // ---- geometry helpers -------------------------------------------------

  /** Absolute char offset of (node, offset) within container.textContent. */
  function textOffset(container: HTMLElement, node: Node, offset: number): number {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let total = 0;
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      if (cur === node) return total + offset;
      total += (cur.textContent ?? "").length;
    }
    return total;
  }

  function selectionInfo():
    | { container: HTMLElement; sec: number; lang: "zh" | "en"; start: number; end: number; exact: string }
    | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const container = containers.find(
      (c) => c.contains(range.startContainer) && c.contains(range.endContainer),
    );
    if (!container) return null;
    const start = textOffset(container, range.startContainer, range.startOffset);
    const end = textOffset(container, range.endContainer, range.endOffset);
    if (end <= start) return null;
    const exact = (container.textContent ?? "").slice(start, end);
    if (!exact.trim()) return null;
    const sec = Number(container.dataset.sec);
    const lang = container.dataset.lang;
    if (!Number.isInteger(sec) || (lang !== "zh" && lang !== "en")) return null;
    return { container, sec, lang, start, end, exact };
  }

  // ---- painting ---------------------------------------------------------

  function containerFor(sec: number, lang: string): HTMLElement | undefined {
    return containers.find((c) => Number(c.dataset.sec) === sec && c.dataset.lang === lang);
  }

  function paintNote(n: Note): void {
    const container = containerFor(n.sectionIndex, n.lang);
    if (!container) return;
    const text = container.textContent ?? "";
    const anchor: AnchorInput = {
      exact: n.exact,
      prefix: n.prefix,
      suffix: n.suffix,
      startOffset: n.startOffset,
    };
    const range = resolveAnchor(text, anchor);
    if (!range) return; // orphaned — kept in "my notes", not painted here
    wrapRange(container, range.start, range.end, n);
  }

  /** Wrap [start,end) of container.textContent in <mark> spans (one per text node). */
  function wrapRange(container: HTMLElement, start: number, end: number, n: Note): void {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let pos = 0;
    const targets: Array<{ node: Text; from: number; to: number }> = [];
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      const t = cur as Text;
      const len = (t.textContent ?? "").length;
      const nodeStart = pos;
      const nodeEnd = pos + len;
      const from = Math.max(start, nodeStart);
      const to = Math.min(end, nodeEnd);
      if (from < to) targets.push({ node: t, from: from - nodeStart, to: to - nodeStart });
      pos = nodeEnd;
      if (pos >= end) break;
    }
    for (const { node, from, to } of targets) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const mark = document.createElement("mark");
      mark.className = `rn-hl rn-hl--${n.color}`;
      mark.dataset.noteId = n.id;
      if (n.note) mark.dataset.hasNote = "1";
      mark.title = n.note ?? "";
      try {
        range.surroundContents(mark);
      } catch {
        /* range crosses element boundaries oddly — skip this fragment */
      }
    }
  }

  function repaintNote(n: Note): void {
    document.querySelectorAll<HTMLElement>(`mark.rn-hl[data-note-id="${n.id}"]`).forEach((m) => {
      m.className = `rn-hl rn-hl--${n.color}`;
      if (n.note) m.dataset.hasNote = "1";
      else delete m.dataset.hasNote;
      m.title = n.note ?? "";
    });
  }

  function unpaintNote(id: string): void {
    document.querySelectorAll<HTMLElement>(`mark.rn-hl[data-note-id="${id}"]`).forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
  }

  // ---- API --------------------------------------------------------------

  async function createNote(payload: Omit<Note, "id">): Promise<Note | null> {
    const res = await fetch("/api/reader/notes", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      // pickId is required by the API but lives outside the Note shape — without
      // it the POST 400s and the highlight silently never appears.
      body: JSON.stringify({ ...payload, pickId }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return { ...payload, id: data.id };
  }

  async function patchNote(id: string, patch: { color?: Color; note?: string | null }): Promise<boolean> {
    const res = await fetch(`/api/reader/notes/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  }

  async function deleteNote(id: string): Promise<boolean> {
    const res = await fetch(`/api/reader/notes/${id}`, { method: "DELETE", credentials: "include" });
    return res.ok;
  }

  // ---- toolbar (on selection) ------------------------------------------

  const toolbar = buildToolbar();
  document.body.appendChild(toolbar.el);

  document.addEventListener("selectionchange", () => {
    // Defer so the selection settles; hide while collapsing.
    requestAnimationFrame(() => {
      const info = selectionInfo();
      if (!info) {
        if (!toolbar.el.matches(":hover")) toolbar.hide();
        return;
      }
      const sel = window.getSelection()!;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      toolbar.showAt(rect, info);
    });
  });

  function buildToolbar() {
    const el = document.createElement("div");
    el.className = "rn-toolbar";
    el.hidden = true;
    let current: ReturnType<typeof selectionInfo> = null;

    // Core action: copy (no login needed). Kept first, like 微信读书 — more
    // actions (分享/AI) can slot in here later without restructuring.
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "rn-toolbar__btn rn-toolbar__btn--first";
    copyBtn.textContent = "复制";
    copyBtn.title = "复制所选文字";
    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Read the LIVE selection at click time, not the cached one, so copying
      // matches exactly what's highlighted even if the reader just adjusted it.
      const text = window.getSelection()?.toString() || current?.exact || "";
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
      window.getSelection()?.removeAllRanges();
      el.hidden = true;
      current = null;
    });
    el.appendChild(copyBtn);

    const hlBtn = document.createElement("button");
    hlBtn.type = "button";
    hlBtn.className = "rn-toolbar__btn";
    hlBtn.textContent = "高亮";
    hlBtn.title = "高亮所选文字";
    hlBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (current) void onHighlight(current, HL_COLOR);
    });
    el.appendChild(hlBtn);

    const noteBtn = document.createElement("button");
    noteBtn.type = "button";
    noteBtn.className = "rn-toolbar__note";
    noteBtn.textContent = "批注";
    noteBtn.title = "高亮并写批注";
    noteBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (current) void onHighlight(current, HL_COLOR, true);
    });
    el.appendChild(noteBtn);

    return {
      el,
      hide() {
        el.hidden = true;
        current = null;
      },
      showAt(rect: DOMRect, info: NonNullable<ReturnType<typeof selectionInfo>>) {
        current = info;
        el.hidden = false;
        const top = rect.top + window.scrollY - el.offsetHeight - 8;
        const left = rect.left + window.scrollX + rect.width / 2 - el.offsetWidth / 2;
        el.style.top = `${Math.max(8 + window.scrollY, top)}px`;
        el.style.left = `${Math.max(8, left)}px`;
      },
    };
  }

  async function onHighlight(
    info: NonNullable<ReturnType<typeof selectionInfo>>,
    color: Color,
    withNote = false,
  ): Promise<void> {
    toolbar.hide();
    const text = info.container.textContent ?? "";
    const { prefix, suffix } = extractContext(text, info.start, info.end);
    const payload: Omit<Note, "id"> = {
      sectionIndex: info.sec,
      lang: info.lang,
      exact: info.exact,
      prefix,
      suffix,
      startOffset: info.start,
      color,
      note: null,
    };
    window.getSelection()?.removeAllRanges();

    if (!loggedIn) {
      pendingPayload = payload;
      openLogin();
      return;
    }
    const created = await createNote(payload);
    if (!created) return;
    paintNote(created);
    if (withNote) openPopover(created);
  }

  // ---- popover (edit existing) -----------------------------------------

  document.addEventListener("click", (e) => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>("mark.rn-hl[data-note-id]");
    if (mark) {
      e.preventDefault();
      const id = mark.dataset.noteId!;
      void openPopoverById(id);
    }
  });

  async function openPopoverById(id: string): Promise<void> {
    const res = await fetch(`/api/reader/notes?pickId=${encodeURIComponent(pickId)}`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { notes: Note[] };
    const n = data.notes.find((x) => x.id === id);
    if (n) openPopover(n);
  }

  function openPopover(n: Note): void {
    closePopover();
    const mark = document.querySelector<HTMLElement>(`mark.rn-hl[data-note-id="${n.id}"]`);
    const pop = document.createElement("div");
    pop.className = "rn-popover";
    pop.dataset.popover = "1";

    const ta = document.createElement("textarea");
    ta.className = "rn-popover__text";
    ta.placeholder = "写点批注…";
    ta.value = n.note ?? "";

    const actions = document.createElement("div");
    actions.className = "rn-popover__actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "rn-popover__save";
    save.textContent = "保存";
    save.addEventListener("click", async () => {
      if (await patchNote(n.id, { note: ta.value })) {
        n.note = ta.value.trim() || null;
        repaintNote(n);
        closePopover();
      }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rn-popover__delete";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (await deleteNote(n.id)) {
        unpaintNote(n.id);
        closePopover();
      }
    });
    actions.appendChild(del);
    actions.appendChild(save);
    pop.appendChild(ta);
    pop.appendChild(actions);
    document.body.appendChild(pop);

    const rect = (mark ?? document.body).getBoundingClientRect();
    pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
    pop.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - pop.offsetWidth - 12)}px`;
    ta.focus();

    setTimeout(() => document.addEventListener("mousedown", outside), 0);
    function outside(ev: MouseEvent) {
      if (!pop.contains(ev.target as Node)) closePopover();
    }
    (pop as unknown as { _outside: typeof outside })._outside = outside;
  }

  function closePopover(): void {
    document.querySelectorAll<HTMLElement>("[data-popover]").forEach((p) => {
      const fn = (p as unknown as { _outside?: (e: MouseEvent) => void })._outside;
      if (fn) document.removeEventListener("mousedown", fn);
      p.remove();
    });
  }

  // ---- inline login (email → 6-digit code, all in-page) -----------------

  /** Called once the OTP verifies: hydrate notes + apply the pending highlight. */
  async function onLoggedIn(): Promise<void> {
    loggedIn = true;
    await hydrate();
    if (pendingPayload) {
      const created = await createNote(pendingPayload);
      pendingPayload = null;
      if (created) paintNote(created);
    }
  }

  /** Deep-link from /me/notes: #rn-<id> scrolls to and flashes that highlight. */
  function focusHashTarget(): void {
    const m = location.hash.match(/^#rn-(.+)$/);
    if (!m) return;
    const mark = document.querySelector<HTMLElement>(`mark.rn-hl[data-note-id="${m[1]}"]`);
    if (!mark) return;
    mark.scrollIntoView({ behavior: "smooth", block: "center" });
    mark.classList.add("rn-hl--flash");
    setTimeout(() => mark.classList.remove("rn-hl--flash"), 1600);
  }

  function openLogin(): void {
    closePopover();
    if (document.querySelector("[data-rn-login]")) return;
    const backdrop = document.createElement("div");
    backdrop.className = "rn-login-backdrop";
    backdrop.dataset.rnLogin = "1";
    const box = document.createElement("div");
    box.className = "rn-login";
    box.innerHTML = `
      <button type="button" class="rn-login__close" aria-label="关闭">×</button>
      <p class="rn-login__msg">登录后即可高亮、做笔记，并在各设备间同步。</p>
      <form class="rn-login__form rn-login__step" data-step="email">
        <input type="email" required placeholder="you@example.com" class="rn-login__input" autocomplete="email" />
        <button type="submit" class="rn-login__submit">发送验证码</button>
      </form>
      <form class="rn-login__form rn-login__step" data-step="code" hidden>
        <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" required placeholder="6 位验证码" class="rn-login__input rn-login__input--code" autocomplete="one-time-code" />
        <button type="submit" class="rn-login__submit">登录</button>
      </form>
      <p class="rn-login__hint" hidden></p>`;
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const emailForm = box.querySelector<HTMLFormElement>('[data-step="email"]')!;
    const codeForm = box.querySelector<HTMLFormElement>('[data-step="code"]')!;
    const emailInput = emailForm.querySelector<HTMLInputElement>("input")!;
    const codeInput = codeForm.querySelector<HTMLInputElement>("input")!;
    const hint = box.querySelector<HTMLElement>(".rn-login__hint")!;
    let challenge = "";

    const close = () => backdrop.remove();
    box.querySelector(".rn-login__close")!.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });

    emailForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      hint.hidden = true;
      const res = await fetch("/api/reader/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: emailInput.value }),
      });
      if (!res.ok) {
        hint.hidden = false;
        hint.textContent = res.status === 429
          ? "请求太频繁，请过几分钟再试。"
          : "发送失败，稍后再试。";
        return;
      }
      const data = (await res.json()) as { challenge?: string; sent?: boolean };
      hint.hidden = false;
      if (!data.sent) {
        // Email isn't configured server-side — don't pretend a code was sent.
        hint.textContent = "邮件服务暂未开启，验证码无法发送，请稍后再试或联系管理员。";
        return;
      }
      challenge = data.challenge ?? "";
      emailForm.hidden = true;
      codeForm.hidden = false;
      hint.textContent = `验证码已发到 ${emailInput.value}，输入即可登录。`;
      codeInput.focus();
    });

    let submitting = false;
    codeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitting) return; // guard against a double-submit creating dup notes
      submitting = true;
      const res = await fetch("/api/reader/verify-otp", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge, code: codeInput.value }),
      });
      if (!res.ok) {
        submitting = false; // let them retry
        hint.textContent = "验证码不对或已过期，请重试。";
        return;
      }
      close();
      await onLoggedIn();
    });
  }
}
