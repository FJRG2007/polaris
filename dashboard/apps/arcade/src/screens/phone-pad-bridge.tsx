"use client";

/**
 * The page's side of a phone used as the game's controller. A pad is opened
 * as soon as the game is, for the owner's own phone to take with one tap from
 * its list; when the game asks to pair one (`polaris-game:pad-open`, from its
 * start screen) its code is offered too, with a QR of the link that carries
 * it. A pad the server drops (an update restarted it) is opened again. Then it
 * relays: the phone's controls into the frame, the game's rumbles out to
 * the phone. The game's page is sandboxed in a call, so it cannot reach the
 * server itself. The protocol is listed in `game/new-york/engine/phone-pad.js`.
 */

import { z } from "zod";
import { fromFrame } from "./game-frame";
import { phonePadLink, svgDataUrl } from "./phone-pad-input";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useRef, useState, type RefObject } from "react";

const fromGame = z.discriminatedUnion("type", [
    z.object({ type: z.literal("polaris-game:pad-open") }),
    z.object({
        type: z.literal("polaris-game:pad-rumble"),
        strong: z.number().min(0).max(1),
        weak: z.number().min(0).max(1),
        duration: z.number().int().min(1).max(2_000)
    })
]);

/** What the game is sent to pair a phone: the code, its link and a QR image of the link. */
type PadOffer = { type: "polaris-game:pad"; code: string; link: string; qr: string };

const padOpened = z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    code: z.string().regex(/^\d{6}$/)
});

/** Tries at reopening a pad the server dropped before the game is told it failed. */
const REOPEN_TRIES = 5;
const REOPEN_DELAY_MS = 2_000;

const padEvent = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("input"),
        frame: z.object({
            axes: z.array(z.number()).length(4),
            buttons: z.array(z.number()).length(17)
        })
    }),
    z.object({ kind: z.literal("phone"), connected: z.boolean(), name: z.string() })
]);

