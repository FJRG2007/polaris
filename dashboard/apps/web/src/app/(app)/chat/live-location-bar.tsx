"use client";

/**
 * "You are sharing live location in N chats", above the conversation list, the
 * way WhatsApp keeps one place to see and stop every live share - plus the part
 * that actually sends it.
 *
 * In the phone app the app's own foreground service sends the position, so it
 * keeps moving with the screen off. In a browser or the desktop app this page
 * sends it while it is open; the server stops accepting moves at the end of each
 * share regardless of what any device does.
 */

import * as actions from "./actions";
import { Button, pollWhileVisible } from "@polaris/ui";
import { Radio } from "lucide-react";
import { useChat } from "./chat-context";
import { LIVE_CHANGED } from "./location-dialog";
import { useEffect, useRef, useState } from "react";
import { phoneLiveLocation } from "@/lib/mobile-bridge";
import type { LiveShareView } from "@/lib/chat/locations";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** How often the shares are read again while the tab is on screen. */
export const SHARES_RECHECK_MS = 60_000;

/** How often a page sends the position while a share runs. */
const SEND_EVERY_MS = 10_000;

export function LiveLocationBar() {
    const t = useTranslations("chat");
    const { channels } = useChat();
    const [shares, setShares] = useState<LiveShareView[]>([]);
    const [stopping, setStopping] = useState(false);

    const reload = useRef(() => {});
    reload.current = () => {
        void actions
            .liveSharesAction()
            .then((result) => setShares(result.shares))
            .catch(() => undefined);
    };

    useEffect(() => {
        reload.current();
        const again = () => reload.current();
        window.addEventListener(LIVE_CHANGED, again);
        // A share started on another device shows up within a minute while
        // the tab is on screen; a hidden tab asks nothing, and reads once on
        // return. It used to ask every minute from every tab, seen or not.
        const stopPolling = pollWhileVisible(again, SHARES_RECHECK_MS);
        return () => {
            window.removeEventListener(LIVE_CHANGED, again);
            stopPolling();
        };
    }, []);

    const until = shares.reduce((latest, share) => Math.max(latest, Date.parse(share.liveUntil)), 0);
    const running = until > Date.now();

    // Sending. The phone app takes it over when it can; otherwise this page
    // watches the position and sends it every few seconds while it is open.
    useEffect(() => {
        if (!running) {
            phoneLiveLocation(null);
            return;
        }
        if (phoneLiveLocation(until)) return;
        if (typeof navigator === "undefined" || !navigator.geolocation) return;
        let last = 0;
        const watch = navigator.geolocation.watchPosition(
            (position) => {
                if (Date.now() - last < SEND_EVERY_MS) return;
                last = Date.now();
                void fetch("/api/chat/location/live", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                        accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null
                    })
                })
                    .then((response) => (response.ok ? response.json() : null))
                    .then((answer: { running?: number } | null) => {
                        if (answer?.running === 0) reload.current();
                    })
                    .catch(() => undefined);
            },
            () => undefined,
            { enableHighAccuracy: true, maximumAge: 5_000 }
        );
        const end = window.setTimeout(() => reload.current(), Math.max(0, until - Date.now()) + 1_000);
        return () => {
            navigator.geolocation.clearWatch(watch);
            window.clearTimeout(end);
        };
    }, [running, until]);

    if (!running) return null;
    const names = shares
        .map((share) => channels.find((channel) => channel.id === share.channelId)?.name)
        .filter((name): name is string => Boolean(name));

    const stopAll = async () => {
        if (stopping) return;
        setStopping(true);
        await actions.stopLiveLocationAction(null);
        setStopping(false);
        reload.current();
    };

    return (
        <div className="flex min-w-0 items-center gap-2 border-b border-border bg-primary/10 px-3 py-2">
            <Radio className="size-4 shrink-0 animate-pulse text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm" title={names.join(", ")}>
                {t("location.sharingIn", { count: shares.length })}
            </span>
            <Button size="sm" variant="ghost" disabled={stopping} onClick={() => void stopAll()}>
                <span className="min-w-0 truncate">{t("location.stopAll")}</span>
            </Button>
        </div>
    );
}
