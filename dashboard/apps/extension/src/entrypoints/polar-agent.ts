/**
 * Polar's hands inside one tab it opened: injected by the worker
 * (`lib/polar-browser.ts`) into that tab only, never registered on any site.
 *
 * It answers the worker and nobody else - a message from a page or another
 * content script carries a tab, the worker's does not - and it draws the bar
 * that says Polar is using this tab, with the Stop button that ends it. The
 * work itself is `lib/page-agent.ts`.
 *
 * Callback-form listener (`sendResponse` + `return true`): a promise returned
 * from `onMessage` is dropped by Chrome (see the WXT note in the repository).
 */

import * as agent from "@/lib/page-agent";
import type { AgentOp, AgentReply } from "@/lib/polar-browser-ops";

const MARK = "__polarisPolarAgent";

export default defineUnlistedScript({
    main() {
        const scope = globalThis as unknown as Record<string, boolean | undefined>;
        if (window.top !== window || scope[MARK]) return;
        scope[MARK] = true;
        const refs = new agent.RefTable();
        let bar: HTMLElement | null = null;

        const showBar = (text: string, stop: string) => {
            if (bar?.isConnected) return;
            bar = document.createElement("div");
            bar.style.cssText = "all:initial";
            const shadow = bar.attachShadow({ mode: "closed" });
            const box = document.createElement("div");
            box.style.cssText =
                "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;align-items:center;max-width:calc(100vw - 32px);padding:6px 8px 6px 12px;border-radius:999px;background:#4c1d95;color:#fff;font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
            const label = document.createElement("span");
            label.textContent = text;
            label.style.cssText =
                "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = stop;
            button.style.cssText =
                "flex-shrink:0;border:0;border-radius:999px;padding:4px 10px;background:#fff;color:#4c1d95;font:600 12px system-ui,sans-serif;cursor:pointer";
            button.addEventListener("click", (event) => {
                if (!event.isTrusted) return;
                void browser.runtime
                    .sendMessage({ kind: "polarBrowserStop" })
                    .catch(() => undefined);
                bar?.remove();
            });
            box.append(label, button);
            shadow.append(box);
            document.documentElement.append(bar);
        };

        const run = (op: AgentOp): AgentReply => {
            switch (op.op) {
                case "banner":
                    showBar(op.text, op.stop);
                    return { ok: true };
                case "unbanner":
                    bar?.remove();
                    bar = null;
                    return { ok: true };
                case "snapshot":
                    return { ok: true, elements: agent.snapshot(document, refs, op.query) };
                case "read": {
                    const read = agent.readText(document, op.selector);
                    if (!read)
                        return {
                            ok: false,
                            refusal: "failed",
                            detail: "nothing matches that selector"
                        };
                    return { ok: true, ...read };
                }
                case "click":
                    return agent.clickRef(refs, op.ref);
                case "type":
                    return agent.typeRef(refs, op.ref, op.text, op.submit);
            }
        };

        browser.runtime.onMessage.addListener((raw, sender, sendResponse): boolean => {
            if (sender.id !== browser.runtime.id || sender.tab) return false;
            const message = raw as { polarAgent?: AgentOp } | null;
            if (!message?.polarAgent) return false;
            try {
                sendResponse({
                    ...run(message.polarAgent),
                    title: document.title,
                    url: location.href
                });
            } catch {
                sendResponse({ ok: false, refusal: "failed" });
            }
            return true;
        });
    }
});
