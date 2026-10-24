"use client";

/**
 * What a wall panel's cards draw: a device with every control it really has,
 * a room with its devices, and a clock. The controls are the devices screen's
 * own (`DeviceControls`), so a light offers a slider only when it dims, a
 * colour only when it is coloured, and a switch only when it switches.
 *
 * A camera card is the camera wall's own tile and viewer; an automation button
 * runs one automation; a sensor card is one reading, large. Places keeps no
 * history of readings (only the last one, `PlaceDeviceObservation`), so a
 * sensor card shows the reading now and when it last changed - no graph.
 */

import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    cn
} from "@polaris/ui";
import { Check, Loader2, Maximize2, Play } from "lucide-react";
import type { CameraView } from "../../lib/cameras";
import type { PanelAutomation } from "../../lib/panels";
import { CameraTile } from "../camera-tile";
import { GuestCameraView } from "../guest/guest-camera-view";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { hostUi } from "@polaris/app-host/client";
import { BatteryMeter } from "../devices/battery-meter";
import { DeviceControls, DeviceIcon, stateClass } from "../devices/device-panel";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

export interface CardActs {
    readonly canControl: boolean;
    readonly busy: { id: string; action: DeviceAction } | null;
    readonly onAct: (device: DeviceView, action: DeviceAction, command?: DeviceCommand) => void;
}

/** The frame every card sits in. */
function CardFrame({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                "flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-4",
                className
            )}
        >
            {children}
        </div>
    );
}

/** One device: its name, state and battery, and the controls it has. */
export function DeviceTile({ device, acts }: { device: DeviceView; acts: CardActs }) {
    const t = usePlacesT();
    const busy = acts.busy?.id === device.id ? acts.busy.action : null;
    return (
        <CardFrame>
            <div className="flex min-w-0 items-center gap-2">
                <DeviceIcon kind={device.kind} className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-base font-medium" title={device.name}>
                    {device.name}
                </span>
                <BatteryMeter device={device} large />
            </div>
            <Badge className={cn("w-fit shrink-0", stateClass(device))}>
                {kinds.badgeText(device, t)}
            </Badge>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <DeviceControls
                    device={device}
                    canControl={acts.canControl}
                    busy={busy}
                    onAct={(action, command) => acts.onAct(device, action, command)}
                    detailed
                />
            </div>
        </CardFrame>
    );
}

