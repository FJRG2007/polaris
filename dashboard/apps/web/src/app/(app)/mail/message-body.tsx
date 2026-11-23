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
import * as core from "@polaris/core";
import { ShieldCheck } from "lucide-react";
import { cleanedAlready, sanitizeMail } from "./sanitize";
import * as selectionMenu from "@/lib/selection-menu";
import { dressesItself, frameDocument, type MessagePaper } from "./frame-document";
import { framedOpenHref, openLink } from "@/lib/open-link";
import { TrimmedPill } from "./trimmed-pill";
import { trimReceivedHtml, trimReceivedText } from "./trimmed-content";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

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
    const t = useTranslations("mail");

    /**
     * The message without the copy of the conversation it quotes, the way Gmail
     * trims it; null when there is nothing to trim. Cut before the sanitizer
     * rather than after, so whatever is drawn - trimmed or whole - is exactly
     * what the sanitizer handed back.
     */
    const trimmedHtml = useMemo(() => {
        if (html.trim()) return trimReceivedHtml(html);
        const fresh = trimReceivedText(text);
        return fresh === null ? null : core.textToHtml(fresh);
    }, [html, text]);
    const [showTrimmed, setShowTrimmed] = useState(false);
    const shown = trimmedHtml !== null && !showTrimmed ? trimmedHtml : drawn;

    return (
        <div className="min-w-0">
            {trackerVendors.length > 0 ? (
                <p className="mb-2 flex items-center gap-1.5 text-[12px] text-foreground-subtle">
                    <ShieldCheck className="size-3.5 shrink-0 text-success" aria-hidden />
                    {trackerSentence(t, trackerVendors)}
                </p>
            ) : null}

            {drawn.trim() ? (
                <>
                    <SandboxedHtml html={shown} showRemote={remoteAllowed} paper={inForce} />
                    {trimmedHtml !== null ? (
                        <TrimmedPill
                            className="mt-1 flex"
                            label={showTrimmed ? t("body.hideTrimmed") : t("body.showTrimmed")}
                            expanded={showTrimmed}
                            onToggle={() => setShowTrimmed((open) => !open)}
                        />
                    ) : null}
                    <button
                        type="button"
                        className="mt-2 text-[12px] text-foreground-subtle underline hover:text-foreground"
                        onClick={() => setPaper(inForce === "own" ? "reader" : "own")}
                    >
                        {inForce === "own" ? t("body.readerTheme") : t("body.ownPage")}
                    </button>
                </>
            ) : (
                <p className="text-[13px] text-foreground-subtle">{t("body.empty")}</p>
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
function trackerSentence(t: NamespaceTranslator<"mail">, vendors: readonly string[]): string {
    const named =
        vendors.length === 1
            ? (vendors[0] ?? "")
            : `${vendors.slice(0, -1).join(", ")}${t("body.and")}${vendors.at(-1)}`;
    return t("body.trackers", { named });
}

/** The tallest a message may make its own frame. A message that says it is
 *  forty thousand pixels tall is a message trying to push the rest of the
 *  screen away; past this it scrolls inside its own frame. */
const MAX_FRAME_HEIGHT = 20000;

/** How tall a frame that never reported its height is made: a screen of room
 *  rather than the opening letterbox. */
const UNHEARD_HEIGHT = 720;

/**
 * The frame's next height, given what the message says it measures.
 *
 * A message sized in viewport units (`min-height: 100vh` is common in
 * newsletters) measures exactly as tall as the frame it is in. Answering that
 * with the height plus the margin grew the frame, which grew the message, which
 * reported again: eight pixels a frame until the ceiling, a few thousand renders
 * of the page while somebody was trying to use it. A message as tall as its
 * frame is one that fills it, not one asking for more.
 */
/**
 * Whether a message is growing with its frame rather than asking for room: after
 * the frame grew to fit it, it came back exactly as far over as before. A page
 * drawn with padding around a `100vh` block does that forever - each answer the
 * frame's height plus the padding - and the frame climbed to the ceiling and
 * then scrolled inside itself.
 */
export function growsWithFrame(gap: number, lastGap: number | null): boolean {
    return gap > 1 && lastGap !== null && gap === lastGap;
}

export function nextFrameHeight(current: number, claimed: number): number {
    const measured = Math.ceil(claimed);
    if (measured <= current && measured >= current - 1) return current;
    return Math.min(Math.max(120, measured + 8), MAX_FRAME_HEIGHT);
}

/** The frame itself, exported for the print page - which must draw a message
 *  through exactly these three layers and nothing less. */
export function SandboxedHtml({
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
    const t = useTranslations("mail");
    // Read during the first render when there is a window to read it from. A
    // body is only ever fetched by the browser, so this component is never part
    // of a server render and cannot mismatch one - and waiting for an effect to
    // learn it cost every opened message an extra render before its frame.
    const [origin, setOrigin] = useState(() =>
        typeof window === "undefined" ? "" : window.location.origin
    );
    useEffect(() => {
        setOrigin(window.location.origin);
    }, []);
    const frame = useRef<HTMLIFrameElement | null>(null);
    const [height, setHeight] = useState(240);
    const drawnHeight = useRef(240);
    drawnHeight.current = height;
    const lastGap = useRef<number | null>(null);
    // Set once a message is found growing with its frame. What it is still over
    // by is only the padding around a screen-tall block, so the frame stops
    // offering a scrollbar for it rather than scroll a few pixels of margin.
    const [settled, setSettled] = useState(false);
    // A message this tab has already cleaned draws in the same render, rather
    // than one render later behind a pulsing box - see `sanitize`.
    const [clean, setClean] = useState<string | null>(() => cleanedAlready(html));

    useEffect(() => {
        let live = true;
        const ready = cleanedAlready(html);
        if (ready !== null) {
            setClean(ready);
            return;
        }
        void sanitizeMail(html).then((sanitized) => {
            if (live) setClean(sanitized);
        });
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

    // Whether the frame has said how tall it is. A browser or an extension that
    // stops the frame's one script leaves it at its opening height, scrolling
    // inside itself; past a moment with no word, it is given the room of a
    // screen instead of a letterbox.
    const [heard, setHeard] = useState(false);
    useEffect(() => {
        if (heard || clean === null || !origin) return;
        const timer = setTimeout(
            () => setHeight((current) => Math.max(current, UNHEARD_HEIGHT)),
            2500
        );
        return () => clearTimeout(timer);
    }, [heard, clean, origin]);

    useEffect(() => {
        function onMessage(event: MessageEvent) {
            // Only the frame this component owns, and only a number. Anything
            // else on the wire is somebody else's message.
            if (event.source !== frame.current?.contentWindow) return;
            const opened = (event.data as { polarisMailOpen?: unknown } | null)?.polarisMailOpen;
            if (opened !== undefined) {
                const href = framedOpenHref(opened);
                if (href) openLink(href);
                return;
            }
            const menu = (event.data as { polarisMailMenu?: unknown } | null)?.polarisMailMenu;
            if (menu !== undefined) {
                const box = frame.current.getBoundingClientRect();
                const found = selectionMenu.framedSelection(menu, box);
                if (found) selectionMenu.openFramedSelection(found);
                const media = found
                    ? null
                    : selectionMenu.framedMedia(menu, box, window.location.origin);
                if (media) {
                    selectionMenu.openFramedMedia(media);
                    return;
                }
                const link = found
                    ? null
                    : selectionMenu.framedLink(menu, box, window.location.origin);
                if (link) selectionMenu.openFramedLink(link);
                return;
            }
            const claimed = (event.data as { polarisMailHeight?: unknown } | null)
                ?.polarisMailHeight;
            if (typeof claimed !== "number" || !Number.isFinite(claimed)) return;
            setHeard(true);
            const gap = Math.ceil(claimed) - drawnHeight.current;
            if (growsWithFrame(gap, lastGap.current)) {
                setSettled(true);
                return;
            }
            lastGap.current = gap;
            setHeight((current) => nextFrameHeight(current, claimed));
        }
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    if (clean === null || !origin) {
        return (
            <div className="h-24 animate-pulse rounded-md bg-card" aria-label={t("body.opening")} />
        );
    }

    return (
        <iframe
            ref={frame}
            title={t("body.frameTitle")}
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
            scrolling={settled ? "no" : undefined}
        />
    );
}