export function PhonePadBridge({
    frame,
    game
}: {
    frame: RefObject<HTMLIFrameElement | null>;
    /** The game's id, so the owner's phone lists the pad by the game's name. */
    game?: string;
}) {
    const gameId = useRef(game);
    gameId.current = game;
    // Read here, not at import: a host without an encoder (a test) still mounts the frame
    const QRCodeSVG = hostUi.qrCode?.QRCodeSVG;
    // Links go out on the Polaris domain, not the address this tab was opened on
    const appUrl = hostUi.appUrl?.useAppUrl() ?? "";
    const base = useRef(appUrl);
    base.current = appUrl;
    const [link, setLink] = useState("");
    const qr = useRef<HTMLDivElement>(null);
    const pad = useRef<{ id: string; code: string; events: EventSource; coded: boolean } | null>(
        null
    );
    const opening = useRef(false);
    // The last offer sent in, so a game that asks again for the same pad gets it again
    const offered = useRef<PadOffer | null>(null);

    useEffect(() => {
        const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
        const close = () => {
            const open = pad.current;
            pad.current = null;
            if (!open) return;
            open.events.close();
            void fetch(`/api/arcade/pad/${open.id}`, { method: "DELETE" }).catch(() => {});
        };
        let stopped = false;
        let tries = 0;
        let retry: number | undefined;
        // Whether the game asked to pair: from then on its pad's code is offered
        let wanted = false;
        const offer = async () => {
            const current = pad.current;
            if (!current) return;
            if (!current.coded) {
                const response = await fetch(`/api/arcade/pad/${current.id}`, { method: "PUT" });
                if (!response.ok || pad.current !== current) throw new Error("code refused");
                current.coded = true;
            }
            // The same link sets no new state, so an offer already drawn is posted straight in;
            // one not drawn yet goes in when its QR is on the page.
            if (offered.current?.code === current.code) post(offered.current);
            else setLink(phonePadLink(base.current, window.location.origin, current.code));
        };
        const open = async () => {
            if (opening.current || stopped) return;
            if (pad.current) {
                if (wanted) await offer().catch(() => post({ type: "polaris-game:pad", failed: true }));
                return;
            }
            opening.current = true;
            // Read once: the game may ask to pair while this is on its way
            const coded = wanted;
            try {
                const response = await fetch("/api/arcade/pad", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...(gameId.current ? { game: gameId.current } : {}),
                        ...(coded ? {} : { auto: true })
                    })
                });
                const opened = padOpened.safeParse(response.ok ? await response.json() : null);
                if (!opened.success) throw new Error("pad refused");
                if (stopped) {
                    void fetch(`/api/arcade/pad/${opened.data.id}`, { method: "DELETE" }).catch(
                        () => {}
                    );
                    return;
                }
                const events = new EventSource(`/api/arcade/pad/${opened.data.id}`);
                events.onopen = () => {
                    tries = 0;
                };
                events.onmessage = (message) => {
                    let data: unknown = null;
                    try {
                        data = JSON.parse(message.data);
                    } catch {
                        return;
                    }
                    const event = padEvent.safeParse(data);
                    if (!event.success) return;
                    if (event.data.kind === "input")
                        post({ type: "polaris-game:pad-input", ...event.data.frame });
                    else
                        post({
                            type: "polaris-game:pad",
                            connected: event.data.connected,
                            name: event.data.name
                        });
                };
                // A stream the server ended (the pad is gone): a new pad, so the phone still finds the game
                events.onerror = () => {
                    if (events.readyState !== EventSource.CLOSED || pad.current?.events !== events)
                        return;
                    pad.current = null;
                    offered.current = null;
                    post({ type: "polaris-game:pad", connected: false, name: "" });
                    reopen();
                };
                pad.current = { id: opened.data.id, code: opened.data.code, events, coded };
            } catch {
                reopen();
                return;
            } finally {
                opening.current = false;
            }
            if (wanted) await offer().catch(() => post({ type: "polaris-game:pad", failed: true }));
        };
        const reopen = () => {
            if (stopped) return;
            tries += 1;
            if (tries > REOPEN_TRIES) {
                if (wanted) post({ type: "polaris-game:pad", failed: true });
                return;
            }
            window.clearTimeout(retry);
            retry = window.setTimeout(() => void open(), REOPEN_DELAY_MS * tries);
        };
        const onMessage = (event: MessageEvent) => {
            if (!fromFrame(event, frame.current?.contentWindow)) return;
            const message = fromGame.safeParse(event.data);
            if (!message.success) return;
            if (message.data.type === "polaris-game:pad-open") {
                wanted = true;
                // A game asking again after a failure gets a fresh round of tries
                tries = 0;
                void open();
            }
            else if (pad.current) {
                const { strong, weak, duration } = message.data;
                void fetch(`/api/arcade/pad/${pad.current.id}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ strong, weak, duration })
                }).catch(() => {});
            }
        };
        window.addEventListener("message", onMessage);
        // Open with the game, so the owner's phone lists it before anyone asks to pair
        void open();
        return () => {
            stopped = true;
            window.clearTimeout(retry);
            window.removeEventListener("message", onMessage);
            close();
        };
    }, [frame]);

    // The QR is drawn here (the game has no encoder) and sent in as an image once it is on the page
    useEffect(() => {
        const box = qr.current;
        if (!link || !box || !pad.current) return;
        const code = pad.current.code;
        const send = () => {
            const svg = box.querySelector("svg");
            if (!svg) return false;
            const offer: PadOffer = {
                type: "polaris-game:pad",
                code,
                link,
                qr: svgDataUrl(svg.outerHTML)
            };
            offered.current = offer;
            frame.current?.contentWindow?.postMessage(offer, "*");
            return true;
        };
        if (send()) return;
        const watch = new MutationObserver(() => {
            if (send()) watch.disconnect();
        });
        watch.observe(box, { childList: true, subtree: true });
        return () => watch.disconnect();
    }, [link, frame]);

    return (
        <div ref={qr} hidden aria-hidden>
            {link && QRCodeSVG && <QRCodeSVG value={link} size={176} marginSize={1} />}
        </div>
    );
}
