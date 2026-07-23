"use client";

/**
 * Presence heartbeat for a public drop point. While the page is open it pings the
 * drop point every 20s (and immediately on load / when the tab regains focus), so
 * the owner's Visitors view can show live sessions and connected duration. Renders
 * nothing; failures are ignored - it must never disrupt the upload experience.
 */

import { useEffect } from "react";

export function DropPresence({ token }: { token: string }) {
    useEffect(() => {
        const ping = () => {
            void fetch(`/api/r/${token}/ping`, { method: "POST", keepalive: true }).catch(
                () => undefined
            );
        };
        ping();
        const timer = setInterval(ping, 20_000);
        const onVisible = () => {
            if (document.visibilityState === "visible") ping();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [token]);
    return null;
}
