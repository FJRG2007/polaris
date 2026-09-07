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

import { cn } from "@polaris/ui";
import { ShieldCheck } from "lucide-react";
import * as core from "@polaris/core";
import { useEffect, useMemo, useRef, useState } from "react";

export function MessageBody({
    html,
    text,
    remoteAllowed,
    trackerVendors
}: {
    html: string;
    text: string;
    /** Whether this mailbox draws pictures at all. They are served through
     *  Polaris either way, so this is a preference rather than a defence. */
    remoteAllowed: boolean;
    trackerVendors: readonly string[];
}) {

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
            {trackerVendors.length > 0 ? (
                <p className="mb-2 flex items-center gap-1.5 text-[12px] text-foreground-subtle">
                    <ShieldCheck className="size-3.5 shrink-0 text-success" aria-hidden />
                    {trackerSentence(trackerVendors)}
                </p>
            ) : null}

            {drawn.trim() ? (
                <>
                    <SandboxedHtml html={drawn} showRemote={remoteAllowed} paper={inForce} />
                    <button
                        type="button"
                        className="mt-2 text-[12px] text-foreground-subtle underline hover:text-foreground"
                        onClick={() => setPaper(inForce === "own" ? "reader" : "own")}
                    >
                        {inForce === "own"
                            ? "Show this in the Polaris theme"
                            : "Show this on its own white page"}
                    </button>
                </>
            ) : (
                <p className="text-[13px] text-foreground-subtle">This message has nothing in it.</p>
            )}
        </div>
    );
}


/**
 * Addresses a sender typed but did not link.
 *
 * Plenty of mail carries an address as words - a tracking page, a meeting, an
 * unsubscribe line - and leaving it as words means the reader has to select and
 * copy it. Every other client makes them links, and a message with a dead
 * address in it reads as broken rather than as faithful.
 *
 * Done on the parsed document rather than with an expression over the markup,
 * which is the only safe way: a pattern loose enough to find an address in a
 * sentence is also loose enough to find one inside an `href`, a `style` or a
 * `srcset` and rewrite the tag around it. Text nodes are the only thing touched,
 * and never one already inside a link.
 *
 * Runs after the sanitizer, so what it reads has already been through it - and
 * what it writes is an anchor with a scheme it checked itself.
 */
export function linkifyBareAddresses(html: string): string {
    if (!/(?:https?:\/\/|www\.)/i.test(html)) return html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data || !/(?:https?:\/\/|www\.)\S/i.test(text.data)) continue;
        if (text.parentElement?.closest("a, style, script, textarea")) continue;
        found.push(text);
    }
    if (found.length === 0) return html;

    for (const text of found) {
        const pieces = doc.createDocumentFragment();
        let at = 0;
        for (const match of text.data.matchAll(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi)) {
            const start = match.index ?? 0;
            // A full stop or a bracket at the end of a sentence is not part of
            // the address, which is the commonest way an autolinker gets it
            // wrong.
            const raw = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
            if (start > at) pieces.append(text.data.slice(at, start));
            const anchor = doc.createElement("a");
            anchor.href = /^www\./i.test(raw) ? `https://${raw}` : raw;
            anchor.textContent = raw;
            pieces.append(anchor);
            at = start + raw.length;
        }
        if (at < text.data.length) pieces.append(text.data.slice(at));
        text.replaceWith(pieces);
    }
    return doc.body.innerHTML;
}

/**
 * The line above a message that carried trackers.
 *
 * A statement, not a gate. The pictures are already on screen - they came
 * through Polaris, so the sender learned nothing - and this says who was trying
 * to watch. A button that made somebody click before seeing their own mail was
 * the wrong trade: neither Gmail nor Proton asks that, and it turned every
 * newsletter into a chore.
 */
