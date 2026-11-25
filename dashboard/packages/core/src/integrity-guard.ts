// The one module of this package that runs in a page, not in Node.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * The page half of the code check (docs/integrity.md), shared by the browser
 * extension's page script and the desktop app's preload: which files of code a
 * page loaded, their digests, and - when the checker says the page was changed -
 * the warning over it and the password fields that stop taking keystrokes.
 *
 * Drawn in a closed shadow root with its own styles, so the page under it can
 * neither restyle nor read the warning.
 */

import { checkedPath, servedPath, sriDigest, type CheckedFile } from "./integrity-paths";
import type { IntegrityVerdict, PageVerdict } from "./integrity";

/** The warning's words, in the reader's language. */
export interface IntegrityWords {
    readonly title: string;
    readonly body: string;
    readonly files: string;
    readonly dismiss: string;
}

/** The words of the notice over a page of an earlier build. */
export interface OutdatedWords {
    readonly body: string;
    readonly reload: string;
    readonly later: string;
}

/** What the checker answered for files a page sent, with the words to show it in. */
export interface GuardReply {
    readonly verdict: PageVerdict;
    readonly words: IntegrityWords;
    readonly outdated: OutdatedWords;
}

const WARNING_ID = "polaris-integrity-warning";
const OUTDATED_ID = "polaris-integrity-outdated";
/** The tag the web app's root layout puts the build that served the document in. */
const BUILD_META = 'meta[name="polaris-build"]';
let blocked = false;

/** The build this document says it was served by, or null when it names none. */
export function documentBuild(): string | null {
    const value = document.querySelector<HTMLMetaElement>(BUILD_META)?.content ?? "";
    return /^[0-9a-f]{16}$/.test(value) ? value : null;
}

/**
 * Check the page's code now and each time it loads more. Every check names the
 * build the page belongs to - the one the document says served it, else the
 * one its first check was judged against - so a chunk an old page loads after
 * the server was updated is judged against that page's own build, never against
 * the newer build the server runs by then (docs/bugs/BUG-0039).
 */
export function watchPageCode(ask: (files: CheckedFile[], build: string | null) => Promise<GuardReply | null>): void {
    const sent = new Set<string>();
    let build = documentBuild();
    const check = async (): Promise<void> => {
        const paths = loadedPaths(sent);
        if (paths.length === 0) return;
        for (const path of paths) sent.add(path);
        const reply = await ask(await hashPaths(paths), build).catch(() => null);
        if (!reply) return;
        const verdict = reply.verdict;
        if (verdict.kind !== "unverifiable") build ??= verdict.build;
        if (verdict.kind === "changed") warnChanged(verdict, reply.words);
        else if (verdict.kind === "outdated") offerReload(reply.outdated);
    };
    void check();
    onNewFiles(() => void check());
}

/** The paths of the files of code the page loaded from its own origin, minus `skip`. */
export function loadedPaths(skip: ReadonlySet<string> = new Set()): string[] {
    const origin = location.origin;
    const urls = [
        ...performance.getEntriesByType("resource").map((entry) => entry.name),
        ...Array.from(document.scripts, (script) => script.src),
        ...Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet], link[rel=modulepreload]"), (link) => link.href)
    ];
    const paths = new Set<string>();
    for (const url of urls) {
        if (!url) continue;
        const path = checkedPath(url, origin);
        if (path && !skip.has(path)) paths.add(path);
    }
    return [...paths];
}

/**
 * The digest of a file, fetched again from the page's own origin and from the
 * browser's cache where it allows. Empty when it cannot be hashed here (no
 * WebCrypto on plain http, a failed fetch): the caller hashes it elsewhere.
 */
export async function hashPath(path: string): Promise<string> {
    if (!globalThis.crypto?.subtle) return "";
    try {
        const response = await fetch(servedPath(path), { cache: "force-cache", credentials: "same-origin" });
        return response.ok ? await sriDigest(await response.arrayBuffer()) : "";
    } catch {
        return "";
    }
}

export async function hashPaths(paths: readonly string[]): Promise<CheckedFile[]> {
    return Promise.all(paths.map(async (path) => ({ path, digest: await hashPath(path) })));
}

/** Call `run` once the page has loaded more files and gone quiet. */
export function onNewFiles(run: () => void, settleMs = 400): void {
    let pending: ReturnType<typeof setTimeout> | null = null;
    try {
        new PerformanceObserver(() => {
            if (pending) clearTimeout(pending);
            pending = setTimeout(run, settleMs);
        }).observe({ type: "resource", buffered: false });
    } catch {
        // No observer: the first check stands for the page.
    }
}

