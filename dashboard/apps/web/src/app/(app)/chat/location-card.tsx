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
import { liveLeft } from "@/lib/chat/live-left";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatLocationView } from "@/lib/chat/locations";
import { LIVE_CHANGED, LocationDialog } from "./location-dialog";
import { Button, Dialog, DialogContent, DialogTitle } from "@polaris/ui";
import { openLink } from "@/lib/open-link";
import { locate, permissionState, type Fix } from "@/lib/geolocation";
import { directionsUrl, distanceMeters, mapsPlatform, placeUrl } from "@/lib/maps-links";
import { ExternalLink, LocateFixed, MapPinned, Navigation, Radio } from "lucide-react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { usePhone } from "@/components/use-phone";
import type { MapStyle } from "@/lib/map-layers";
import { MapStyleSwitch, PhoneLocationViewer } from "./location-viewer";

/** Within this many metres, the reader is at the place rather than some way from it. */
const HERE_METERS = 50;

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
    const [style, setStyle] = useState<MapStyle>("map");
    const phone = usePhone();
    // Where the reader is, for the big map: asked on its own only when already
    // allowed, otherwise on a press, so opening a map never raises a prompt.
    const [me, setMe] = useState<Fix | null>(null);
    useEffect(() => {
        if (!big) return;
        let current = true;
        void permissionState().then((state) => {
            if (state !== "granted" || !current) return;
            setMe({ state: "locating" });
            void locate().then((found) => current && setMe(found));
        });
        return () => {
            current = false;
        };
    }, [big]);
    const findMe = () => {
        setMe({ state: "locating" });
        void locate().then(setMe);
    };
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
    const viewer = me?.state === "ready" ? me.point : null;
    const away = viewer ? distanceMeters(viewer, point) : null;
    const distanceText =
        away === null
            ? ""
            : away <= HERE_METERS
              ? t("location.youAreHere")
              : t("location.away", {
                    distance:
                        away < 1000
                            ? t("location.meters", { meters: String(Math.round(away)) })
                            : t("location.kilometers", { km: (away / 1000).toFixed(away < 10_000 ? 1 : 0) })
                });
    const until = shown.liveUntil
        ? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(shown.liveUntil))
        : "";
    const left = shown.liveUntil ? liveLeft(Date.parse(shown.liveUntil), Date.now()) : null;
    const leftText = !left
        ? ""
        : left.hours > 0
          ? t("location.hoursLeft", { hours: String(left.hours), minutes: String(left.minutes) })
          : t("location.minutesLeft", { count: left.minutes });

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
            {phone ? (
                <PhoneLocationViewer
                    open={big}
                    onOpenChange={setBig}
                    messageId={message.id}
                    point={point}
                    viewer={viewer ? { ...viewer, self: true, label: t("location.you") } : null}
                    heading={shown.mode === "place" ? (shown.placeName ?? null) : null}
                    callout={{
                        title: mine
                            ? t("location.nameYou", { name: message.authorName ?? "" })
                            : (message.authorName ?? title),
                        detail: shown.mode === "live" ? (live ? leftText || undefined : t("location.liveEnded")) : undefined
                    }}
                    action={
                        mine && live ? (
                            <Button size="sm" variant="danger" disabled={stopping} onClick={() => void stop()}>
                                <span className="min-w-0 truncate">{t("location.stopSharing")}</span>
                            </Button>
                        ) : null
                    }
                />
            ) : null}
            <Dialog open={big && !phone} onOpenChange={setBig}>
                {/* Full screen on a phone, as WhatsApp opens a location: the map takes
                    whatever the actions below it leave, and pinches and drags like one. */}
                <DialogContent phone="full" className="flex w-full max-w-2xl flex-col gap-3">
                    <DialogTitle className="min-w-0 truncate">{title}</DialogTitle>
                    <div className="relative overflow-hidden rounded-lg border border-border max-sm:min-h-0 max-sm:flex-1">
                        {/* Drawn again once the reader is found, so both pins start in view. */}
                        <TileMap
                            key={viewer ? "both" : "place"}
                            points={viewer ? [point, { ...viewer, self: true, label: t("location.you") }] : [point]}
                            height={360}
                            zoom={viewer ? undefined : 16}
                            controls
                            style={style}
                            className="max-sm:!h-full"
                        />
                        <MapStyleSwitch
                            value={style}
                            onChange={setStyle}
                            className="absolute bottom-3 left-1/2 max-w-[calc(100%-1.5rem)] -translate-x-1/2 bg-neutral-800/70 text-white"
                        />
                    </div>
                    {/* Live or over, how long it has left, and the sender's own way
                        to end it, as WhatsApp's full map shows them. */}
                    {shown.mode === "live" ? (
                        <div className="flex min-w-0 items-center gap-2 text-sm">
                            <Radio
                                className={`size-4 shrink-0 ${live ? "animate-pulse text-primary" : "text-muted-foreground"}`}
                            />
                            <span className="min-w-0 flex-1 truncate">
                                {live ? (
                                    <>
                                        {t("location.liveUntil", { time: until })}
                                        {leftText ? ` · ${leftText}` : ""}
                                    </>
                                ) : (
                                    <>
                                        {t("location.liveEnded")}
                                        {" · "}
                                        {t("location.lastUpdated")} <RelativeTime iso={shown.movedAt} />
                                    </>
                                )}
                            </span>
                            {mine && live ? (
                                <Button size="sm" variant="danger" disabled={stopping} onClick={() => void stop()}>
                                    <span className="min-w-0 truncate">{t("location.stopSharing")}</span>
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                        <LocateFixed className="size-4 shrink-0 text-muted-foreground" />
                        {away === null ? (
                            me?.state === "locating" ? (
                                <span className="min-w-0 truncate text-muted-foreground">{t("location.locating")}</span>
                            ) : (
                                <>
                                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                        {me?.state === "denied"
                                            ? t("location.denied")
                                            : me && me.state !== "ready"
                                              ? t("location.unavailable")
                                              : t("location.howFarHint")}
                                    </span>
                                    <Button size="sm" variant="outline" onClick={findMe}>
                                        <span className="min-w-0 truncate">{t("location.howFar")}</span>
                                    </Button>
                                </>
                            )
                        ) : (
                            <span className="min-w-0 truncate" title={distanceText}>
                                {distanceText}
                            </span>
                        )}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-muted-foreground" title={coordinates}>
                            {coordinates}
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => openLink(placeUrl(point, mapsPlatform()))}>
                                <ExternalLink className="size-4 shrink-0" />
                                <span className="min-w-0 truncate">{t("location.openInMaps")}</span>
                            </Button>
                            <Button size="sm" onClick={() => openLink(directionsUrl(point, mapsPlatform()))}>
                                <Navigation className="size-4 shrink-0" />
                                <span className="min-w-0 truncate">{t("location.directions")}</span>
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
