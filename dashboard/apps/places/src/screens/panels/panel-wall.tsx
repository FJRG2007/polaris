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
 *
 * Each panel carries its own look (`PanelStyle`): a theme, an accent, how
 * tightly the cards sit, a background, and how long the wall waits without a
 * touch before the screensaver (`panel-screensaver`) takes over.
 */

import { wallSurface, wallTheme } from "./panel-state";
import { Button, cn } from "@polaris/ui";
import { useEffect, useState, type CSSProperties } from "react";
import { usePlacesT } from "../use-places-t";
import type { ListRoom } from "../../lib/panel-list";
import type { DeviceView } from "../../lib/device-kinds";
import { PanelScreensaver, useIdle } from "./panel-screensaver";
import { usePanelWeather } from "./panel-weather";
import type { PanelCard, PanelStyle, PanelTheme } from "../../lib/panel-layout";
import { LayoutGrid, List, Maximize, Minimize, Moon, Sun, WifiOff } from "lucide-react";
import type { CameraView } from "../../lib/cameras";
import type { PanelAutomation } from "../../lib/panels";
import type { GuestPanelCamera } from "../../lib/guest-key";
import { PanelBoard, type BoardAccess, type BoardRoom } from "./panel-board";

const NIGHT_KEY = "polaris.wall.nightDark";
const VIEW_KEY = "polaris.wall.view:";

/** Keep the screen on while this is mounted. Says whether it could. */
function useScreenAwake(): boolean {
    const [awake, setAwake] = useState(false);
    useEffect(() => {
        let lock: { release: () => Promise<void> } | null = null;
        let video: HTMLVideoElement | null = null;
        let gone = false;
        const wakeLock = (
            navigator as Navigator & {
                wakeLock?: {
                    request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
                };
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
                video.style.cssText =
                    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
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

/** The panel's theme, and dark from nine at night to seven in the morning
 *  while asked for (`wallTheme`). The theme's tokens are on the root element,
 *  so that is where it is switched; the reader's own theme comes back when
 *  the wall closes. */
function useWallTheme(theme: PanelTheme, nightDark: boolean): void {
    useEffect(() => {
        if (theme === "auto" && !nightDark) return;
        const root = document.documentElement;
        const saved = ["light", "system"].filter((name) => root.classList.contains(name));
        const restore = () => {
            root.classList.remove("light", "system");
            for (const name of saved) root.classList.add(name);
        };
        const apply = () => {
            const now = wallTheme(theme, nightDark, new Date());
            if (now === "auto") return restore();
            root.classList.remove("light", "system");
            if (now === "light") root.classList.add("light");
        };
        apply();
        const timer = setInterval(apply, 60_000);
        return () => {
            clearInterval(timer);
            restore();
        };
    }, [theme, nightDark]);
}

function readView(id: string): "grid" | "list" {
    try {
        return localStorage.getItem(VIEW_KEY + id) === "list" ? "list" : "grid";
    } catch {
        return "grid";
    }
}

function readNight(): boolean {
    try {
        return localStorage.getItem(NIGHT_KEY) === "1";
    } catch {
        return false;
    }
}

export function PanelWall({
    id,
    name,
    style,
    weatherUrl,
    roomLabels,
    placeId,
    cards,
    devices,
    rooms,
    cameras,
    guestCameras,
    automations,
    access
}: {
    id: string;
    name: string;
    style: PanelStyle;
    /** Where the wall asks for the weather at its place. */
    weatherUrl: string;
    roomLabels?: readonly ListRoom[];
    placeId: string;
    cards: readonly PanelCard[];
    devices: readonly DeviceView[];
    rooms: readonly BoardRoom[];
    cameras?: readonly CameraView[];
    guestCameras?: readonly GuestPanelCamera[];
    automations?: readonly PanelAutomation[];
    access: BoardAccess;
}) {
    const t = usePlacesT();
    const awake = useScreenAwake();
    const [night, setNight] = useState(false);
    const [online, setOnline] = useState(true);
    const [full, setFull] = useState(false);
    const [error, setError] = useState("");
    const [view, setView] = useState<"grid" | "list">("grid");
    useEffect(() => {
        setNight(readNight());
        setView(readView(id));
    }, [id]);
    useWallTheme(style.theme, night);
    const weather = usePanelWeather(
        weatherUrl,
        style.screensaver > 0 || cards.some((card) => card.type === "weather")
    );
    const { idle, wake } = useIdle(style.screensaver);
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
    const chooseView = (next: "grid" | "list") => {
        setView(next);
        try {
            localStorage.setItem(VIEW_KEY + id, next);
        } catch {
            // Private window: kept for this visit only.
        }
    };
    const toggleFull = () => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void document.documentElement.requestFullscreen?.().catch(() => undefined);
    };

    return (
        <div
            className="flex min-h-dvh flex-col gap-4 bg-background p-3 text-foreground sm:p-5"
            style={wallSurface(style) as CSSProperties}
        >
            <header className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-xl font-semibold" title={name}>
                    {name}
                </h1>
                {!online ? (
                    <span
                        className="flex shrink-0 items-center gap-1.5 text-sm text-warning"
                        role="status"
                    >
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
                {devices.length > 0 ? (
                    <div
                        className="flex shrink-0 items-center gap-1"
                        role="group"
                        aria-label={t("panelWall.view")}
                    >
                        <Button
                            type="button"
                            variant={view === "grid" ? "primary" : "outline"}
                            aria-pressed={view === "grid"}
                            aria-label={t("panelWall.viewGrid")}
                            title={t("panelWall.viewGrid")}
                            onClick={() => chooseView("grid")}
                            className="size-11 shrink-0 p-0"
                        >
                            <LayoutGrid className="size-5" />
                        </Button>
                        <Button
                            type="button"
                            variant={view === "list" ? "primary" : "outline"}
                            aria-pressed={view === "list"}
                            aria-label={t("panelWall.viewList")}
                            title={t("panelWall.viewList")}
                            onClick={() => chooseView("list")}
                            className="size-11 shrink-0 p-0"
                        >
                            <List className="size-5" />
                        </Button>
                    </div>
                ) : null}
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
                <p
                    role="alert"
                    className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
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
                    cameras={cameras}
                    guestCameras={guestCameras}
                    automations={automations}
                    access={access}
                    onError={setError}
                    view={view}
                    density={style.density}
                    weather={weather}
                    roomLabels={roomLabels}
                />
            )}
            {idle ? <PanelScreensaver weather={weather} onWake={wake} /> : null}
        </div>
    );
}
