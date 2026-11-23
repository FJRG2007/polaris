/**
 * The page side of the links harness: the dashboard's real mail frame with a
 * typical email button in it, and the branch of `MessageBody` that opens what
 * the frame posts (`message-body.tsx`, the `polarisMailOpen` handler).
 */

import { framedOpenHref, openLink } from "../../../../dashboard/apps/web/src/lib/open-link";
import { frameDocument } from "../../../../dashboard/apps/web/src/app/(app)/mail/frame-document";

const body = `<table><tr><td style="background:#1a56db;border-radius:6px"><a href="https://example.com/track?id=42" target="_blank" style="display:inline-block;padding:20px 40px;color:#fff">View order</a></td></tr></table>`;
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
frame.style.cssText = "border:0;width:500px;height:300px;position:absolute;left:0;top:0";
frame.srcdoc = frameDocument(body, false, "reader", window.location.origin);
document.body.appendChild(frame);
window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const opened = (event.data as { polarisMailOpen?: unknown; } | null)?.polarisMailOpen;
    if (opened === undefined) return;
    const href = framedOpenHref(opened);
    if (href) openLink(href);
});
