"use client";

/**
 * A camera as somebody holding its link sees it: its name and the live
 * picture, nothing else. Opening the page is one use of the link; the server
 * answers with a watch id and every picture after that rides on it (see
 * `lib/guest-camera`). Plain video, MP4 first or HLS on Apple, with a still
 * underneath until it starts.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { usePlacesT } from "../use-places-t";

function prefersHls(): boolean {
    if (typeof document === "undefined") return false;
    return document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
}

type Opened = { watch?: string; error?: string };

/** One open per token for the life of this page, so an effect run twice (React
 *  does that in development) never spends two uses. */
const opened = new Map<string, Promise<Opened>>();

function openWatch(token: string, cameraId?: string): Promise<Opened> {
    const key = `${token}:${cameraId ?? ""}`;
    let pending = opened.get(key);
    if (!pending) {
        const query = cameraId ? `?camera=${encodeURIComponent(cameraId)}` : "";
        pending = fetch(`/api/home/keys/${token}/watch${query}`, { method: "POST" })
            .then((response) => response.json() as Promise<Opened>)
            .catch(() => ({}));
        opened.set(key, pending);
    }
    return pending;
}

export function GuestCameraView({
    token,
    name,
    until,
    note,
    cameraId,
    onPress = false
}: {
    token: string;
    name: string;
    until: string | null;
    note: string;
    /** Which camera, on a room's link. */
    cameraId?: string;
    /** Wait for a press before opening (and spending a use): a room shows
     *  several cameras and the guest may want one of them. */
    onPress?: boolean;
}) {
    const [started, setStarted] = useState(!onPress);
    const t = usePlacesT();
    const [watch, setWatch] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [hls, setHls] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!started) return;
        let gone = false;
        setHls(prefersHls());
        void (async () => {
            const body = await openWatch(token, cameraId);
            if (gone) return;
            if (body.watch) setWatch(body.watch);
            // The server's sentence is already in the reader's language; a
            // missing one is said here, at render.
            else setError(body.error ?? "closed");
        })();
        return () => {
            gone = true;
        };
        // Once per page: every run is one use of the link, so this must not
        // depend on anything that changes while the page is open.
    }, [token, cameraId, started]);

    const base = watch ? `/api/home/keys/${token}/watch/${watch}` : null;
    const src = base ? (hls ? `${base}/hls/stream.m3u8?q=main` : `${base}/stream?q=main`) : null;

    return (
        <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
            <h1 className="min-w-0 truncate text-base font-medium" title={name}>
                {name}
            </h1>
            {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
            <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
                {src && !failed ? (
                    <video
                        key={src}
                        className="size-full object-contain"
                        src={src}
                        poster={`${base}/snapshot`}
                        autoPlay
                        muted
                        playsInline
                        controls
                        aria-label={t("guestCamera.live", { name })}
                        onError={() => {
                            // The other whole-file format once, then a sentence.
                            if (!hls) setHls(true);
                            else setFailed(true);
                        }}
                    />
                ) : error || failed ? (
                    <p
                        role="alert"
                        className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white"
                    >
                        {error === "closed"
                            ? t("guestCamera.closed")
                            : error || t("guestCamera.offline")}
                    </p>
                ) : !started ? (
                    <button
                        type="button"
                        className="absolute inset-0 flex items-center justify-center text-sm font-medium text-white hover:bg-white/10"
                        onClick={() => setStarted(true)}
                    >
                        {t("guestCamera.watch")}
                    </button>
                ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-white">
                        <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />
                        <span className="sr-only">{t("guestCamera.opening")}</span>
                    </span>
                )}
            </div>
            {until ? (
                <p className="text-xs text-muted-foreground">
                    {t("guest.until", { when: new Date(until).toLocaleString() })}
                </p>
            ) : null}
        </section>
    );
}
