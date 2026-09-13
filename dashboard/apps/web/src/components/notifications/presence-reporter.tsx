"use client";

/**
 * Tells the server which screen this tab is showing, while it is on screen.
 *
 * That is what lets an alert about something already in front of the reader
 * arrive in the history without lighting the bell or chiming - see
 * lib/notifications/presence for the rule and why it is kept in memory.
 *
 * Reported on every navigation and on a heartbeat, because a page left open for
 * an hour is still being watched and the server deliberately forgets a report it
 * has not heard repeated. A tab that goes to the background withdraws its report
 * immediately: a window behind three others is not somebody watching a deploy,
 * and treating it as one would swallow the alert it exists to raise.
 *
 * The id names the tab and nothing else. It is minted here, means nothing to any
 * other account, and is generated without `crypto.randomUUID` because that is a
 * secure-context API and Polaris is routinely reached over plain http on a local
 * name.
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { attending } from "@/components/use-attention";

const ENDPOINT = "/api/notifications/presence";

/** Comfortably inside the window the server believes a report for. */
const BEAT_MS = 25000;

export function PresenceReporter() {
    const pathname = usePathname();
    const viewerId = useRef("");
    if (!viewerId.current) viewerId.current = newViewerId();

    useEffect(() => {
        const id = viewerId.current;
        const payload = (viewing: boolean): string =>
            JSON.stringify({ viewerId: id, path: pathname, viewing });

        function report(viewing: boolean): void {
            void fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: payload(viewing),
                // The withdrawal is often sent as the tab is going away.
                keepalive: true
            }).catch(() => undefined);
        }

        /** Withdraw on the way out, where a fetch may not survive long enough. */
        function withdraw(): void {
            const body = payload(false);
            try {
                if (
                    navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))
                )
                    return;
            } catch {
                // No beacon, or the browser refused it. Fall through to the fetch.
            }
            report(false);
        }

        /**
         * Visible AND focused, through the shared rule.
         *
         * Visibility alone was not enough and said so by example: a window with a
         * call, an editor or a game on top of it is still `visible` - nothing about
         * the page changed, only what is in front of it - so a message arriving then
         * was treated as one the reader was watching and the alert about it was
         * swallowed. `components/use-attention` is the same decision the
         * conversation's read marking asks, kept in one place because the two were
         * wrong in the same direction.
         */
        function settle(): void {
            if (attending(document.visibilityState, document.hasFocus())) report(true);
            else withdraw();
        }

        settle();
        const timer = setInterval(() => {
            if (attending(document.visibilityState, document.hasFocus())) report(true);
        }, BEAT_MS);
        document.addEventListener("visibilitychange", settle);
        window.addEventListener("focus", settle);
        window.addEventListener("blur", settle);
        window.addEventListener("pagehide", withdraw);

        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", settle);
            window.removeEventListener("focus", settle);
            window.removeEventListener("blur", settle);
            window.removeEventListener("pagehide", withdraw);
        };
    }, [pathname]);

    return null;
}

/** A v4-shaped id from the strongest source this context offers. */
function newViewerId(): string {
    const bytes = new Uint8Array(16);
    const source = typeof crypto === "undefined" ? null : crypto;
    if (source?.getRandomValues) source.getRandomValues(bytes);
    else
        for (let index = 0; index < bytes.length; index += 1)
            bytes[index] = Math.floor(Math.random() * 256);
    // Version and variant, so the id parses as the UUID the endpoint asks for.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