/** Cover the page with the warning and lock its password fields. */
export function warnChanged(verdict: Extract<IntegrityVerdict, { kind: "changed" }>, words: IntegrityWords): void {
    blockPasswords();
    document.getElementById(WARNING_ID)?.remove();
    document.getElementById(OUTDATED_ID)?.remove();
    const host = document.createElement("div");
    host.id = WARNING_ID;
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    const backdrop = document.createElement("div");
    backdrop.style.cssText = `
        position: absolute; inset: 0; display: grid; place-items: center; padding: 16px;
        background: rgb(0 0 0 / 0.6);
    `;
    const panel = document.createElement("div");
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "title");
    panel.style.cssText = `
        box-sizing: border-box; width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto;
        border: 1px solid hsl(0 70% 45%); border-radius: 10px; padding: 16px;
        background: hsl(225 11% 9%); color: hsl(220 14% 96%);
        font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
        display: flex; flex-direction: column; gap: 8px;
    `;
    const title = document.createElement("p");
    title.id = "title";
    title.style.cssText = "margin:0;font-weight:600;font-size:15px;color:hsl(0 85% 70%);";
    title.textContent = words.title;
    const body = document.createElement("p");
    body.style.cssText = "margin:0;";
    body.textContent = words.body;
    const files = document.createElement("p");
    files.style.cssText = "margin:0;color:hsl(222 10% 66%);word-break:break-all;";
    files.textContent = `${words.files} ${verdict.paths.slice(0, 5).join(", ")}${verdict.paths.length > 5 ? ", ..." : ""}`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = words.dismiss;
    dismiss.style.cssText = `
        align-self: flex-end; border: 1px solid hsl(225 10% 22%); border-radius: 8px; padding: 6px 12px;
        background: hsl(225 11% 13%); color: inherit; font: inherit; cursor: pointer;
    `;
    // Seen, not cleared: the page stays one whose password fields take nothing.
    dismiss.addEventListener("click", () => host.remove());
    panel.append(title, body, files, dismiss);
    backdrop.append(panel);
    shadow.append(backdrop);
    document.documentElement.append(host);
    dismiss.focus();
}

/**
 * A quiet notice that the page is genuine code of an earlier build. Never a
 * reload of its own: this cannot see a form being filled in, and the page's own
 * update prompt reloads when nothing would be lost. Shown once per page.
 */
export function offerReload(words: OutdatedWords): void {
    if (document.getElementById(OUTDATED_ID) || document.getElementById(WARNING_ID)) return;
    const host = document.createElement("div");
    host.id = OUTDATED_ID;
    host.style.cssText = "position:fixed;right:16px;bottom:16px;left:16px;z-index:2147483646;display:flex;justify-content:flex-end;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const panel = document.createElement("div");
    panel.setAttribute("role", "status");
    panel.style.cssText = `
        box-sizing: border-box; width: min(380px, 100%); pointer-events: auto;
        border: 1px solid hsl(225 10% 22%); border-radius: 10px; padding: 12px;
        background: hsl(225 11% 9%); color: hsl(220 14% 96%);
        font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
        display: flex; flex-direction: column; gap: 8px;
    `;
    const body = document.createElement("p");
    body.style.cssText = "margin:0;";
    body.textContent = words.body;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;";
    const button = (label: string, run: () => void): HTMLButtonElement => {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = label;
        element.style.cssText = `
            border: 1px solid hsl(225 10% 22%); border-radius: 8px; padding: 6px 12px;
            background: hsl(225 11% 13%); color: inherit; font: inherit; cursor: pointer;
        `;
        element.addEventListener("click", run);
        return element;
    };
    actions.append(button(words.later, () => host.remove()), button(words.reload, () => location.reload()));
    panel.append(body, actions);
    shadow.append(panel);
    document.documentElement.append(host);
}

/** Whether a field takes a secret: a password, or one marked as a key. */
export function isSecretField(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLInputElement &&
        (target.type === "password" ||
            /\b(current|new)-password\b/.test(target.autocomplete) ||
            target.hasAttribute("data-polaris-secret"))
    );
}

/**
 * Stop the page's password and key fields taking anything. Capturing on the
 * window from the first moment this knows, so the page's own listeners added
 * after it never see the keystroke; ones the page added before cannot be
 * reached, which docs/integrity.md says plainly.
 */
export function blockPasswords(): void {
    if (blocked) return;
    blocked = true;
    const refuse = (event: Event): void => {
        if (!isSecretField(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    for (const type of ["keydown", "keypress", "beforeinput", "input", "paste", "drop"]) {
        window.addEventListener(type, refuse, true);
    }
    const lock = (): void => {
        for (const field of document.querySelectorAll<HTMLInputElement>("input")) {
            if (!isSecretField(field)) continue;
            // Only when it changes anything: a write the observer below sees is
            // another pass, and an unconditional one would never settle.
            if (!field.readOnly) field.readOnly = true;
            if (field.value !== "") field.value = "";
        }
    };
    lock();
    new MutationObserver(lock).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["type", "autocomplete", "data-polaris-secret"]
    });
}
