"use client";

/**
 * One device: where it is, what it is doing, and everything it has done.
 *
 * The three questions in the order they are asked. The state and the controls are
 * at the top, because nine times out of ten somebody opened this to lock or
 * switch something. The month of use is under them, because the second question
 * about anything in a building is always "is this normal". The history is last
 * and is the longest, since it is the one people read rather than glance at.
 *
 * The chart counts uses rather than openings on the sensor: an unlock followed by
 * the door swinging is one person arriving, and counting both would double every
 * quiet week.
 *
 * Which controls it gets is `actionsFor`, never this file. A door has three
 * buttons and a socket has two, and the moment a screen decides that for itself
 * is the moment a lock somewhere grows an "On".
 */

import * as actions from "../actions";
import { ShareDialog } from "@/components/access/share-dialog";
import * as kinds from "@/lib/home/device-kinds";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeviceAction, DeviceEventView, DeviceView } from "@/lib/home/device-kinds";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    EmptyState,
    Skeleton,
    TimeSeriesChart,
    cn
} from "@polaris/ui";
import {
    BatteryLow,
    DoorClosed,
    DoorOpen,
    Gauge,
    Lightbulb,
    Loader2,
    Lock,
    LockOpen,
    Pencil,
    Share2,
    Plug,
    Power,
    PowerOff,
    ToggleRight
} from "lucide-react";

/** The icon on each control, so the buttons are told apart at a glance rather
 *  than only read. */
const ACTION_ICONS: Record<DeviceAction, typeof Lock> = {
    lock: Lock,
    unlock: LockOpen,
    unlatch: DoorOpen,
    "turn-on": Power,
    "turn-off": PowerOff
};

/** What each sort of device looks like in a list. A row of doors and a row of
 *  sockets are read at a glance rather than by name, and the icon is what makes
 *  that possible once a place holds both. */
const KIND_ICONS: Record<kinds.DeviceKind, typeof Lock> = {
    lock: DoorClosed,
    opener: DoorOpen,
    switch: ToggleRight,
    outlet: Plug,
    light: Lightbulb,
    sensor: Gauge
};

/** The one button of a pair that gets the weight. Locking up and switching a
 *  light on are what people came to press; the other is the correction. */
const PRIMARY_ACTIONS: readonly DeviceAction[] = ["lock", "turn-on"];

export function DeviceIcon({ kind, className }: { kind: string; className?: string }) {
    const Icon = KIND_ICONS[kinds.deviceKind(kind)];
    return <Icon className={className} />;
}

/** The one place a state becomes a colour. Written once because the row, the
 *  panel and anything later that shows a state must not disagree about what
 *  jammed looks like. */
const TONE_CLASSES: Record<kinds.DeviceTone, string> = {
    success: "border-success/30 bg-success/10 text-success",
    active: "border-accent/30 bg-accent/10 text-accent",
    warning: "border-warning/30 bg-warning/10 text-warning",
    danger: "border-danger/30 bg-danger/10 text-danger",
    muted: "border-border bg-muted text-muted-foreground"
};

/** A device nobody can reach has no state worth colouring: whatever it was doing
 *  when it last answered is not what it is doing now. */
export function stateClass(device: DeviceView): string {
    if (!device.online) return TONE_CLASSES.muted;
    return TONE_CLASSES[kinds.DEVICE_STATE_TONES[device.state]];
}

/** How the state reads on the badge. Deliberately not a colour on its own: a
 *  colour is the glance and the word is the answer. */
function StatePill({ device }: { device: DeviceView }) {
    // A sensor has no state to be in - it has a reading, and that is what the
    // badge is for on one. A sensor whose reading has not arrived says so rather
    // than borrowing the word a lock uses for the same silence.
    const reading = kinds.readingLine(device.reading);
    return (
        <Badge className={cn("gap-1.5", stateClass(device))}>
            {device.state === "moving" && <Loader2 className="size-3 animate-spin" />}
            {!device.online
                ? "Not answering"
                : kinds.deviceKind(device.kind) === "sensor"
                  ? reading || "Nothing read yet"
                  : kinds.stateLabel(device.kind, device.state)}
        </Badge>
    );
}

