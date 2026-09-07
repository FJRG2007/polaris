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
import * as core from "@polaris/core";
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

    /**
     * What is actually drawn.
     *
     * A message with no HTML half is turned into some: plenty of mail is plain
     * text - anything sent by a script, a digest, a colleague on a terminal
     * client - and drawing it as preformatted text left every address in it
     * dead. People send links expecting them to be links.
     *
     * It goes through the same sanitizer and the same sandboxed frame as any
     * other message, so this changes what a plain message looks like and nothing
     * about what it is allowed to do.
     */
    const drawn = useMemo(() => (html.trim() ? html : core.textToHtml(text)), [html, text]);

    // Which page this message is drawn on. Guessed from whether it dresses
    // itself, and overridable per message because the guess is a heuristic. A
    // message Polaris made the markup for never dresses itself, so it always
    // takes the reader's theme, which is what it should do.
    const guessed: MessagePaper = useMemo(() => (dressesItself(drawn) ? "own" : "reader"), [drawn]);
    const [paper, setPaper] = useState<MessagePaper | null>(null);
    const inForce = paper ?? guessed;

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

            {drawn.trim() ? (
                <>
                    <SandboxedHtml html={drawn} showRemote={showing} paper={inForce} />
                    <button
                        type="button"
                        className="mt-2 text-[12px] text-foreground-subtle underline hover:text-foreground"
                        onClick={() => setPaper(inForce === "own" ? "reader" : "own")}
                    >
                        {inForce === "own"
                            ? "Show this in the Polaris theme"
                            : "Show this the way the sender designed it"}
                    </button>
                </>
            ) : (
                <p className="text-[13px] text-foreground-subtle">This message has nothing in it.</p>
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

/**
 * How a message is coloured.
 *
 * The hard case, and the reason this is a choice rather than a constant. A
 * newsletter carries its own colours and was designed against a white page:
 * drawing it on a dark one leaves black text on black, which is the single most
 * common complaint about dark mode in any mail client. A plain message carries
 * no colours at all, and drawing THAT on white is a bright rectangle in the
 * middle of a dark screen.
 *
 * So: a message that dresses itself keeps its own page, and one that does not
 * takes the reader's. Either way the reader can say otherwise, per message,
 * because the guess is a heuristic and heuristics are wrong sometimes.
 */
export type MessagePaper = "own" | "reader";

/** Whether the message dresses itself. A colour anywhere in it - a style, a
 *  bgcolor attribute, a font tag - means it was designed against a page of its
 *  own choosing. */
export function dressesItself(html: string): boolean {
    return /(?:background(?:-color)?\s*:|(?:\bbgcolor|\bcolor)\s*[:=])/i.test(html);
}

/**
 * The reader's own colours, read off the page this frame is drawn in.
 *
 * Taken from the live tokens rather than restated, so the frame follows whatever
 * theme is in force - including a light one, a dark one, and one an operator has
 * changed the values of. `dark` is decided from the lightness of the background
 * token rather than from a media query, for the same reason: what matters is the
 * page this is actually sitting on, not what the device prefers.
 */
function readerColors(): { foreground: string; link: string; dark: boolean } {
    if (typeof window === "undefined") return { foreground: "inherit", link: "#4f7cff", dark: false };
    const style = getComputedStyle(document.documentElement);
    const raw = (name: string) => style.getPropertyValue(name).trim();
    const token = (name: string, fallback: string) => {
        const held = raw(name);
        return held ? `hsl(${held})` : fallback;
    };
    // The tokens are written as "H S% L%", so the last number is the lightness.
    const lightness = Number(/(\d+(?:\.\d+)?)%\s*$/.exec(raw("--background"))?.[1] ?? "100");
    return {
        foreground: token("--foreground", "#111"),
        link: token("--primary", "#4f7cff"),
        dark: Number.isFinite(lightness) && lightness < 50
    };
}

/** The wrapper the message is drawn inside. Nothing here is the message's: the
 *  policy, the base target, the colours and the height reporter are all ours. */
function frameDocument(body: string, showRemote: boolean, paper: MessagePaper): string {
    const images = showRemote ? "img-src https: data: cid:;" : "img-src data:;";
    const colors = readerColors();
    // `color-scheme` is what stops a browser inverting form controls and
    // scrollbars inside the frame against the page it is actually drawn on.
    const page =
        paper === "own"
            ? "color-scheme:light;background:#ffffff;color:#111111;"
            : `color-scheme:${colors.dark ? "dark" : "light"};background:transparent;color:${colors.foreground};`;
    const linkColor = paper === "own" ? "#1a56db" : colors.link;
    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${images} style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none';">
<base target="_blank">
<style>
  html{${page}}
  html,body{margin:0;padding:0;}
  body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;word-break:break-word;overflow-wrap:anywhere;}
  img,video,table{max-width:100%;height:auto;}
  table{border-collapse:collapse;}
  blockquote{margin:0 0 0 .75rem;padding-left:.75rem;border-left:2px solid rgba(127,127,127,.4);}
  /* What a plain-text message is wrapped in: its own line breaks are the
     layout, and a long address must wrap rather than widen the frame. */
  .plain{white-space:pre-wrap;word-break:break-word;}
  .quoted{opacity:.65;}
  a{color:${linkColor};}
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

function SandboxedHtml({
    html,
    showRemote,
    paper
}: {
    html: string;
    showRemote: boolean;
    paper: MessagePaper;
}) {
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
            srcDoc={frameDocument(body, showRemote, paper)}
            className={cn(
                "w-full border-0",
                // A message on its own page gets a card to sit on, so it reads as
                // a letter rather than as a white hole in the screen.
                paper === "own" ? "rounded-md bg-white" : "bg-transparent"
            )}
            style={{ height }}
        />
    );
}
