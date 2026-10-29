"use client";

/**
 * Choosing what to share, inside the desktop app, in Polaris's own design.
 *
 * A browser draws its own picker for `getDisplayMedia`. The desktop app has none,
 * and the box of plain buttons it used to show named every window by its title
 * and nothing else. This is the picker instead: every screen and window with a
 * picture of it, screens first, the sound switch where the computer can send
 * its sound (Windows), and Share only once something is picked. The pictures
 * are taken again every few seconds while it is open, so a window that changed
 * looks the way it does now.
 *
 * `pickDesktopShare` opens it and resolves with the pick, or null when it was
 * closed; the host is mounted once, by the call (`DesktopSharePickerHost`). The
 * pick is handed to the app just before `getDisplayMedia` runs (see
 * `openScreen`), from the press on Share, so the browser still sees the click
 * it requires.
 */

import { Monitor, AppWindow } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DesktopShareSource, DesktopShareSources, PolarisDesktop } from "@/lib/desktop-bridge";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";

/** How often the pictures are taken again while the picker is open. */
const REFRESH_MS = 4_000;

export interface DesktopSharePick {
    readonly id: string;
    readonly sound: boolean;
}

interface Request {
    /** Which opening this is, so a second one starts from a clean picker. */
    readonly id: number;
    readonly bridge: PolarisDesktop;
    /** The list already read, drawn at once while the next one is taken. */
    readonly first: DesktopShareSources;
    readonly resolve: (pick: DesktopSharePick | null) => void;
}

let open: Request | null = null;
let opened = 0;
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
export function pickDesktopShare(
    bridge: PolarisDesktop,
    first: DesktopShareSources
): Promise<DesktopSharePick | null> {
    open?.resolve(null);
    return new Promise((resolve) => {
        opened += 1;
        open = { id: opened, bridge, first, resolve };
        changed();
    });
}

function settle(pick: DesktopSharePick | null): void {
    const request = open;
    open = null;
    changed();
    request?.resolve(pick);
}

export function DesktopSharePickerHost() {
    const request = useSyncExternalStore(
        subscribe,
        () => open,
        () => null
    );
    return request ? <Picker key={request.id} request={request} /> : null;
}

function Picker({ request }: { request: Request }) {
    const t = useTranslations("chat");
    const [sources, setSources] = useState<readonly DesktopShareSource[]>(request.first.sources);
    const [soundAvailable, setSoundAvailable] = useState(request.first.sound);
    const [selected, setSelected] = useState<string | null>(null);
    const [sound, setSound] = useState(true);
    const [tab, setTab] = useState<"screen" | "window">("screen");

    useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async () => {
            const listed = await request.bridge.shareSources?.().catch(() => null);
            // A refresh that fails keeps the pictures already on screen.
            if (!live || !listed) return;
            setSources(listed.sources);
            setSoundAvailable(listed.sound);
            timer = setTimeout(() => void read(), REFRESH_MS);
        };
        timer = setTimeout(() => void read(), REFRESH_MS);
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, [request]);

    const screens = sources.filter((source) => source.kind === "screen");
    const windows = sources.filter((source) => source.kind === "window");
    const shown = tab === "screen" ? screens : windows;
    // A pick whose window closed while the picker was open is no pick at all.
    const chosen = sources.some((source) => source.id === selected) ? selected : null;

    const share = (id = chosen) => {
        if (!id) return;
        settle({ id, sound: soundAvailable && sound });
    };

    return (
        <Dialog open onOpenChange={(next) => !next && settle(null)}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{t("sharePicker.title")}</DialogTitle>
                    <DialogDescription>{t("sharePicker.description")}</DialogDescription>
                </DialogHeader>
                <div role="tablist" aria-label={t("sharePicker.title")} className="flex gap-1">
                    {(["screen", "window"] as const).map((kind) => (
                        <button
                            key={kind}
                            type="button"
                            role="tab"
                            aria-selected={tab === kind}
                            onClick={() => setTab(kind)}
                            className={cn(
                                "rounded-md px-3 py-1.5 text-sm",
                                tab === kind
                                    ? "bg-muted font-medium text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {kind === "screen"
                                ? t("sharePicker.screens", { count: screens.length })
                                : t("sharePicker.windows", { count: windows.length })}
                        </button>
                    ))}
                </div>
                <div role="tabpanel" className="max-h-[55vh] min-h-40 overflow-y-auto">
                    {shown.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {tab === "screen" ? t("sharePicker.noScreens") : t("sharePicker.noWindows")}
                        </p>
                    ) : (
                        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                            {shown.map((source) => (
                                <li key={source.id} className="min-w-0">
                                    <button
                                        type="button"
                                        aria-pressed={chosen === source.id}
                                        onClick={() => setSelected(source.id)}
                                        onDoubleClick={() => share(source.id)}
                                        className={cn(
                                            "flex w-full min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 text-left",
                                            chosen === source.id
                                                ? "border-primary ring-2 ring-primary/40"
                                                : "border-border hover:border-muted-foreground/40"
                                        )}
                                    >
                                        <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted">
                                            {source.thumbnail ? (
                                                // eslint-disable-next-line @next/next/no-img-element -- a data URL the app took a moment ago
                                                <img src={source.thumbnail} alt="" className="h-full w-full object-contain" />
                                            ) : source.kind === "screen" ? (
                                                <Monitor className="size-6 shrink-0 text-muted-foreground" aria-hidden />
                                            ) : (
                                                <AppWindow className="size-6 shrink-0 text-muted-foreground" aria-hidden />
                                            )}
                                        </span>
                                        <span className="flex min-w-0 items-center gap-1.5 px-0.5">
                                            {source.icon ? (
                                                // eslint-disable-next-line @next/next/no-img-element -- the program's own icon, a data URL
                                                <img src={source.icon} alt="" className="size-4 shrink-0" />
                                            ) : null}
                                            <span className="min-w-0 truncate text-xs" title={source.name}>
                                                {source.name || t("sharePicker.untitled")}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    {soundAvailable ? (
                        <div className="flex items-center gap-2 text-sm">
                            <Switch
                                checked={sound}
                                onChange={setSound}
                                aria-label={t("sharePicker.sound")}
                            />
                            <span>{t("sharePicker.sound")}</span>
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
