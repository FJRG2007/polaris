"use client";

/**
 * Sharing a location, the way WhatsApp's Location sheet does it: where you are
 * now (with how sure the device is), a place nearby picked from a search, a live
 * share for 15 minutes, an hour or eight hours with an optional note, and - an
 * addition - asking somebody else for theirs.
 *
 * The browser (or the phone app's web view) is asked for the position only when
 * this opens, never before, and every way it can say no is said in words the
 * reader can act on.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { phoneMedia } from "@/lib/mobile-media";
import { locate, type Fix } from "@/lib/geolocation";
import { TileMap } from "@/components/map/tile-map";
import type { NearbyPlace } from "@/lib/chat/locations";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Dialog, DialogContent, DialogTitle, Input, cn } from "@polaris/ui";
import { ArrowLeft, Crosshair, Loader2, MapPin, MapPinned, Navigation, Radio, Search } from "lucide-react";

/** Tells the live sender on this page that a share started or stopped. */
export const LIVE_CHANGED = "polaris:live-location";

export function LocationDialog({
    open,
    onOpenChange,
    channelId,
    parentId = null,
    replyToId = null,
    start = "main",
    allowRequest = true,
    onSent
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    channelId: string;
    parentId?: string | null;
    replyToId?: string | null;
    /** "live" opens straight on the length picker, for an answer to a request. */
    start?: "main" | "live";
    /** Whether "Request location" is offered: only where somebody else can answer. */
    allowRequest?: boolean;
    onSent?: () => void;
}) {
    const t = useTranslations("chat");
    const [fix, setFix] = useState<Fix>({ state: "locating" });
    const [step, setStep] = useState<"main" | "live">(start);
    const [minutes, setMinutes] = useState<number>(core.LIVE_LOCATION_MINUTES[0]);
    const [comment, setComment] = useState("");
    const [query, setQuery] = useState("");
    const [places, setPlaces] = useState<NearbyPlace[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const asked = useRef(0);
    // Inside the phone app, a refusal is undone in the app's own settings page,
    // which the app can open; a browser's is beside its address bar.
    const phoneSettings = useMemo(() => phoneMedia(), []);

    const ask = () => {
        const id = ++asked.current;
        setFix({ state: "locating" });
        void locate().then((found) => {
            if (asked.current === id) setFix(found);
        });
    };

    useEffect(() => {
        if (!open) return;
        setStep(start);
        setError("");
        setPlaces(null);
        setQuery("");
        setComment("");
        ask();
    }, [open]);

    // Back from the settings where location was turned on: ask again, so the
    // map appears without another press.
    useEffect(() => {
        if (!open || (fix.state !== "denied" && fix.state !== "dismissed")) return;
        const back = () => {
            if (document.visibilityState === "visible") ask();
        };
        document.addEventListener("visibilitychange", back);
        return () => document.removeEventListener("visibilitychange", back);
    }, [open, fix.state]);

    const point = fix.state === "ready" ? fix.point : null;
    const common = { channelId, parentId, replyToId };

    const send = async (input: Record<string, unknown>) => {
        if (busy) return;
        setBusy(true);
        setError("");
        const result = await actions.sendLocationAction({ ...common, ...input });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (input.mode === "live") window.dispatchEvent(new Event(LIVE_CHANGED));
        onOpenChange(false);
        onSent?.();
    };

    const search = async () => {
        if (!point || query.trim().length < 2 || searching) return;
        setSearching(true);
        setError("");
        const result = await actions.nearbyPlacesAction({
            query: query.trim(),
            latitude: point.latitude,
            longitude: point.longitude
        });
        setSearching(false);
        if (result.error) setError(result.error);
        setPlaces(result.places ?? []);
    };

    const problem =
        fix.state === "denied"
            ? t(phoneSettings ? "location.deniedApp" : "location.denied")
            : fix.state === "dismissed"
              ? t("location.dismissed")
              : fix.state === "unavailable"
              ? t("location.unavailable")
              : fix.state === "unsupported"
                ? t("location.unsupported")
                : fix.state === "insecure"
                  ? t("location.insecure")
                  : "";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent phone="sheet" className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-hidden">
                <div className="flex min-w-0 items-center gap-2">
                    {step === "live" && start === "main" ? (
                        <button
                            type="button"
                            onClick={() => setStep("main")}
                            aria-label={t("location.back")}
                            title={t("location.back")}
                            className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-muted"
                        >
                            <ArrowLeft className="size-4 shrink-0" />
                        </button>
                    ) : null}
                    <DialogTitle className="min-w-0 truncate">
                        {step === "live" ? t("location.shareLive") : t("location.title")}
                    </DialogTitle>
                </div>

                <div className="relative overflow-hidden rounded-lg border border-border">
                    {point ? (
                        <TileMap points={[{ ...point, live: step === "live" }]} height={180} zoom={16} />
                    ) : (
                        <div className="grid h-[180px] place-items-center bg-muted px-4 text-center text-sm text-muted-foreground">
                            {fix.state === "locating" ? (
                                <span className="flex items-center gap-2">
                                    <Loader2 className="size-4 shrink-0 animate-spin" />
                                    {t("location.locating")}
                                </span>
                            ) : (
                                <span className="flex flex-col items-center gap-2">
                                    <span>{problem}</span>
                                    <span className="flex flex-wrap justify-center gap-2">
                                        {/* A phone's WebView may report a lasting refusal as unanswered,
                                            so the app's settings stay one press away either way. */}
                                        {(fix.state === "denied" || fix.state === "dismissed") && phoneSettings ? (
                                            <Button
                                                size="sm"
                                                variant={fix.state === "denied" ? "primary" : "outline"}
                                                onClick={() => void phoneSettings.settings().catch(() => undefined)}
                                            >
                                                {t("location.openSettings")}
                                            </Button>
                                        ) : null}
                                        {fix.state !== "unsupported" && fix.state !== "insecure" ? (
                                            <Button
                                                size="sm"
                                                variant={fix.state === "dismissed" ? "primary" : "outline"}
                                                onClick={ask}
                                            >
                                                {fix.state === "dismissed" ? t("location.allow") : t("location.tryAgain")}
                                            </Button>
                                        ) : null}
                                    </span>
                                </span>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                    {step === "main" ? (
                        <>
                            <Row
                                icon={<Crosshair className="size-5 shrink-0" />}
                                title={t("location.sendCurrent")}
                                detail={
                                    point?.accuracy
                                        ? t("location.accurateTo", { meters: String(point.accuracy) })
                                        : undefined
                                }
                                disabled={!point || busy}
                                onClick={() => point && void send({ mode: "pin", point })}
                            />
                            <Row
                                icon={<Radio className="size-5 shrink-0" />}
                                title={t("location.shareLive")}
                                detail={t("location.shareLiveHint")}
                                disabled={!point || busy}
                                onClick={() => setStep("live")}
                            />
                            {allowRequest ? (
                                <Row
                                    icon={<MapPinned className="size-5 shrink-0" />}
                                    title={t("location.request")}
                                    detail={t("location.requestHint")}
                                    disabled={busy}
                                    onClick={() => void send({ mode: "request" })}
                                />
                            ) : null}

                            <form
                                className="mt-1 flex min-w-0 items-center gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void search();
                                }}
                            >
                                <Input
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    placeholder={t("location.searchNearby")}
                                    aria-label={t("location.searchNearby")}
                                    disabled={!point}
                                    maxLength={120}
                                    className="min-w-0 flex-1"
                                />
                                <Button
                                    type="submit"
                                    size="sm"
                                    variant="outline"
                                    disabled={!point || query.trim().length < 2 || searching}
                                    aria-label={t("location.search")}
                                    title={t("location.search")}
                                >
                                    {searching ? (
                                        <Loader2 className="size-4 shrink-0 animate-spin" />
                                    ) : (
                                        <Search className="size-4 shrink-0" />
                                    )}
                                </Button>
                            </form>
                            {places && places.length === 0 && !searching ? (
                                <p className="px-1 text-sm text-muted-foreground">{t("location.noPlaces")}</p>
                            ) : null}
                            {places?.map((place) => (
                                <Row
                                    key={`${place.latitude},${place.longitude},${place.name}`}
                                    icon={<MapPin className="size-5 shrink-0" />}
                                    title={place.name}
                                    detail={[distance(place.meters, t), place.address].filter(Boolean).join(" · ")}
                                    disabled={busy}
                                    onClick={() =>
                                        void send({
                                            mode: "place",
                                            point: { latitude: place.latitude, longitude: place.longitude, accuracy: null },
                                            name: place.name,
                                            address: place.address
                                        })
                                    }
                                />
                            ))}
                        </>
                    ) : (
                        <>
                            <div role="radiogroup" aria-label={t("location.forHowLong")} className="grid grid-cols-3 gap-2">
                                {core.LIVE_LOCATION_MINUTES.map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        role="radio"
                                        aria-checked={minutes === value}
                                        onClick={() => setMinutes(value)}
                                        className={cn(
                                            "min-w-0 truncate rounded-lg border px-2 py-2 text-sm",
                                            minutes === value
                                                ? "border-primary bg-primary/10 text-foreground"
                                                : "border-border hover:bg-muted"
                                        )}
                                    >
                                        {lengthLabel(value, t)}
                                    </button>
                                ))}
                            </div>
                            <Input
                                value={comment}
                                onChange={(event) => setComment(event.target.value)}
                                placeholder={t("location.addComment")}
                                aria-label={t("location.addComment")}
                                maxLength={core.MAX_LOCATION_COMMENT}
                            />
                            <p className="text-xs text-muted-foreground">{t("location.liveNote")}</p>
                            <Button
                                disabled={!point || busy}
                                onClick={() => point && void send({ mode: "live", point, minutes, comment })}
                            >
                                {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Navigation className="size-4 shrink-0" />}
                                <span className="min-w-0 truncate">{t("location.startSharing")}</span>
                            </Button>
                        </>
                    )}
                    {error ? (
                        <p role="alert" className="px-1 text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

type T = ReturnType<typeof useTranslations<"chat">>;

/** "15 min", "1 hour", "8 hours". */
export function lengthLabel(minutes: number, t: T): string {
    return minutes < 60
        ? t("location.minutes", { count: minutes })
        : t("location.hours", { count: minutes / 60 });
}

function distance(meters: number, t: T): string {
    return meters < 1000
        ? t("location.meters", { meters: String(meters) })
        : t("location.kilometers", { km: (meters / 1000).toFixed(1) });
}

function Row({
    icon,
    title,
    detail,
    disabled,
    onClick
}: {
    icon: React.ReactNode;
    title: string;
    detail?: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-muted disabled:opacity-50"
        >
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">{icon}</span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" title={title}>
                    {title}
                </span>
                {detail ? (
                    <span className="truncate text-xs text-muted-foreground" title={detail}>
                        {detail}
                    </span>
                ) : null}
            </span>
        </button>
    );
}