function trackerSentence(vendors: readonly string[]): string {
    const named = vendors.length === 1 ? vendors[0] : `${vendors.slice(0, -1).join(", ")} and ${vendors.at(-1)}`;
    return `Trackers from ${named} were served through Polaris, so they learned nothing about you.`;
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

/**
 * Whether the message brought a page of its own.
 *
 * A background is the test, and a text colour is not. A newsletter that set a
 * background was designed against it, and taking that away is what leaves black
 * text on black. The much commoner thing - an automated message that sets a
 * colour on a heading or a signature and nothing else - was designed against
 * whatever page it happened to land on, which for most of its life was white
 * because that is what its author's client used. Treating those as designed put
 * a bright white card in the middle of a dark screen for every receipt and
 * password reset anybody gets, and there was nothing in them that needed it.
 *
 * They take the reader's page instead, with their own colours neutralised so
 * nothing arrives unreadable - see `frameDocument`. What is lost is a coloured
 * heading; what is gained is a mailbox that looks like one screen.
 */
export function dressesItself(html: string): boolean {
    return /(?:\bbackground(?:-color)?\s*:|\bbgcolor\s*=)/i.test(html);
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
function frameDocument(body: string, showRemote: boolean, paper: MessagePaper, origin: string): string {
    // Only this origin, and only when the mailbox draws pictures at all. Not
    // `https:` - that would let a message fetch straight from its sender and
    // undo the whole point of serving them through here.
    const images = showRemote ? `img-src ${origin} data: cid:;` : "img-src data:;";
    const colors = readerColors();
    // `color-scheme` is what stops a browser inverting form controls and
    // scrollbars inside the frame against the page it is actually drawn on.
    const page =
        paper === "own"
            ? "color-scheme:light;background:#ffffff;color:#111111;"
            : `color-scheme:${colors.dark ? "dark" : "light"};background:transparent;color:${colors.foreground};`;
    const linkColor = paper === "own" ? "#1a56db" : colors.link;
    // A page of its own is a sheet of paper, and text has never been printed
    // flush to the edge of one. A designed newsletter brings its own outer
    // table and does not need this; the plain white rectangle a simple message
    // gets is exactly what looked wrong without it.
    const inset = paper === "own" ? "padding:16px;" : "";
    // Their colours, on our page, made readable.
    //
    // Only ever on the reader's page, and only ever colours: a message that got
    // here set no background of its own, so its author had no idea what would be
    // behind their dark grey heading - and on a dark page it is not there at all.
    // Anything the message drew rather than wrote is untouched, which is why this
    // leaves images, borders and layout exactly as they are.
    const adapt =
        paper === "reader"
            ? `#polaris-body,#polaris-body *:not(a){color:inherit!important;background-color:transparent!important;}
  #polaris-body a{color:${linkColor}!important;}`
            : "";
    return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${images} style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none';">
<base target="_blank">
<style>
  html{${page}}
  html,body{margin:0;padding:0;}
  body{${inset}}
  body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;word-break:break-word;overflow-wrap:anywhere;}
  img,video,table{max-width:100%;height:auto;}
  table{border-collapse:collapse;}
  blockquote{margin:0 0 0 .75rem;padding-left:.75rem;border-left:2px solid rgba(127,127,127,.4);}
  /* What a plain-text message is wrapped in: its own line breaks are the
     layout, and a long address must wrap rather than widen the frame. */
  .plain{white-space:pre-wrap;word-break:break-word;}
  .quoted{opacity:.65;}
  a{color:${linkColor};}
  ${adapt}
</style>
</head><body><div id="polaris-body">${body}</div>
<style>
  /* Last in the cascade on purpose, so it beats the message's own sheet.
     Newsletters set html,body height 100% all the time, which makes the
     document exactly as tall as the frame however long the message is - so the
     frame stayed at its opening height and scrolled inside itself, next to the
     pane already scrolling outside it. */
  html,body{height:auto!important;min-height:0!important;overflow:visible!important;}
</style>
<script>
  // The one thing the frame is allowed to do: say how tall it is, so the page
  // can size it. It cannot reach the page - the sandbox withheld same-origin -
  // and the page treats what arrives as a number and nothing else.
  (function () {
    var root = document.getElementById("polaris-body");
    // The wrapper rather than the document: a message that sets its own height
    // to 100% makes the document lie, and the wrapper cannot.
    function measure() {
      return Math.max(
        root ? root.scrollHeight : 0,
        root ? Math.ceil(root.getBoundingClientRect().height) : 0,
        document.body ? document.body.scrollHeight : 0
      );
    }
    function tell() { parent.postMessage({ polarisMailHeight: measure() }, "*"); }
    window.addEventListener("load", tell);
    if (root) new ResizeObserver(tell).observe(root);
    // A picture that arrives after the layout settled changes the height, and a
    // message is mostly pictures.
    window.addEventListener("resize", tell);
    setTimeout(tell, 300);
    setTimeout(tell, 1500);
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
    // What this Polaris is called from where the reader is sitting. Read once,
    // and never during render: the server has no window, and a value that
    // differed between its HTML and the browser's first paint is a hydration
    // mismatch on the most security-sensitive component in the app.
    const [origin, setOrigin] = useState("");
    useEffect(() => {
        setOrigin(window.location.origin);
    }, []);
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

    /**
     * The frame has an opaque origin - the sandbox withheld same-origin - so a
     * relative address in it resolves against nothing. The proxy paths the
     * server wrote are made absolute here, in the browser that knows what this
     * Polaris is called, which is also what the frame's own policy then names as
     * the only place a picture may come from.
     */
    const body = useMemo(() => {
        if (clean === null) return "";
        const linked = linkifyBareAddresses(clean);
        return linked.replace(
            /(["'])\/api\/mail\/image\//g,
            (_match, quote: string) => `${quote}${origin}/api/mail/image/`
        );
    }, [clean, origin]);

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

    if (clean === null || !origin) {
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
            srcDoc={frameDocument(body, showRemote, paper, origin)}
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
