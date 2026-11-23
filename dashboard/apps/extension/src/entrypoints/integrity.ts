/**
 * The page half of the code check (docs/integrity.md), on the pages of the
 * Polaris servers somebody added - registered there by the worker
 * (`syncIntegrity` in background.ts), nowhere else.
 *
 * It hashes the files of code the page loaded from its own origin - and every
 * one it loads later, since a page fetches its chunks as it is used - and the
 * worker compares them with the signed manifest of the server's build. When
 * they differ the page is covered with a warning and its password fields stop
 * taking keystrokes, because a changed page is exactly the one that would read a
 * password as it is typed.
 *
 * Hashed here rather than in the worker where the page's context allows it: a
 * fetch from the page's origin can be answered from the same cache the page
 * was. A page served over plain http has no WebCrypto, and there the worker
 * fetches and hashes instead.
 */

import { INTEGRITY_CHECK, type IntegrityReply } from "@/lib/integrity-messages";
import { checkedPath, sriDigest, type IntegrityVerdict } from "@polaris/core/integrity";

/** Files already sent, so a later chunk is sent once. */
const sent = new Set<string>();
let blocked = false;
let pending: ReturnType<typeof setTimeout> | null = null;
const SETTLE_MS = 400;

export default defineUnlistedScript({
    main() {
        if (window.top !== window) return;
        void check();
        try {
            new PerformanceObserver(() => {
                if (pending) clearTimeout(pending);
                pending = setTimeout(() => void check(), SETTLE_MS);
            }).observe({ type: "resource", buffered: false });
        } catch {
            // No observer: the first check stands for the page.
        }
    }
});

function loadedPaths(): string[] {
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
        if (path && !sent.has(path)) paths.add(path);
    }
    return [...paths];
}

async function hash(path: string): Promise<string> {
    if (!globalThis.crypto?.subtle) return "";
    try {
        const response = await fetch(path, { cache: "force-cache", credentials: "same-origin" });
        return response.ok ? await sriDigest(await response.arrayBuffer()) : "";
    } catch {
        return "";
    }
}

async function check(): Promise<void> {
    const paths = loadedPaths();
    if (paths.length === 0) return;
    for (const path of paths) sent.add(path);
    const files = await Promise.all(paths.map(async (path) => ({ path, digest: await hash(path) })));
    let reply: IntegrityReply | undefined;
    try {
        reply = (await browser.runtime.sendMessage({ kind: INTEGRITY_CHECK, files })) as IntegrityReply | undefined;
    } catch {
        return;
    }
    if (reply?.ok && reply.verdict.kind === "changed") warn(reply.verdict, reply.words);
}

function warn(verdict: Extract<IntegrityVerdict, { kind: "changed" }>, words: Extract<IntegrityReply, { ok: true }>["words"]): void {
    blockPasswords();
    document.getElementById("polaris-integrity-warning")?.remove();
    const host = document.createElement("div");
    host.id = "polaris-integrity-warning";
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

function isPassword(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLInputElement &&
        (target.type === "password" || /\b(current|new)-password\b/.test(target.autocomplete))
    );
}

/**
 * Stop the page's password fields taking anything. Capturing on the window and
 * from the first moment this knows, so the page's own listeners added after it
 * never see the keystroke; ones the page added before cannot be reached, which
 * docs/integrity.md says plainly.
 */
function blockPasswords(): void {
    if (blocked) return;
    blocked = true;
    const refuse = (event: Event): void => {
        if (!isPassword(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    for (const type of ["keydown", "keypress", "beforeinput", "input", "paste", "drop"]) {
        window.addEventListener(type, refuse, true);
    }
    const lock = (): void => {
        for (const field of document.querySelectorAll<HTMLInputElement>("input")) {
            if (!isPassword(field)) continue;
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
        attributeFilter: ["type", "autocomplete"]
    });
}
