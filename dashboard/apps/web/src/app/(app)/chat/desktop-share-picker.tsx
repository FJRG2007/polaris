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
 * after, and takes the pictures again every few seconds while it is open.
 *
 * `pickDesktopShare` opens it and resolves with the pick, or null when it was
 * closed; the host is mounted once, by the call (`DesktopSharePickerHost`). A
 * screen or window pick is handed to the app just before `getDisplayMedia` runs
 * (see `openScreen`), from the press on Share, so the browser still sees the
 * click it requires.
 */

import { AppWindow, Monitor, Video } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DesktopShareSources, PolarisDesktop } from "@/lib/desktop-bridge";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    SegmentedControl,
    Skeleton,
    Switch
} from "@polaris/ui";

/** How often the pictures are taken again while the picker is open. */
const REFRESH_MS = 4_000;
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
    const [listed, setListed] = useState<DesktopShareSources | null>(lastListed);
    const [devices, setDevices] = useState<readonly CaptureDevice[] | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [sound, setSound] = useState(true);
    // Off until asked: a webcam's own microphone would send the voice twice.
    const [deviceSound, setDeviceSound] = useState(false);
    const [tab, setTab] = useState<Tab>("window");

    useEffect(() => {
        let live = true;
        let first = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async (thumbnails: boolean) => {
            const next = await request.bridge.shareSources?.({ thumbnails }).catch(() => null);
            if (!live) return;
            if (!next) {
                // No list at all: the app's own picker is the one to use. A
                // refresh that fails keeps the pictures already on screen.
                if (first) settle({ kind: "system" });
                return;
            }
            first = false;
            setListed((previous) => {
                const merged = thumbnails ? next : keepPictures(next, previous);
                lastListed = merged;
                return merged;
            });
            timer = setTimeout(() => void read(true), thumbnails ? REFRESH_MS : 0);
        };
        void read(false);
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, [request]);

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
    // A pick whose window closed or whose device was unplugged while the picker
    // was open is no pick at all, and neither is one on another tab.
    const chosen = tiles.some((tile) => tile.id === selected) ? selected : null;
    const chosenDevice =
        tab === "device" ? ((devices ?? []).find((device) => device.id === chosen) ?? null) : null;

    const share = (id = chosen) => {
        if (!id) return;
        if (tab === "device") {
            const device = (devices ?? []).find((candidate) => candidate.id === id);
            if (device) {
                settle({ kind: "device", deviceId: device.id, audioId: deviceSound ? device.audioId : null });
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

    return (
        <Dialog open onOpenChange={(next) => !next && settle(null)}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{t("sharePicker.title")}</DialogTitle>
                    <DialogDescription>{t("sharePicker.description")}</DialogDescription>
                </DialogHeader>
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
                                            aria-pressed={chosen === tile.id}
                                            onClick={() => setSelected(tile.id)}
                                            onDoubleClick={() => share(tile.id)}
                                            className={cn(
                                                "flex w-full min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 text-left",
                                                chosen === tile.id
                                                    ? "border-primary ring-2 ring-primary/40"
                                                    : "border-border hover:border-muted-foreground/40"
                                            )}
                                        >
                                            <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted">
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
                                            </span>
                                            <span className="flex min-w-0 items-center gap-1.5 px-0.5">
                                                {tile.icon ? (
                                                    // eslint-disable-next-line @next/next/no-img-element -- the program's own icon, a data URL
                                                    <img
                                                        src={tile.icon}
                                                        alt=""
                                                        className="size-4 shrink-0"
                                                    />
                                                ) : null}
                                                <span className="min-w-0 truncate text-xs" title={tile.name}>
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
                <div className="flex flex-wrap items-center justify-between gap-3">
                    {tab !== "device" && soundAvailable ? (
                        <div className="flex items-center gap-2 text-sm">
                            <Switch
                                checked={sound}
                                onChange={setSound}
                                aria-label={t("sharePicker.sound")}
                            />
                            <span>{t("sharePicker.sound")}</span>
                        </div>
                    ) : chosenDevice?.audioId ? (
                        <div className="flex items-center gap-2 text-sm">
                            <Switch
                                checked={deviceSound}
                                onChange={setDeviceSound}
                                aria-label={t("sharePicker.deviceSound")}
                            />
                            <span>{t("sharePicker.deviceSound")}</span>
                        </div>
                    ) : (
                        <span />
                    )}
                    <div className="flex gap-2">
                        <Button type="button" variant="ghost" onClick={() => settle(null)}>
                            {t("sharePicker.cancel")}
                        </Button>
                        <Button
                            type="button"
                            aria-disabled={!chosen}
                            onClick={() => share()}
                            title={chosen ? undefined : t("sharePicker.pickFirst")}
                        >
                            {t("sharePicker.share")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