/** The controls, which are the reason most people open this. */
export function DeviceControls({
    device,
    canControl,
    busy,
    onAct,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    busy: DeviceAction | null;
    onAct: (action: DeviceAction) => void;
    className?: string;
}) {
    if (!canControl) return null;
    // Nothing to press on something that only measures. Left silent rather than
    // explained: a row of buttons that is not there needs no note, and a sentence
    // under every sensor in a house would be thirty sentences.
    if (kinds.actionsFor(device.kind).length === 0) return null;
    // A door taken off the controls says so where the buttons would be, rather
    // than showing nothing and leaving somebody looking for them.
    if (!device.controllable) {
        return (
            <p className={cn("text-xs text-muted-foreground", className)}>
                Set to be watched rather than operated.
            </p>
        );
    }
    return (
        <div className={cn("flex flex-wrap gap-2", className)}>
            {kinds.actionsFor(device.kind).map((action) => {
                const Icon = ACTION_ICONS[action];
                // A socket that is already on has nothing to be told. The button
                // stays where it is, so the pair does not jump about as it is
                // pressed, and says by being flat that this is the state it is in.
                const settled = kinds.settledState(action);
                const already = settled !== null && device.state === settled;
                return (
                    <Button
                        key={action}
                        size="sm"
                        variant={
                            PRIMARY_ACTIONS.includes(action) && !already ? "primary" : "outline"
                        }
                        disabled={busy !== null || !device.online || already}
                        onClick={() => onAct(action)}
                    >
                        {busy === action ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Icon className="size-4" />
                        )}
                        {kinds.DEVICE_ACTION_LABELS[action]}
                    </Button>
                );
            })}
        </div>
    );
}

