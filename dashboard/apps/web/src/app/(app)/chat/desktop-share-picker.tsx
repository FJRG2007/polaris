"use client";

/**
 * Choosing what to share, inside the desktop app, in Polaris's own design.
 *
 * A browser draws its own picker for `getDisplayMedia`. The desktop app has none,
 * and the box of plain buttons it used to show named every window by its title
 * and nothing else. This is the picker instead, in the three groups Discord's has:
 * applications (windows), entire screens, and capture devices - a capture card
 * or a camera, shared as the screen. A picture of each window and screen, the
 * sound switch where the computer can send its sound (Windows) or the device
 * has its own, and Share only once something is picked.
 *
 * It opens the moment it is asked for: listing what can be shared costs the
 * app most of a second on Windows, more with pictures. So it draws the last
 * list it saw (or placeholder tiles), asks for names first and pictures right
 * after, and takes the pictures again every few seconds while it is open - of
 * the tab on screen only, since every capture stalls the compositor on Windows
 * and filming forty windows to draw the screens tab froze the pointer.
 *
 * A tile is the press: it shares at once. The bar under the tiles says how the
 * stream will go out - its mode, resolution and frame rate - with SD/HD and the
 * rest of the stream's settings in the gear beside it (`stream-shape`).
 *
 * `pickDesktopShare` opens it and resolves with the pick, or null when it was
 * closed; the host is mounted once, by the call (`DesktopSharePickerHost`). A
 * screen or window pick is handed to the app just before `getDisplayMedia` runs
 * (see `openScreen`), from the press on Share, so the browser still sees the
 * click it requires.
 */

import { AppWindow, Check, Monitor, Settings2, Video } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DesktopShareSources, PolarisDesktop } from "@/lib/desktop-bridge";
import {
    STREAM_FRAME_RATES,
    STREAM_PRESETS,
    STREAM_RESOLUTIONS,
    modeOf,
    setStreamPrefs,
    useStreamPrefs
} from "./stream-shape";
import { DROPDOWN_KIT, MenuRadio, MenuToggle, reshape, resolutionLabel } from "./share-stream-menu";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    SegmentedControl,
    Skeleton
} from "@polaris/ui";

/** How often the pictures are taken again while the picker is open. Each
 *  round films every window on the computer, which costs the app a second or
 *  more on Windows: a round every 4 s kept it busy most of the time. */
const REFRESH_MS = 10_000;
/** Placeholder tiles drawn while the first list is on its way. */
const PLACEHOLDERS = 6;

/** What was picked: a screen or a window the app shares, a capture device the
 *  page opens itself, or the app's own picker (it listed nothing). */
export type DesktopSharePick =
    | { readonly kind: "source"; readonly id: string; readonly sound: boolean }
    | { readonly kind: "device"; readonly deviceId: string; readonly audioId: string | null }
    | { readonly kind: "system" };

type Tab = "window" | "screen" | "device";

/** A camera or capture card, with the audio input that is part of it. */
export interface CaptureDevice {
    readonly id: string;
    readonly name: string;
    readonly audioId: string | null;
}

interface Request {
    /** Which opening this is, so a second one starts from a clean picker. */
    readonly id: number;
    readonly bridge: PolarisDesktop;
    readonly resolve: (pick: DesktopSharePick | null) => void;
}

let open: Request | null = null;
let opened = 0;
/** The last list read, drawn at once the next time the picker opens. */
let lastListed: DesktopShareSources | null = null;
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Whether a host is mounted to draw the picker. */
export function canPickDesktopShare(): boolean {
    return listeners.size > 0;
}

/** Open the picker. Resolves with what was chosen, or null when it was closed. */
export function pickDesktopShare(bridge: PolarisDesktop): Promise<DesktopSharePick | null> {
    open?.resolve(null);
    return new Promise((resolve) => {
        opened += 1;
        open = { id: opened, bridge, resolve };
        changed();
    });
}

function settle(pick: DesktopSharePick | null): void {
    const request = open;
    open = null;
    changed();
    request?.resolve(pick);
}

/**
 * Keep the pictures already on screen for a list read without them, so the
 * names-only answer does not blank tiles the last list had filled.
 */
export function keepPictures(
    next: DesktopShareSources,
    previous: DesktopShareSources | null
): DesktopShareSources {
    if (!previous) return next;
    const before = new Map(previous.sources.map((source) => [source.id, source]));
    return {
        ...next,
        sources: next.sources.map((source) => {
            const old = before.get(source.id);
            return old && !source.thumbnail
                ? { ...source, thumbnail: old.thumbnail, icon: source.icon ?? old.icon }
                : source;
        })
    };
}

/**
 * Put a listing of one kind - the tab whose pictures were just taken - in
 * place of that kind, keeping what is known of the other. Screens first. An
 * app older than one-kind listings sends both; only the asked kind is taken.
 */
