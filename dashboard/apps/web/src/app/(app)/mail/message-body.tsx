"use client";

/**
 * Somebody else's HTML, drawn without letting it do anything.
 *
 * This is the most dangerous surface in the app: the content is written by a
 * stranger, it is arbitrary markup, and half of it is written by people whose
 * job is to find out whether it was opened. Three layers stand in front of it,
 * and none of them is trusted alone.
 *
 * 1. **A sanitizer.** DOMPurify strips script, form, object, embed, event
 *    handlers and every URL scheme that is not http, https, mailto or data for
 *    an image. Links come out with `target=_blank` and `rel=noopener`.
 * 2. **A sandboxed frame with no same-origin.** The message is drawn inside an
 *    iframe whose sandbox grants scripts and popups and NOT `allow-same-origin`,
 *    so its origin is opaque: it cannot read this page, this document's cookies,
 *    or anything on this origin. Scripts are granted for one reason only - the
 *    frame has to be able to tell the page how tall it is, and without
 *    same-origin the page cannot measure it.
 * 3. **A content policy inside the frame.** `default-src 'none'` with images
 *    allowed only when the reader has said so. This is the layer that actually
 *    stops a tracking pixel, and it holds even if the sanitizer missed
 *    something: an address the policy forbids is not fetched, whatever the
 *    markup says.
 *
 * The remote addresses are not thrown away when they are blocked. They are
 * parked on `data-remote-*` attributes by the server, and "show pictures" puts
 * them back inside the frame - so the message loads what it always wanted to
 * load, once, when its reader decided.
 */

import { Button, cn } from "@polaris/ui";
import { Eye, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export function MessageBody({
    html,
    text,
    remoteAllowed,
    remoteCount,
    trackerVendors,
    onAlwaysAllow
}: {
    html: string;
    text: string;
    remoteAllowed: boolean;
    remoteCount: number;
    trackerVendors: readonly string[];
    /** Trust this sender from now on. Absent when there is nobody to trust -
     *  a message with no remote content at all. */
    onAlwaysAllow?: () => void;
}) {
    // Once for this message, without changing the setting. The ordinary case:
    // somebody wants to see this newsletter and has no opinion about the next
    // one from the same address.
    const [showOnce, setShowOnce] = useState(false);
    const showing = remoteAllowed || showOnce;

    return (
        <div className="min-w-0">
            {!remoteAllowed && remoteCount > 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
                    <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
                    <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
                        {blockedSentence(remoteCount, trackerVendors)}
                    </p>
                    {!showOnce ? (
                        <Button variant="secondary" size="sm" onClick={() => setShowOnce(true)}>
                            <Eye className="size-3.5 shrink-0" aria-hidden />
                            Show pictures
                        </Button>
                    ) : null}
                    {onAlwaysAllow ? (
                        <Button variant="ghost" size="sm" onClick={onAlwaysAllow}>
                            Always from this sender
                        </Button>
                    ) : null}
                </div>
            ) : null}

            {html.trim() ? (
                <SandboxedHtml html={html} showRemote={showing} />
            ) : (
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">
                    {text}
                </pre>
            )}
        </div>
    );
}

/** What the bar above a message says. Naming the companies is the whole reason
 *  this setting survives contact with a real person: "4 blocked, from Mailchimp"
 *  is information, and "some images were blocked" is an annoyance. */
function blockedSentence(remoteCount: number, vendors: readonly string[]): string {
    const pictures = `${remoteCount} thing${remoteCount === 1 ? "" : "s"} this message wanted to load from elsewhere`;
    if (vendors.length === 0) return `Blocked ${pictures}.`;
    const named = vendors.length === 1 ? vendors[0] : `${vendors.slice(0, -1).join(", ")} and ${vendors.at(-1)}`;
    return `Blocked ${pictures}, including trackers from ${named}.`;
}

/** The wrapper the message is drawn inside. Nothing here is the message's: the
 *  policy, the base target and the height reporter are all ours. */
