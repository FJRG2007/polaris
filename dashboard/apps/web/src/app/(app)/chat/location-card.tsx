"use client";

/**
 * A location under a message: a map with the pin, what it is, and - for a live
 * share - until when it moves, when it last moved, and the sender's button to
 * stop it. A request card carries the two one-tap answers instead.
 *
 * A live card re-reads itself when the conversation's live frame says something
 * moved, the way a poll card does, and ticks once a minute so "updated" and the
 * end of the share are right without anybody sending anything.
 */

import * as actions from "./actions";
import { useChatStream } from "./use-chat-stream";
import { TileMap } from "@/components/map/tile-map";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatLocationView } from "@/lib/chat/locations";
import { LIVE_CHANGED, LocationDialog } from "./location-dialog";
import { Button, Dialog, DialogContent, DialogTitle } from "@polaris/ui";
import { ExternalLink, MapPinned, Navigation, Radio } from "lucide-react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

/** The same point on OpenStreetMap's own site, for directions and a bigger map. */
export function osmLink(latitude: number, longitude: number): string {
    const lat = latitude.toFixed(6);
    const lon = longitude.toFixed(6);
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

export function LocationCard({
    message,
    location,
    mine,
    canPost,
    onError
}: {
    message: ChatMessageView;
    location: ChatLocationView;
    mine: boolean;
    canPost: boolean;
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const locale = useLocale();
    const [shown, setShown] = useState(location);
    const [big, setBig] = useState(false);
    const [answer, setAnswer] = useState<"main" | "live" | null>(null);
    const [stopping, setStopping] = useState(false);
    const [, setTick] = useState(0);
    useEffect(() => setShown(location), [location]);

    const live = shown.live && (shown.liveUntil ? Date.parse(shown.liveUntil) > Date.now() : false);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "posted" || !frame.channels.includes(message.channelId) || !live) return;
                void actions.locationAction(message.id).then((result) => {
                    if (result.location) setShown(result.location);
                });
            },
            [message.channelId, message.id, live]
        )
    );

    useEffect(() => {
        if (!live) return;
        const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
        return () => window.clearInterval(timer);
    }, [live]);

    const stop = async () => {
        if (stopping) return;
        setStopping(true);
        const result = await actions.stopLiveLocationAction(message.id);
        setStopping(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        setShown({ ...shown, live: false, endedEarly: true });
        window.dispatchEvent(new Event(LIVE_CHANGED));
    };

    if (shown.mode === "request") {
        return (
            <div className="mt-1 flex w-full max-w-sm min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <MapPinned className="size-4 shrink-0 text-primary" />
                    <span className="min-w-0 truncate">
                        {mine ? t("location.youRequested") : t("location.requestedYou", { name: message.authorName })}
                    </span>
                </span>
                {!mine && canPost && !message.deleted ? (
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => setAnswer("main")}>
                            <Navigation className="size-4 shrink-0" />
                            <span className="min-w-0 truncate">{t("location.sendCurrent")}</span>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setAnswer("live")}>
                            <Radio className="size-4 shrink-0" />
                            <span className="min-w-0 truncate">{t("location.shareLive")}</span>
                        </Button>
                    </div>
                ) : null}
                {answer ? (
                    <LocationDialog
                        open
                        onOpenChange={(open) => !open && setAnswer(null)}
                        channelId={message.channelId}
                        parentId={message.parentId ?? null}
                        replyToId={message.id}
                        start={answer}
                        allowRequest={false}
                    />
                ) : null}
            </div>
        );
    }

    if (shown.latitude === null || shown.longitude === null) return null;
    const point = {
        latitude: shown.latitude,
        longitude: shown.longitude,
        accuracy: shown.accuracy,
        label: message.authorName ?? undefined,
        live
    };
    const title =
        shown.mode === "place"
            ? (shown.placeName ?? t("location.place"))
            : shown.mode === "live"
              ? live
                  ? t("location.liveLocation")
                  : t("location.liveEnded")
              : t("location.location");
    const coordinates = `${shown.latitude.toFixed(5)}, ${shown.longitude.toFixed(5)}`;
    const until = shown.liveUntil
        ? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(shown.liveUntil))
        : "";

    return (
        <div className="mt-1 flex w-full max-w-sm min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
            <button
                type="button"
                onClick={() => setBig(true)}
                aria-label={t("location.openMap")}
                className="block w-full text-start"
            >
                <TileMap points={[point]} height={150} zoom={15} />
            </button>
            <div className="flex min-w-0 items-start gap-2 p-2.5">
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={title}>
                        {title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                        {shown.mode === "live" && live ? (
                            <>
                                {t("location.liveUntil", { time: until })}
                                {" · "}
                                {t("location.updated")} <RelativeTime iso={shown.movedAt} />
                            </>
                        ) : shown.mode === "live" ? (
                            <>
                                {t("location.lastUpdated")} <RelativeTime iso={shown.movedAt} />
                            </>
                        ) : shown.mode === "place" ? (
                            (shown.address ?? coordinates)
                        ) : shown.accuracy ? (
                            t("location.accurateTo", { meters: String(Math.round(shown.accuracy)) })
                        ) : (
                            coordinates
                        )}
                    </span>
                </div>
                {mine && live ? (
                    <Button size="sm" variant="danger" disabled={stopping} onClick={() => void stop()}>
                        <span className="min-w-0 truncate">{t("location.stopSharing")}</span>
                    </Button>
                ) : null}
            </div>
            <Dialog open={big} onOpenChange={setBig}>
                <DialogContent phone="sheet" className="flex w-full max-w-2xl flex-col gap-3">
                    <DialogTitle className="min-w-0 truncate">{title}</DialogTitle>
                    <div className="overflow-hidden rounded-lg border border-border">
                        <TileMap points={[point]} height={360} zoom={16} controls />
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-muted-foreground" title={coordinates}>
                            {coordinates}
                        </span>
                        <a
                            href={osmLink(shown.latitude, shown.longitude)}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                            <ExternalLink className="size-4 shrink-0" />
                            {t("location.openInMaps")}
                        </a>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