export function mergeKind(
    next: DesktopShareSources,
    previous: DesktopShareSources | null,
    kind: "screen" | "window"
): DesktopShareSources {
    const sources = [
        ...(previous?.sources ?? []).filter((source) => source.kind !== kind),
        ...next.sources.filter((source) => source.kind === kind)
    ];
    return {
        ...next,
        sources: [
            ...sources.filter((source) => source.kind === "screen"),
            ...sources.filter((source) => source.kind !== "screen")
        ]
    };
}

/**
 * The cameras and capture cards, each with the audio input of the same device.
 * Windows lists "default" and "communications" aliases beside the real inputs,
 * in the same group, so those are never the match.
 */
export function captureDevices(devices: readonly MediaDeviceInfo[]): CaptureDevice[] {
    const audio = devices.filter(
        (device) =>
            device.kind === "audioinput" &&
            device.deviceId !== "default" &&
            device.deviceId !== "communications"
    );
    return devices
        .filter((device) => device.kind === "videoinput" && device.deviceId)
        .map((device) => ({
            id: device.deviceId,
            name: device.label.trim(),
            audioId:
                (device.groupId &&
                    audio.find((input) => input.groupId === device.groupId)?.deviceId) ||
                null
        }));
}

export function DesktopSharePickerHost() {
    const request = useSyncExternalStore(
        subscribe,
        () => open,
        () => null
    );
    return request ? <Picker key={request.id} request={request} /> : null;
}

interface Tile {
    readonly id: string;
    readonly name: string;
    readonly picture: string | null;
    readonly icon: string | null;
    readonly fallback: typeof Monitor;
}

