"use client";

/**
 * What a wall panel's cards draw, for a finger on a wall tablet: a device as its
 * state and one big press, a room as how much of it is on, and a clock. A card
 * never scrolls: what does not fit on it opens full screen (`WallSheet`) with
 * the devices screen's own controls (`DeviceControls`), so a light offers a
 * slider only when it dims and a switch only when it switches.
 *
 * A camera card is the camera wall's own tile and viewer; an automation button
 * runs one automation; a sensor card is one reading, large. Places keeps no
 * history of readings (only the last one, `PlaceDeviceObservation`), so a
 * sensor card shows the reading now and when it last changed - no graph.
 */

import {
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
import { DeviceControls, DeviceIcon } from "../devices/device-panel";
import { useLentActions } from "../devices/lent-actions";
import { primaryAction, wallReading } from "../../lib/panel-fit";
import { WallSheet } from "./panel-wall-sheet";
import { WeatherFace, type WeatherState } from "./panel-weather";
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
                "flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-[var(--panel-pad,1rem)]",
                className
            )}
        >
            {children}
        </div>
    );
}

/** Whether this reader may press this action on this device: a resident who
 *  controls the place, or a link lent exactly that kind of press. */
function useMayPress(device: DeviceView, canControl: boolean) {
    const lent = useLentActions(device.id);
    return (action: DeviceAction) => canControl || lent.includes(kinds.grantActionFor(action));
}

/** Whether a device reads as on: lit, running, or a door left unlocked. */
function isOn(device: DeviceView): boolean {
    return device.state === "on" || device.state === "unlocked" || device.state === "unlatched";
}

/**
 * One device on the wall: its name, its state in large type, a reading as a big
 * number, and the one press it is mostly used for as a big button. Everything
 * else it has - modes, fan, target, timers, a litter box's settings - is behind
 * a tap on the card, in a full-screen sheet with the devices screen's own
 * controls. Nothing on the card scrolls or wraps into sentences.
 */
export function DeviceTile({ device, acts }: { device: DeviceView; acts: CardActs }) {
    const t = usePlacesT();
    const [open, setOpen] = useState(false);
    const mayPress = useMayPress(device, acts.canControl);
    const busy = acts.busy?.id === device.id ? acts.busy.action : null;
    const action = primaryAction(device);
    const reading = wallReading(device);
    const status = kinds.badgeText(device, t);
    const ready = device.online && device.controllable;
    const pressable = action !== null && ready && mayPress(action) && busy === null;
    return (
        <CardFrame className="relative gap-2">
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={t("panelWall.more", { name: device.name })}
                title={t("panelWall.more", { name: device.name })}
                className="absolute inset-0 rounded-xl transition-colors hover:bg-muted/40 active:bg-muted/60"
            />
            <div className="pointer-events-none relative flex min-w-0 items-center gap-2">
                <DeviceIcon kind={device.kind} className="size-6 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-lg font-medium" title={device.name}>
                    {device.name}
                </span>
                <BatteryMeter device={device} large />
            </div>
            <div className="pointer-events-none relative flex min-h-0 min-w-0 flex-1 items-end gap-3">
                <span
                    className={cn(
                        "min-w-0 flex-1 truncate text-2xl font-semibold",
                        !device.online && "text-warning"
                    )}
                    title={status}
                    role="status"
                >
                    {status}
                </span>
                {reading ? (
                    <span className="shrink-0 text-4xl font-semibold tabular-nums">{reading}</span>
                ) : null}
            </div>
            {action ? (
                <Button
                    type="button"
                    size="lg"
                    variant={isOn(device) ? "primary" : "outline"}
                    aria-disabled={!pressable || undefined}
                    title={mayPress(action) ? kinds.actionText(action, t) : t("panelWall.notAllowed")}
                    onClick={() => {
                        if (pressable) acts.onAct(device, action);
                    }}
                    className={cn(
                        "relative min-h-16 w-full shrink-0 text-lg",
                        !pressable && "cursor-not-allowed opacity-60"
                    )}
                >
                    {busy ? <Loader2 className="size-6 animate-spin" /> : null}
                    <span className="truncate">{kinds.actionText(action, t)}</span>
                </Button>
            ) : null}
            <WallSheet
                open={open}
                title={device.name}
                description={status}
                onClose={() => setOpen(false)}
            >
                <DeviceControls
                    device={device}
                    canControl={acts.canControl}
                    busy={busy}
                    onAct={(next, command) => acts.onAct(device, next, command)}
                    detailed
                />
            </WallSheet>
        </CardFrame>
    );
}

