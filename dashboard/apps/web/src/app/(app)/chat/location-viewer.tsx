"use client";

/**
 * The full map of a location on a phone, laid out the way WhatsApp opens one on
 * iOS: the map edge to edge, a dark see-through bar on top with a round back
 * button and the place's street address, the sender's pin with their name in a
 * bubble, and at the bottom a round Share, the Map | Hybrid | Satellite pill and
 * a round Directions. The quiet "Legal" credit sits in the corner above them.
 *
 * The address is read by the server from the message (`locationAddressAction`),
 * never from a point the page sends; until it comes, and if it never does, the
 * coordinates stand in.
 */

import { cn } from "@polaris/ui";
import * as actions from "./actions";
import { openLink } from "@/lib/open-link";
import { useEffect, useState } from "react";
import { MAP_STYLES } from "@/lib/map-layers";
import type { MapStyle } from "@/lib/map-layers";
import type { PlaceAddress } from "@/lib/chat/locations";
import { ChevronLeft, Navigation, Share } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { TileMap, type MapPoint } from "@/components/map/tile-map";
import { directionsUrl, mapsPlatform, placeUrl } from "@/lib/maps-links";
import { Dialog, DialogClose, DialogContent, DialogTitle, useToast } from "@polaris/ui";

const STYLE_LABEL = { map: "location.styleMap", hybrid: "location.styleHybrid", satellite: "location.styleSatellite" } as const;

/** Degrees as a person reads them: 37°07'48.0"N 4°40'12.0"W. Pure; exported for tests. */
export function readableCoordinates(latitude: number, longitude: number): string {
    const part = (value: number, positive: string, negative: string) => {
        const abs = Math.abs(value);
        const degrees = Math.floor(abs);
        const minutes = Math.floor((abs - degrees) * 60);
        const seconds = ((abs - degrees) * 60 - minutes) * 60;
        return `${degrees}°${String(minutes).padStart(2, "0")}'${seconds.toFixed(1).padStart(4, "0")}"${value < 0 ? negative : positive}`;
    };
    return `${part(latitude, "N", "S")} ${part(longitude, "E", "W")}`;
}

/** The street address of a message's location, asked once per open. */
export function usePlaceAddress(messageId: string, open: boolean): PlaceAddress | null {
    const [address, setAddress] = useState<PlaceAddress | null>(null);
    useEffect(() => {
        if (!open) return;
        let current = true;
        void actions
            .locationAddressAction(messageId)
            .then((result) => current && setAddress(result.address))
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [messageId, open]);
    return address;
}

/** Map | Hybrid | Satellite, as one floating pill. */
export function MapStyleSwitch({
    value,
    onChange,
    className
}: {
    value: MapStyle;
    onChange: (style: MapStyle) => void;
    className?: string;
}) {
    const t = useTranslations("chat");
    return (
        <div
            role="radiogroup"
            aria-label={t("location.mapStyle")}
            className={cn("flex min-w-0 items-center rounded-full p-1 shadow-lg backdrop-blur-md", className)}
        >
            {MAP_STYLES.map((style) => (
                <button
                    key={style}
                    type="button"
                    role="radio"
                    aria-checked={value === style}
                    onClick={() => onChange(style)}
                    className={cn(
                        "min-w-0 truncate rounded-full px-3 py-2 text-[15px] leading-5 transition-colors",
                        value === style ? "bg-black/45 font-medium" : "opacity-90 hover:opacity-100"
                    )}
                >
                    {t(STYLE_LABEL[style])}
                </button>
            ))}
        </div>
    );
}

/** Hands a maps link of the place to the phone's share sheet, or copies it. */
export function useSharePlace(): (point: MapPoint, title: string) => void {
    const t = useTranslations("chat");
    const toast = useToast();
    return (point, title) => {
        const url = placeUrl(point, mapsPlatform());
        if (typeof navigator.share === "function") {
            // A dismissed sheet rejects too; that is the reader's choice, not a failure.
            void navigator.share({ title, url }).catch(() => undefined);
            return;
        }
        void navigator.clipboard
            ?.writeText(url)
            .then(() => toast.show({ title: t("location.linkCopied") }))
            .catch(() => openLink(url));
    };
}

export function PhoneLocationViewer({
    open,
    onOpenChange,
    messageId,
    point,
    viewer,
    heading,
    callout,
    action
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    messageId: string;
    point: MapPoint;
    /** The reader's own position, when location is already allowed. */
    viewer: MapPoint | null;
    /** A place's own name, put above its address. */
    heading: string | null;
    callout: { title: string; detail?: string };
    /** The sender's Stop for a running live share. */
    action?: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const [style, setStyle] = useState<MapStyle>("map");
    const address = usePlaceAddress(messageId, open);
    const share = useSharePlace();
    const coordinates = readableCoordinates(point.latitude, point.longitude);
    const title = heading ?? address?.title ?? coordinates;
    const subtitle = heading
        ? (address ? [address.title, address.subtitle].filter(Boolean).join(", ") : coordinates)
        : address
          ? address.subtitle
          : `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
    const round =
        "grid size-12 shrink-0 place-items-center rounded-full bg-neutral-800/70 text-white shadow-lg backdrop-blur-md active:bg-neutral-700/80";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                phone="keep"
                showClose={false}
                aria-describedby={undefined}
                // Nothing lit up on open: the first stop would be the map's credit.
                onOpenAutoFocus={(event) => event.preventDefault()}
                className="inset-0 left-0 top-0 h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-neutral-900 p-0"
            >
                <TileMap
                    points={viewer ? [{ ...point, callout }, viewer] : [{ ...point, callout }]}
                    height="100%"
                    zoom={17}
                    controls
                    zoomButtons={false}
                    style={style}
                    className="absolute inset-0"
                    creditClassName="bottom-[calc(5rem+var(--safe-bottom))] start-4"
                />
                <div className="absolute inset-x-0 top-0 bg-neutral-900/85 pt-[var(--safe-top)] text-white backdrop-blur-md">
                    <div className="grid h-[4.5rem] grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-2 px-3">
                        <DialogClose
                            aria-label={t("location.back")}
                            className="grid size-12 place-items-center rounded-full bg-white/15 active:bg-white/25"
                        >
                            <ChevronLeft className="size-7 shrink-0" />
                        </DialogClose>
                        <div className="flex min-w-0 flex-col items-center text-center">
                            <DialogTitle className="w-full truncate text-[17px] font-semibold leading-6" title={title}>
                                {title}
                            </DialogTitle>
                            {subtitle ? (
                                <span className="w-full truncate text-[13px] leading-4 text-white/85" title={subtitle}>
                                    {subtitle}
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>
                {action ? (
                    <div className="absolute end-3 top-[calc(5.25rem+var(--safe-top))]">{action}</div>
                ) : null}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-4 pb-[calc(1rem+var(--safe-bottom))]">
                    <button
                        type="button"
                        aria-label={t("location.share")}
                        title={t("location.share")}
                        onClick={() => share(point, title)}
                        className={round}
                    >
                        <Share className="size-6 shrink-0" />
                    </button>
                    <MapStyleSwitch value={style} onChange={setStyle} className="bg-neutral-800/70 text-white" />
                    <button
                        type="button"
                        aria-label={t("location.directions")}
                        title={t("location.directions")}
                        onClick={() => openLink(directionsUrl(point, mapsPlatform()))}
                        className={round}
                    >
                        <Navigation className="size-6 shrink-0" />
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