/** A room: each of its devices on a line, with the one control a line holds. */
export function RoomCard({
    name,
    devices,
    acts
}: {
    name: string;
    devices: readonly DeviceView[];
    acts: CardActs;
}) {
    const t = usePlacesT();
    return (
        <CardFrame>
            <h2 className="min-w-0 truncate text-base font-medium" title={name}>
                {name}
            </h2>
            {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("panels.roomEmpty")}</p>
            ) : (
                <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
                    {devices.map((device) => (
                        <li key={device.id} className="flex min-w-0 flex-wrap items-center gap-2">
                            <DeviceIcon
                                kind={device.kind}
                                className="size-4 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm" title={device.name}>
                                {device.name}
                            </span>
                            <BatteryMeter device={device} />
                            <DeviceControls
                                device={device}
                                canControl={acts.canControl}
                                busy={acts.busy?.id === device.id ? acts.busy.action : null}
                                onAct={(action, command) => acts.onAct(device, action, command)}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </CardFrame>
    );
}

/** The time and the date, in the reader's language. */
export function ClockCard() {
    const locale = hostUi.i18nProvider.useLocale();
    const [now, setNow] = useState<Date | null>(null);
    useEffect(() => {
        setNow(new Date());
        const timer = setInterval(() => setNow(new Date()), 15_000);
        return () => clearInterval(timer);
    }, []);
    return (
        <CardFrame className="items-center justify-center text-center">
            <span className="text-4xl font-semibold tabular-nums">
                {now
                    ? new Intl.DateTimeFormat(locale, {
                          hour: "2-digit",
                          minute: "2-digit"
                      }).format(now)
                    : "--:--"}
            </span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
                {now
                    ? new Intl.DateTimeFormat(locale, {
                          weekday: "long",
                          day: "numeric",
                          month: "long"
                      }).format(now)
                    : ""}
            </span>
        </CardFrame>
    );
}

/** A card whose device or room is gone. */
export function GoneCard() {
    const t = usePlacesT();
    return (
        <CardFrame className="justify-center">
            <p className="text-sm text-muted-foreground">{t("panels.cardGone")}</p>
        </CardFrame>
    );
}

/** A camera, live, as the camera wall draws it; pressed, it opens the viewer
 *  with every control the reader has. */
export function CameraCard({
    camera,
    live,
    canControl,
    idle,
    onOpen
}: {
    camera: CameraView;
    live: boolean;
    canControl: boolean;
    idle: boolean;
    onOpen: () => void;
}) {
    return (
        <div className="h-full min-h-0 min-w-0 overflow-hidden rounded-xl">
            <CameraTile
                key={`${camera.id}-${camera.privacy ? "private" : "public"}`}
                camera={camera}
                live={live}
                canControl={canControl}
                idle={idle}
                onOpen={onOpen}
            />
        </div>
    );
}

/** A camera through the panel's link: the live picture and nothing else - no
 *  movement, recordings or settings. Pressed, it fills the screen. */
export function GuestCameraCard({
    token,
    camera
}: {
    token: string;
    camera: { id: string; name: string; private: boolean };
}) {
    const t = usePlacesT();
    const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
        const card = event.currentTarget.parentElement;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void card?.requestFullscreen?.().catch(() => undefined);
    };
    return (
        <div className="relative h-full min-h-0 min-w-0 overflow-y-auto rounded-xl bg-card">
            <GuestCameraView
                token={token}
                cameraId={camera.id}
                name={camera.name}
                until={null}
                note=""
                initiallyPrivate={camera.private}
                onPress
                bare
            />
            <Button
                type="button"
                variant="outline"
                aria-label={t("panels.cameraFull", { name: camera.name })}
                title={t("panels.cameraFull", { name: camera.name })}
                onClick={toggle}
                className="absolute right-3 top-3 size-11 bg-background/90 p-0"
            >
                <Maximize2 className="size-5" />
            </Button>
        </div>
    );
}

/** How long "Started" stays on a button after a run was accepted. */
const STARTED_MS = 3000;

/**
 * One automation as a button. With `confirm`, a press asks first - for the
 * button that locks every door or turns the whole house off. Somebody who may
 * not run it sees it greyed with the reason, not a refusal after the press.
 */
export function ActionCard({
    automation,
    confirm,
    canRun,
    onRun
}: {
    automation: PanelAutomation;
    confirm: boolean;
    canRun: boolean;
    /** Runs it; resolves to an error sentence, or null once it started. */
    onRun: () => Promise<string | null>;
}) {
    const t = usePlacesT();
    const [asking, setAsking] = useState(false);
    const [state, setState] = useState<"idle" | "busy" | "started">("idle");
    useEffect(() => {
        if (state !== "started") return;
        const timer = setTimeout(() => setState("idle"), STARTED_MS);
        return () => clearTimeout(timer);
    }, [state]);
    const run = async () => {
        setAsking(false);
        setState("busy");
        const error = await onRun();
        setState(error === null ? "started" : "idle");
    };
    const press = () => {
        if (!canRun || state === "busy") return;
        if (confirm) setAsking(true);
        else void run();
    };
    const note =
        state === "started"
            ? t("panels.runStarted")
            : !canRun
              ? t("panels.runNotAllowed")
              : !automation.enabled
                ? t("panels.runPaused")
                : "";
    return (
        <>
            <button
                type="button"
                onClick={press}
                aria-disabled={!canRun || state === "busy" || undefined}
                title={canRun ? automation.name : t("panels.runNotAllowed")}
                className={cn(
                    "flex h-full min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-4 text-left transition-colors",
                    canRun ? "hover:bg-muted active:bg-muted" : "cursor-not-allowed opacity-60"
                )}
            >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {state === "busy" ? (
                        <Loader2 className="size-5 animate-spin" />
                    ) : state === "started" ? (
                        <Check className="size-5" />
                    ) : (
                        <Play className="size-5" />
                    )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-medium">{automation.name}</span>
                    {note ? (
                        <span className="truncate text-xs text-muted-foreground" role="status">
                            {note}
                        </span>
                    ) : null}
                </span>
            </button>
            <Dialog open={asking} onOpenChange={(next) => (next ? undefined : setAsking(false))}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("panels.runQuestion", { name: automation.name })}</DialogTitle>
                        <DialogDescription>{t("panels.runBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setAsking(false)}>
                            {t("panels.cancel")}
                        </Button>
                        <Button type="button" onClick={() => void run()}>
                            {t("panels.runConfirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** One device's reading, large, and when it last changed. */
export function SensorCard({ device }: { device: DeviceView }) {
    const t = usePlacesT();
    const locale = hostUi.i18nProvider.useLocale();
    const line = kinds.readingLine(device.reading, t) || kinds.badgeText(device, t);
    const since = device.stateAt ? new Date(device.stateAt) : null;
    const sinceText =
        since && !Number.isNaN(since.getTime())
            ? t("panels.sensorSince", {
                  time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
                      since
                  )
              })
            : "";
    return (
        <CardFrame>
            <div className="flex min-w-0 items-center gap-2">
                <DeviceIcon kind={device.kind} className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-base font-medium" title={device.name}>
                    {device.name}
                </span>
                <BatteryMeter device={device} large />
            </div>
            <span
                className={cn(
                    "min-w-0 truncate text-3xl font-semibold tabular-nums",
                    !device.online && "text-muted-foreground"
                )}
                title={line}
            >
                {line}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
                {device.online ? sinceText : t("panels.sensorOffline")}
            </span>
        </CardFrame>
    );
}
