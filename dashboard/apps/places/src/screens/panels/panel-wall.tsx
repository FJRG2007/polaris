"use client";

/**
 * A panel full screen, for a tablet on the wall.
 *
 * What wall-mounted dashboards converged on (Home Assistant's kiosk setups,
 * Fully Kiosk Browser): nothing around the cards, a screen that stays on,
 * dark at night if asked, and a live channel that comes back by itself. The
 * screen is kept on with the Screen Wake Lock API, taken again whenever the
 * page is shown (the browser drops it when hidden); where the API is missing,
 * a muted, silent video of a blank canvas plays instead, which is what keeps
 * older tablets from sleeping.
 */

import { isNight } from "./panel-state";
import { Button, cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import type { PanelCard } from "../../lib/panel-layout";
import type { DeviceView } from "../../lib/device-kinds";
import { Maximize, Minimize, Moon, Sun, WifiOff } from "lucide-react";
import { PanelBoard, type BoardAccess, type BoardRoom } from "./panel-board";

const NIGHT_KEY = "polaris.wall.nightDark";

/** Keep the screen on while this is mounted. Says whether it could. */
function useScreenAwake(): boolean {
    const [awake, setAwake] = useState(false);
    useEffect(() => {
        let lock: { release: () => Promise<void> } | null = null;
        let video: HTMLVideoElement | null = null;
        let gone = false;
        const wakeLock = (
            navigator as Navigator & {
                wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
            }
        ).wakeLock;
        const take = async () => {
            if (gone || document.visibilityState !== "visible") return;
            if (wakeLock) {
                try {
                    lock = await wakeLock.request("screen");
                    setAwake(true);
                    return;
                } catch {
                    // Refused (battery saver, no user gesture yet): fall back.
                }
            }
            if (video) return;
            try {
                const canvas = document.createElement("canvas");
                canvas.width = 2;
                canvas.height = 2;
                const stream = (
                    canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }
                ).captureStream?.(1);
                if (!stream) return;
                video = document.createElement("video");
                video.muted = true;
                video.playsInline = true;
                video.loop = true;
                video.setAttribute("aria-hidden", "true");
                video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
                video.srcObject = stream;
                document.body.appendChild(video);
                await video.play();
                setAwake(true);
            } catch {
                setAwake(false);
            }
        };
        const visibility = () => {
            if (document.visibilityState === "visible") void take();
        };
        void take();
        document.addEventListener("visibilitychange", visibility);
        // A first touch is a user gesture, which some browsers want first.
        window.addEventListener("pointerdown", visibility, { once: true });
        return () => {
            gone = true;
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("pointerdown", visibility);
            void lock?.release().catch(() => undefined);
            video?.pause();
            video?.remove();
        };
    }, []);
    return awake;
}

/** Dark from nine at night to seven in the morning, while asked for. The
 *  theme's tokens are on the root element, so that is where it is switched;
 *  the reader's own theme comes back by day and when the wall closes. */
function useNightDark(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        const root = document.documentElement;
        const saved = ["light", "system"].filter((name) => root.classList.contains(name));
        const apply = () => {
            if (isNight(new Date())) root.classList.remove("light", "system");
            else for (const name of saved) root.classList.add(name);
        };
        apply();
        const timer = setInterval(apply, 60_000);
        return () => {
            clearInterval(timer);
            for (const name of saved) root.classList.add(name);
        };
    }, [enabled]);
}

function readNight(): boolean {
    try {
        return localStorage.getItem(NIGHT_KEY) === "1";
    } catch {
        return false;
    }
}

export function PanelWall({
    name,
    placeId,
    cards,
    devices,
    rooms,
    access
}: {
    name: string;
    placeId: string;
    cards: readonly PanelCard[];
    devices: readonly DeviceView[];
    rooms: readonly BoardRoom[];
    access: BoardAccess;
}) {
    const t = usePlacesT();
    const awake = useScreenAwake();
    const [night, setNight] = useState(false);
    const [online, setOnline] = useState(true);
    const [full, setFull] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => setNight(readNight()), []);
    useNightDark(night);
    useEffect(() => {
        const sync = () => setOnline(navigator.onLine);
        const screen = () => setFull(Boolean(document.fullscreenElement));
        sync();
        window.addEventListener("online", sync);
        window.addEventListener("offline", sync);
        document.addEventListener("fullscreenchange", screen);
        return () => {
            window.removeEventListener("online", sync);
            window.removeEventListener("offline", sync);
            document.removeEventListener("fullscreenchange", screen);
        };
    }, []);
    // An error says itself for a few seconds and goes: nobody is at the wall
    // to dismiss it.
    useEffect(() => {
        if (!error) return;
        const timer = setTimeout(() => setError(""), 6000);
        return () => clearTimeout(timer);
    }, [error]);

    const toggleNight = () => {
        const next = !night;
        setNight(next);
        try {
            localStorage.setItem(NIGHT_KEY, next ? "1" : "0");
        } catch {
            // Private window: kept for this visit only.
        }
    };
    const toggleFull = () => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void document.documentElement.requestFullscreen?.().catch(() => undefined);
    };

    return (
        <div className="flex min-h-dvh flex-col gap-4 bg-background p-3 text-foreground sm:p-5">
            <header className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-xl font-semibold" title={name}>
                    {name}
                </h1>
                {!online ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-sm text-warning" role="status">
                        <WifiOff className="size-4" />
                        {t("panelWall.reconnecting")}
                    </span>
                ) : null}
                <span
                    className={cn(
                        "hidden shrink-0 text-xs sm:inline",
                        awake ? "text-muted-foreground" : "text-warning"
                    )}
                >
                    {awake ? t("panelWall.awake") : t("panelWall.awakeOff")}
                </span>
                <Button
                    type="button"
                    variant={night ? "primary" : "outline"}
                    aria-pressed={night}
                    aria-label={t("panelWall.nightDark")}
                    title={t("panelWall.nightDark")}
                    onClick={toggleNight}
                    className="size-11 shrink-0 p-0"
                >
                    {night ? <Moon className="size-5" /> : <Sun className="size-5" />}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    aria-label={full ? t("panelWall.exitFullscreen") : t("panelWall.fullscreen")}
                    title={full ? t("panelWall.exitFullscreen") : t("panelWall.fullscreen")}
                    onClick={toggleFull}
                    className="size-11 shrink-0 p-0"
                >
                    {full ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
                </Button>
            </header>
            {error ? (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            ) : null}
            {cards.length === 0 ? (
                <p className="py-16 text-center text-muted-foreground">{t("panelWall.empty")}</p>
            ) : (
                <PanelBoard
                    placeId={placeId}
                    cards={cards}
                    devices={devices}
                    rooms={rooms}
                    access={access}
                    onError={setError}
                />
            )}
        </div>
    );
}