/** A room: its name and how much of it is on, large; a tap opens every device
 *  in it, each with the control a row holds, in a full-screen sheet. */
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
    const [open, setOpen] = useState(false);
    const summary =
        devices.length === 0
            ? t("panels.roomEmpty")
            : t("panelWall.roomOn", {
                  on: devices.filter(isOn).length,
                  count: devices.length
              });
    return (
        <CardFrame className="relative">
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={t("panelWall.more", { name })}
                title={t("panelWall.more", { name })}
                className="absolute inset-0 rounded-xl transition-colors hover:bg-muted/40 active:bg-muted/60"
            />
            <h2
                className="pointer-events-none relative min-w-0 truncate text-xl font-medium"
                title={name}
            >
                {name}
            </h2>
            <span
                className="pointer-events-none relative mt-auto min-w-0 truncate text-3xl font-semibold"
                title={summary}
            >
                {summary}
            </span>
            <div className="pointer-events-none relative flex min-w-0 gap-2 text-muted-foreground">
                {devices.slice(0, 6).map((device) => (
                    <DeviceIcon
                        key={device.id}
                        kind={device.kind}
                        className={cn("size-6 shrink-0", isOn(device) && "text-primary")}
                    />
                ))}
            </div>
            <WallSheet
                open={open}
                title={name}
                description={summary}
                onClose={() => setOpen(false)}
            >
                <ul className="flex flex-col gap-4">
                    {devices.map((device) => (
                        <li key={device.id} className="flex min-w-0 flex-wrap items-center gap-3">
                            <DeviceIcon
                                kind={device.kind}
                                className="size-6 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate text-lg" title={device.name}>
                                {device.name}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                                {kinds.badgeText(device, t)}
                            </span>
                            <DeviceControls
                                device={device}
                                canControl={acts.canControl}
                                busy={acts.busy?.id === device.id ? acts.busy.action : null}
                                onAct={(action, command) => acts.onAct(device, action, command)}
                            />
                        </li>
                    ))}
                </ul>
            </WallSheet>
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
            <span className="text-5xl font-semibold tabular-nums">
                {now
                    ? new Intl.DateTimeFormat(locale, {
                          hour: "2-digit",
                          minute: "2-digit"
                      }).format(now)
                    : "--:--"}
            </span>
            <span className="min-w-0 truncate text-lg text-muted-foreground">
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

/** The weather at the panel's place, or the card's own location, now. */
export function WeatherCard({
    weather,
    forecast,
    onPick
}: {
    weather: WeatherState;
    forecast?: boolean;
    onPick?: () => void;
}) {
    return (
        <CardFrame className="justify-center">
            <WeatherFace weather={weather} forecast={forecast} onPick={onPick} />
        </CardFrame>
    );
}

/** A card whose device or room is gone. */
export function GoneCard() {
    const t = usePlacesT();
    return (
        <CardFrame className="justify-center">
            <p className="text-lg text-muted-foreground">{t("panels.cardGone")}</p>
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
        <div className="relative h-full min-h-0 min-w-0 overflow-hidden rounded-xl bg-card">
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
                className="absolute end-3 top-3 size-14 bg-background/90 p-0"
            >
                <Maximize2 className="size-7" />
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
                    "flex h-full min-h-16 w-full min-w-0 items-center gap-4 rounded-xl border border-border bg-card px-4 text-start transition-colors",
                    canRun ? "hover:bg-muted active:bg-muted" : "cursor-not-allowed opacity-60"
                )}
            >
                <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {state === "busy" ? (
                        <Loader2 className="size-7 animate-spin" />
                    ) : state === "started" ? (
                        <Check className="size-7" />
                    ) : (
                        <Play className="size-7" />
                    )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xl font-medium">{automation.name}</span>
                    {note ? (
                        <span className="truncate text-base text-muted-foreground" role="status">
                            {note}
                        </span>
                    ) : null}
                </span>
            </button>
            <Dialog open={asking} onOpenChange={(next) => (next ? undefined : setAsking(false))}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {t("panels.runQuestion", { name: automation.name })}
                        </DialogTitle>
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
                  time: new Intl.DateTimeFormat(locale, {
                      hour: "2-digit",
                      minute: "2-digit"
                  }).format(since)
              })
            : "";
    return (
        <CardFrame>
            <div className="flex min-w-0 items-center gap-2">
                <DeviceIcon kind={device.kind} className="size-6 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-lg font-medium" title={device.name}>
                    {device.name}
                </span>
                <BatteryMeter device={device} large />
            </div>
            <span
                className={cn(
                    "min-w-0 truncate text-4xl font-semibold tabular-nums",
                    !device.online && "text-muted-foreground"
                )}
                title={line}
            >
                {line}
            </span>
            <span className="min-w-0 truncate text-base text-muted-foreground">
                {device.online ? sinceText : t("panels.sensorOffline")}
            </span>
        </CardFrame>
    );
}
