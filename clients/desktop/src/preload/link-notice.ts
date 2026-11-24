/**
 * A link no route could open, said inside the window (BUG-0020).
 *
 * The main process used to answer with the system's own alert box, which
 * stops everything until it is dismissed. This is drawn in the page instead: a
 * small card in a corner with the address, Copy link and Close, which leaves
 * the page usable and goes away on its own. It lives in a shadow root, so the
 * page's styles neither reach it nor are reached by it.
 */

/** What the main process sends (`open-external.ts`, `linkNotice`). */
export interface LinkNoticeWords {
    readonly url: string;
    readonly title: string;
    readonly body: string;
}

/** How long the card stays when nobody touches it. */
export const NOTICE_MS = 15_000;

/** The words, when they are what the main process sends; null otherwise. */
export function readLinkNotice(raw: unknown): LinkNoticeWords | null {
    if (typeof raw !== "object" || raw === null) return null;
    const { url, title, body } = raw as Record<string, unknown>;
    if (typeof url !== "string" || typeof title !== "string" || typeof body !== "string") return null;
    if (!/^(?:https?|mailto):/i.test(url) || url.length > 64 * 1024 || title.length > 200 || body.length > 500) return null;
    return { url, title, body };
}

const STYLE = `
:host { all: initial; }
.card {
    --bg: #ffffff; --fg: #14161a; --muted: #5b6270; --line: #dcdfe5; --button: #eef0f3;
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    box-sizing: border-box; width: min(380px, calc(100vw - 32px));
    padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--bg); color: var(--fg); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; gap: 6px;
}
@media (prefers-color-scheme: dark) {
    .card { --bg: #17191e; --fg: #eceef2; --muted: #9aa1ad; --line: #2c3038; --button: #252930; }
}
.title { font-weight: 600; }
.body { color: var(--muted); }
.url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
button { font: inherit; color: var(--fg); background: var(--button); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:focus-visible { outline: 2px solid #4c8dff; outline-offset: 1px; }
`;

let current: HTMLElement | null = null;

/** Draw the card, replacing one already shown. `copy` writes the address to
 *  the clipboard and answers whether it did. */
export function showLinkNotice(words: LinkNoticeWords, copy: (text: string) => Promise<boolean>): void {
    if (typeof document === "undefined" || !document.body) return;
    current?.remove();
    const host = document.createElement("polaris-link-notice");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");
    const line = (className: string, text: string) => {
        const element = document.createElement("div");
        element.className = className;
        element.textContent = text;
        return element;
    };
    const url = line("url", words.url);
    url.title = words.url;
    const actions = document.createElement("div");
    actions.className = "actions";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy link";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    actions.append(copyButton, closeButton);
    card.append(line("title", words.title), line("body", words.body), url, actions);
    root.append(style, card);

    let timer = setTimeout(() => close(), NOTICE_MS);
    const close = () => {
        clearTimeout(timer);
        host.remove();
        if (current === host) current = null;
    };
    // Kept while the pointer or the keyboard is on it.
    card.addEventListener("pointerenter", () => clearTimeout(timer));
    card.addEventListener("focusin", () => clearTimeout(timer));
    card.addEventListener("pointerleave", () => {
        clearTimeout(timer);
        timer = setTimeout(() => close(), NOTICE_MS);
    });
    closeButton.addEventListener("click", close);
    copyButton.addEventListener("click", () => {
        void copy(words.url).then((done) => {
            copyButton.textContent = done ? "Copied" : "Couldn't copy";
        });
    });
    document.body.append(host);
    current = host;
}