export function DevicePanel({
    device,
    canControl,
    canManage,
    onClose,
    onAct,
    onEdit
}: {
    device: DeviceView | null;
    canControl: boolean;
    canManage: boolean;
    onClose: () => void;
    onAct: (device: DeviceView, action: DeviceAction) => Promise<void>;
    onEdit: (device: DeviceView) => void;
}) {
    const format = useDisplayFormat();
    const [events, setEvents] = useState<DeviceEventView[] | null>(null);
    const [used, setUsed] = useState<number[] | null>(null);
    const [busy, setBusy] = useState<DeviceAction | null>(null);
    /** Whether the sharing dialog is up. Held here rather than in the screen
     *  above, because what is being shared is whatever this panel is showing. */
    const [sharing, setSharing] = useState(false);
    const [error, setError] = useState("");
    const deviceId = device?.id ?? null;

    const load = useCallback(async () => {
        if (!deviceId) return;
        const [history, usage] = await Promise.all([
            actions.deviceHistoryAction(deviceId, 200),
            actions.deviceUsageAction(deviceId)
        ]);
        setEvents(history.events ?? []);
        setUsed(usage.used ?? []);
    }, [deviceId]);

    useEffect(() => {
        if (!deviceId) {
            setEvents(null);
            setUsed(null);
            return;
        }
        setEvents(null);
        setUsed(null);
        setError("");
        void load();
    }, [deviceId, load]);

    const days = useMemo(
        () => kinds.bucketUsage(used ?? [], format.preferences.timeZone, kinds.USAGE_DAYS),
        [used, format.preferences.timeZone]
    );

    const act = async (action: DeviceAction) => {
        if (!device) return;
        setBusy(action);
        setError("");
        try {
            await onAct(device, action);
            // The account's own log is where the entry comes from, and it arrives
            // a moment behind the press, so the history is asked again rather than
            // written to here.
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "That did not work.");
        } finally {
            setBusy(null);
        }
    };

    return (
        <Dialog open={device !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="flex max-h-[92vh] w-[min(46rem,96vw)] max-w-[min(46rem,96vw)] flex-col gap-0 overflow-hidden p-0">
                {device && (
                    <>
                        <header className="flex flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-14">
                            <DialogTitle className="text-sm font-medium">{device.name}</DialogTitle>
                            <StatePill device={device} />
                            {device.doorState !== "none" && (
                                <span className="text-xs text-muted-foreground">
                                    {kinds.DOOR_STATE_LABELS[device.doorState]}
                                </span>
                            )}
                            {canManage && (
                                <div className="ml-auto flex items-center gap-1">
                                    {/* Lending one door is the thing people came
                                        to a connected lock for. It sits beside
                                        Edit rather than inside it: taking a key
                                        back is urgent, and it should never be
                                        behind a form. */}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`Share ${device.name}`}
                                        title="Share"
                                        onClick={() => setSharing(true)}
                                    >
                                        <Share2 className="size-4" />
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`Edit ${device.name}`}
                                        title="Edit"
                                        onClick={() => onEdit(device)}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                </div>
                            )}
                        </header>

                        <ShareDialog
                            open={sharing}
                            onOpenChange={setSharing}
                            subject="place.device"
                            subjectId={device.id}
                            name={device.name}
                            // A door is exactly the thing worth lending for an
                            // afternoon, four times.
                            bounded
                        />

                        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
                            <section className="flex flex-col gap-3">
                                <DeviceControls
                                    device={device}
                                    canControl={canControl}
                                    busy={busy}
                                    onAct={(action) => void act(action)}
                                />
                                <p className="text-xs text-foreground-subtle">
                                    {[
                                        device.zone,
                                        device.model,
                                        device.firmware && `firmware ${device.firmware}`,
                                        device.batteryPercent !== null &&
                                            `battery ${device.batteryPercent}%`,
                                        device.stateAt && `read at ${format.time(device.stateAt)}`
                                    ]
                                        .filter(Boolean)
                                        .join(" - ")}
                                </p>
                                {device.batteryCritical && (
                                    <p className="flex items-center gap-1.5 text-xs text-danger">
                                        <BatteryLow className="size-3.5 shrink-0" />
                                        The battery is nearly flat. Once it runs out it stops
                                        answering, and whatever it does has to be done by hand.
                                    </p>
                                )}
                                {error && (
                                    <p
                                        role="alert"
                                        className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
                                    >
                                        {error}
                                    </p>
                                )}
                            </section>

                            <section className="flex flex-col gap-2 border-t border-border pt-4">
                                <h3 className="text-sm font-medium">Used</h3>
                                {used === null ? (
                                    <Skeleton className="h-32 w-full" />
                                ) : (
                                    <TimeSeriesChart
                                        label={`Times used, last ${kinds.USAGE_DAYS} days`}
                                        points={days.map((day) => ({ t: day.t, v: day.count }))}
                                        from={days[0]?.t ?? Date.now()}
                                        to={days[days.length - 1]?.t ?? Date.now()}
                                        summary="sum"
                                        formatTime={(at) => format.date(at)}
                                        format={(value) => String(Math.round(value))}
                                    />
                                )}
                            </section>

                            <section className="flex flex-col gap-2 border-t border-border pt-4">
                                <h3 className="text-sm font-medium">History</h3>
                                {events === null ? (
                                    <div className="flex flex-col gap-2">
                                        <Skeleton className="h-6 w-full" />
                                        <Skeleton className="h-6 w-4/5" />
                                        <Skeleton className="h-6 w-3/5" />
                                    </div>
                                ) : events.length === 0 ? (
                                    <EmptyState
                                        title="Nothing recorded yet."
                                        description="Everything this has been told to do lands here, including whatever did not finish."
                                    />
                                ) : (
                                    <ul className="divide-y divide-border rounded-lg border border-border">
                                        {events.map((event) => (
                                            <li
                                                key={event.id}
                                                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2"
                                            >
                                                <span
                                                    className={cn(
                                                        "text-sm",
                                                        event.outcome === "ok" ? "" : "text-danger"
                                                    )}
                                                >
                                                    {kinds.describeEvent(event)}
                                                </span>
                                                <span className="text-xs tabular-nums text-foreground-subtle">
                                                    {format.dateTime(event.at)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