function Picker({ request }: { request: Request }) {
    const t = useTranslations("chat");
    const prefs = useStreamPrefs();
    const [listed, setListed] = useState<DesktopShareSources | null>(lastListed);
    const [devices, setDevices] = useState<readonly CaptureDevice[] | null>(null);
    const [sound, setSound] = useState(true);
    // Off until asked: a webcam's own microphone would send the voice twice.
    const [deviceSound, setDeviceSound] = useState(false);
    const [tab, setTab] = useState<Tab>("window");
    /** Read by the refresh, which outlives renders. */
    const tabRef = useRef<Tab>(tab);
    tabRef.current = tab;
    /** Take the pictures of the tab on screen now, set by the listing effect. */
    const picturesNow = useRef<(() => void) | null>(null);

    useEffect(() => {
        let live = true;
        let busy = false;
        let again = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pictures = async () => {
            if (timer) clearTimeout(timer);
            if (busy) {
                again = true;
                return;
            }
            const kind = tabRef.current;
            // Nobody is looking at pictures in a window that is not on screen,
            // and a device tab has none to take.
            if (kind !== "device" && document.visibilityState !== "hidden") {
                busy = true;
                const next = await request.bridge
                    .shareSources?.({ thumbnails: true, kind })
                    .catch(() => null);
                busy = false;
                if (!live) return;
                // A refresh that fails keeps the pictures already on screen.
                if (next) {
                    setListed((previous) => {
                        const merged = mergeKind(next, previous, kind);
                        lastListed = merged;
                        return merged;
                    });
                }
            }
            if (!live) return;
            if (again) {
                again = false;
                void pictures();
                return;
            }
            timer = setTimeout(() => void pictures(), REFRESH_MS);
        };
        void (async () => {
            const names = await request.bridge
                .shareSources?.({ thumbnails: false })
                .catch(() => null);
            if (!live) return;
            // No list at all: the app's own picker is the one to use.
            if (!names) {
                settle({ kind: "system" });
                return;
            }
            setListed((previous) => {
                const merged = keepPictures(names, previous);
                lastListed = merged;
                return merged;
            });
            picturesNow.current = () => void pictures();
            void pictures();
        })();
        return () => {
            live = false;
            picturesNow.current = null;
            if (timer) clearTimeout(timer);
        };
    }, [request]);

    // A tab opened shows its own pictures at once rather than at the next round.
    useEffect(() => {
        picturesNow.current?.();
    }, [tab]);

    useEffect(() => {
        const media = navigator.mediaDevices;
        if (!media?.enumerateDevices) {
            setDevices([]);
            return;
        }
        let live = true;
        const read = () => {
            media
                .enumerateDevices()
                .then((found) => {
                    if (live) setDevices(captureDevices(found));
                })
                .catch(() => {
                    if (live) setDevices([]);
                });
        };
        read();
        media.addEventListener("devicechange", read);
        return () => {
            live = false;
            media.removeEventListener("devicechange", read);
        };
    }, []);

    const soundAvailable = listed?.sound ?? false;
    const loading = tab === "device" ? devices === null : listed === null;
    const tiles: Tile[] =
        tab === "device"
            ? (devices ?? []).map((device, index) => ({
                  id: device.id,
                  name: device.name || t("sharePicker.untitledDevice", { number: index + 1 }),
                  picture: null,
                  icon: null,
                  fallback: Video
              }))
            : (listed?.sources ?? [])
                  .filter((source) => source.kind === tab)
                  .map((source) => ({
                      id: source.id,
                      name: source.name || t("sharePicker.untitled"),
                      picture: source.thumbnail,
                      icon: source.icon,
                      fallback: source.kind === "screen" ? Monitor : AppWindow
                  }));

    const share = (id: string) => {
        if (tab === "device") {
            const device = (devices ?? []).find((candidate) => candidate.id === id);
            if (device) {
                settle({
                    kind: "device",
                    deviceId: device.id,
                    audioId: deviceSound ? device.audioId : null
                });
            }
            return;
        }
        settle({ kind: "source", id, sound: soundAvailable && sound });
    };

    const empty =
        tab === "device"
            ? t("sharePicker.noDevices")
            : tab === "screen"
              ? t("sharePicker.noScreens")
              : t("sharePicker.noWindows");
    const action =
        tab === "device"
            ? t("sharePicker.shareDevice")
            : tab === "screen"
              ? t("sharePicker.shareScreen")
              : t("sharePicker.shareWindow");

    const shape = prefs.shape;
    const mode = shape ? modeOf(shape) : null;
    const definition =
        shape === null
            ? null
            : shape.resolution === "source" || shape.resolution > 720
              ? "hd"
              : "sd";
    const detail = shape
        ? [
              t(`streamQuality.modes.${modeOf(shape)}.hint`),
              resolutionLabel(t, shape.resolution),
              t("streamQuality.fps", { fps: shape.frameRate })
          ].join(" - ")
        : t("callRoom.dropsWhenTheConnectionStruggles");

    return (
        <Dialog open onOpenChange={(next) => !next && settle(null)}>
            <DialogContent className="max-w-3xl">
                <DialogTitle className="sr-only">{t("sharePicker.title")}</DialogTitle>
                <DialogDescription className="sr-only">
                    {t("sharePicker.description")}
                </DialogDescription>
                <div className="flex min-w-0 flex-col gap-4">
                    <SegmentedControl<Tab>
                        aria-label={t("sharePicker.title")}
                        value={tab}
                        onValueChange={setTab}
                        className="self-start"
                        options={[
                            { value: "window", label: t("sharePicker.applications") },
                            { value: "screen", label: t("sharePicker.entireScreen") },
                            { value: "device", label: t("sharePicker.devices") }
                        ]}
                    />
                    <div className="max-h-[55vh] min-h-40 overflow-y-auto overscroll-contain">
                        {loading ? (
                            <ul
                                aria-busy
                                aria-label={t("sharePicker.loading")}
                                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
                            >
                                {Array.from({ length: PLACEHOLDERS }, (_, index) => (
                                    <li key={index} className="flex min-w-0 flex-col gap-1.5 p-1.5">
                                        <Skeleton className="aspect-video w-full rounded-md" />
                                        <Skeleton className="h-3 w-2/3" />
                                    </li>
                                ))}
                            </ul>
                        ) : tiles.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{empty}</p>
                        ) : (
                            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                                {tiles.map((tile) => (
                                    <li key={tile.id} className="min-w-0">
                                        <button
                                            type="button"
                                            onClick={() => share(tile.id)}
                                            aria-label={`${action}: ${tile.name}`}
                                            className="group flex w-full min-w-0 flex-col gap-1.5 rounded-lg border border-border p-1.5 text-start transition-colors hover:border-primary focus-visible:border-primary"
                                        >
                                            <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted">
                                                {tile.picture ? (
                                                    // eslint-disable-next-line @next/next/no-img-element -- a data URL the app took a moment ago
                                                    <img
                                                        src={tile.picture}
                                                        alt=""
                                                        className="h-full w-full object-contain"
                                                    />
                                                ) : (
                                                    <tile.fallback
                                                        className="size-6 shrink-0 text-muted-foreground"
                                                        aria-hidden
                                                    />
                                                )}
                                                <span
                                                    aria-hidden
                                                    className="absolute inset-0 flex items-center justify-center bg-background/70 text-sm font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                                >
                                                    <span className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground">
                                                        {action}
                                                    </span>
                                                </span>
                                            </span>
                                            <span className="flex min-w-0 items-center gap-1.5 px-0.5">
                                                {tile.icon ? (
                                                    // eslint-disable-next-line @next/next/no-img-element -- the program's own icon, a data URL
                                                    <img
                                                        src={tile.icon}
                                                        alt=""
                                                        className="size-4 shrink-0"
                                                    />
                                                ) : (
                                                    <tile.fallback
                                                        className="size-4 shrink-0 text-muted-foreground"
                                                        aria-hidden
                                                    />
                                                )}
                                                <span
                                                    className="min-w-0 truncate text-xs"
                                                    title={tile.name}
                                                >
                                                    {tile.name}
                                                </span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border pt-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                            {mode ? t(`streamQuality.modes.${mode}.name`) : t("callRoom.automatic")}
                        </span>
                        <span className="truncate text-xs text-muted-foreground" title={detail}>
                            {detail}
                        </span>
                    </div>
                    <SegmentedControl<"sd" | "hd">
                        aria-label={t("sharePicker.definition")}
                        size="sm"
                        value={definition}
                        onValueChange={(next) =>
                            setStreamPrefs({
                                shape: reshape(shape, { resolution: next === "hd" ? 1080 : 720 })
                            })
                        }
                        options={[
                            { value: "sd", label: t("sharePicker.sd") },
                            { value: "hd", label: t("sharePicker.hd") }
                        ]}
                    />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={t("sharePicker.settings")}
                                title={t("sharePicker.settings")}
                            >
                                <Settings2 className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="top" align="end" className="w-64">
                            <DropdownMenuLabel>{t("sharePicker.streamMode")}</DropdownMenuLabel>
                            <MenuRadio
                                kit={DROPDOWN_KIT}
                                on={mode === null}
                                onPick={() => setStreamPrefs({ shape: null })}
                            >
                                {t("callRoom.automatic")}
                            </MenuRadio>
                            {(["gaming", "screenshare"] as const).map((preset) => (
                                <MenuRadio
                                    key={preset}
                                    kit={DROPDOWN_KIT}
                                    on={mode === preset}
                                    onPick={() => setStreamPrefs({ shape: STREAM_PRESETS[preset] })}
                                >
                                    <span className="flex min-w-0 flex-col">
                                        <span>{t(`streamQuality.modes.${preset}.name`)}</span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {[
                                                t(`streamQuality.modes.${preset}.hint`),
                                                resolutionLabel(
                                                    t,
                                                    STREAM_PRESETS[preset].resolution
                                                ),
                                                t("streamQuality.fps", {
                                                    fps: STREAM_PRESETS[preset].frameRate
                                                })
                                            ].join(" - ")}
                                        </span>
                                    </span>
                                </MenuRadio>
                            ))}
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Check
                                        aria-hidden
                                        className={cn(
                                            "size-3.5 shrink-0",
                                            mode === "custom" ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    {t("streamQuality.modes.custom.name")}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-52">
                                    <DropdownMenuLabel>
                                        {t("streamQuality.frameRate")}
                                    </DropdownMenuLabel>
                                    {STREAM_FRAME_RATES.map((frameRate) => (
                                        <MenuRadio
                                            key={frameRate}
                                            kit={DROPDOWN_KIT}
                                            on={shape?.frameRate === frameRate}
                                            onPick={() =>
                                                setStreamPrefs({
                                                    shape: reshape(shape, { frameRate })
                                                })
                                            }
                                        >
                                            {t("streamQuality.fps", { fps: frameRate })}
                                        </MenuRadio>
                                    ))}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuLabel>
                                        {t("streamQuality.resolution")}
                                    </DropdownMenuLabel>
                                    {STREAM_RESOLUTIONS.map((resolution) => (
                                        <MenuRadio
                                            key={resolution}
                                            kit={DROPDOWN_KIT}
                                            on={shape?.resolution === resolution}
                                            onPick={() =>
                                                setStreamPrefs({
                                                    shape: reshape(shape, { resolution })
                                                })
                                            }
                                        >
                                            {resolutionLabel(t, resolution)}
                                        </MenuRadio>
                                    ))}
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            {(tab === "device" || soundAvailable) && <DropdownMenuSeparator />}
                            {tab === "device" ? (
                                <MenuToggle
                                    kit={DROPDOWN_KIT}
                                    on={deviceSound}
                                    onToggle={() => setDeviceSound(!deviceSound)}
                                >
                                    {t("sharePicker.deviceSound")}
                                </MenuToggle>
                            ) : soundAvailable ? (
                                <MenuToggle
                                    kit={DROPDOWN_KIT}
                                    on={!sound}
                                    onToggle={() => setSound(!sound)}
                                >
                                    {t("sharePicker.muteAudio")}
                                </MenuToggle>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    {t("sharePicker.advanced")}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-56">
                                    <MenuToggle
                                        kit={DROPDOWN_KIT}
                                        on={!prefs.showOwn}
                                        onToggle={() => setStreamPrefs({ showOwn: !prefs.showOwn })}
                                    >
                                        {t("sharePicker.hidePreview")}
                                    </MenuToggle>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </DialogContent>
        </Dialog>
    );
}
