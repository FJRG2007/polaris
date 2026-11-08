"use client";

/**
 * The page's side of a phone used as the game's controller. The game asks for
 * a pad (`polaris-game:pad-open`, from its start screen); this opens one on the
 * server, hands the game its code and a QR of the link that carries it, and
 * then relays: the phone's controls into the frame, the game's rumbles out to
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

const padOpened = z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    code: z.string().regex(/^\d{6}$/)
});

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
    const pad = useRef<{ id: string; code: string; events: EventSource } | null>(null);
    const opening = useRef(false);

    useEffect(() => {
        const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
        const close = () => {
            const open = pad.current;
            pad.current = null;
            if (!open) return;
            open.events.close();
            void fetch(`/api/arcade/pad/${open.id}`, { method: "DELETE" }).catch(() => {});
        };
        const open = async () => {
            if (opening.current) return;
            // A pad already open is offered again (the game reloaded its start screen)
            if (pad.current) {
                setLink(phonePadLink(base.current, window.location.origin, pad.current.code));
                return;
            }
            opening.current = true;
            try {
                const response = await fetch("/api/arcade/pad", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(gameId.current ? { game: gameId.current } : {})
                });
                const opened = padOpened.safeParse(response.ok ? await response.json() : null);
                if (!opened.success) throw new Error("pad refused");
                const events = new EventSource(`/api/arcade/pad/${opened.data.id}`);
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
                // A stream the server ended (the pad is gone): the game may ask for a new one
                events.onerror = () => {
                    if (events.readyState !== EventSource.CLOSED || pad.current?.events !== events)
                        return;
                    pad.current = null;
                    post({ type: "polaris-game:pad", connected: false, name: "" });
                    post({ type: "polaris-game:pad", failed: true });
                };
                pad.current = { id: opened.data.id, code: opened.data.code, events };
                setLink(phonePadLink(base.current, window.location.origin, opened.data.code));
            } catch {
                post({ type: "polaris-game:pad", failed: true });
            } finally {
                opening.current = false;
            }
        };
        const onMessage = (event: MessageEvent) => {
            if (!fromFrame(event, frame.current?.contentWindow)) return;
            const message = fromGame.safeParse(event.data);
            if (!message.success) return;
            if (message.data.type === "polaris-game:pad-open") void open();
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
        return () => {
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
            frame.current?.contentWindow?.postMessage(
                { type: "polaris-game:pad", code, link, qr: svgDataUrl(svg.outerHTML) },
                "*"
            );
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