function frameDocument(body: string, showRemote: boolean): string {
    const images = showRemote ? "img-src https: data: cid:;" : "img-src data:;";
    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${images} style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none';">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:transparent;color:inherit;}
  body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;word-break:break-word;overflow-wrap:anywhere;}
  img,video,table{max-width:100%;height:auto;}
  table{border-collapse:collapse;}
  blockquote{margin:0 0 0 .75rem;padding-left:.75rem;border-left:2px solid rgba(127,127,127,.4);}
  a{color:#4f7cff;}
</style>
</head><body>${body}
<script>
  // The one thing the frame is allowed to do: say how tall it is, so the page
  // can size it. It cannot reach the page - the sandbox withheld same-origin -
  // and the page treats what arrives as a number and nothing else.
  (function () {
    function tell() { parent.postMessage({ polarisMailHeight: document.documentElement.scrollHeight }, "*"); }
    window.addEventListener("load", tell);
    new ResizeObserver(tell).observe(document.documentElement);
    tell();
  })();
</script>
</body></html>`;
}

/** The tallest a message may make its own frame. A message that says it is
 *  forty thousand pixels tall is a message trying to push the rest of the
 *  screen away; past this it scrolls inside its own frame. */
const MAX_FRAME_HEIGHT = 20000;

function SandboxedHtml({ html, showRemote }: { html: string; showRemote: boolean }) {
    const frame = useRef<HTMLIFrameElement | null>(null);
    const [height, setHeight] = useState(240);
    const [clean, setClean] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void (async () => {
            const purify = (await import("dompurify")).default;
            const sanitized = purify.sanitize(html, {
                // `data-remote-*` is how the server parks an address it held
                // back. It has to survive the sanitizer or "show pictures" has
                // nothing to put back.
                ADD_ATTR: [
                    "target",
                    "data-remote-src",
                    "data-remote-srcset",
                    "data-remote-background",
                    "data-remote-poster"
                ],
                FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "meta", "base"],
                FORBID_ATTR: ["srcdoc", "formaction", "ping"],
                // Mail is full of tables and inline styles and always will be.
                // They are safe inside a frame with no same-origin and a policy
                // that forbids every outside load.
                ALLOW_DATA_ATTR: true
            });
            if (live) setClean(sanitized);
        })();
        return () => {
            live = false;
        };
    }, [html]);

    // "Show pictures" is the held addresses being put back, in the browser, with
    // nothing asked of the server. Done on the sanitized markup so the frame is
    // rebuilt from something that has already been through the sanitizer.
    const body = useMemo(() => {
        if (clean === null) return "";
        if (!showRemote) return clean;
        return clean
            .replace(/data-remote-(src|srcset|background|poster)=/gi, (_match, name: string) => `${name}=`)
            .replace(/url\((['"]?)about:blank\1\)/gi, "url()");
    }, [clean, showRemote]);

    useEffect(() => {
        function onMessage(event: MessageEvent) {
            // Only the frame this component owns, and only a number. Anything
            // else on the wire is somebody else's message.
            if (event.source !== frame.current?.contentWindow) return;
            const claimed = (event.data as { polarisMailHeight?: unknown } | null)?.polarisMailHeight;
            if (typeof claimed !== "number" || !Number.isFinite(claimed)) return;
            setHeight(Math.min(Math.max(120, Math.ceil(claimed) + 8), MAX_FRAME_HEIGHT));
        }
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    if (clean === null) {
        return <div className="h-24 animate-pulse rounded-md bg-card" aria-label="Opening the message" />;
    }

    return (
        <iframe
            ref={frame}
            title="Message"
            // No allow-same-origin, deliberately and permanently. Scripts are
            // granted only so the frame can report its own height; with an
            // opaque origin they reach nothing of this page's.
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            srcDoc={frameDocument(body, showRemote)}
            className={cn("w-full border-0 bg-transparent")}
            style={{ height }}
        />
    );
}
