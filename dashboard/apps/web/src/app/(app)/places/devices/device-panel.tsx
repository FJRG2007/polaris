"use client";

/**
 * One door: where it is, what it is doing, and everything it has done.
 *
 * The three questions in the order they are asked. The state and the controls are
 * at the top, because nine times out of ten somebody opened this to lock
 * something. The month of use is under them, because the second question about a
 * door is always "is this normal". The history is last and is the longest, since
 * it is the one people read rather than glance at.
 *
 * The chart counts uses rather than openings on the sensor: an unlock followed by
 * the door swinging is one person arriving, and counting both would double every
 * quiet week.
 */

import * as actions from "../actions";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BatteryLow, DoorOpen, Loader2, Lock, LockOpen, Pencil } from "lucide-react";
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
import * as kinds from "@/lib/home/device-kinds";
import type { DeviceAction, DeviceEventView, DeviceView } from "@/lib/home/device-kinds";

/** The icon on each control, so the buttons are told apart at a glance rather
 *  than only read. */
const ACTION_ICONS: Record<DeviceAction, typeof Lock> = {
    lock: Lock,
    unlock: LockOpen,
    unlatch: DoorOpen
};

/** How the state reads on the badge. Deliberately not a colour on its own: a
 *  colour is the glance and the word is the answer. */
function StatePill({ device }: { device: DeviceView }) {
    const tone =
        device.state === "locked"
            ? "border-success/30 bg-success/10 text-success"
            : device.state === "jammed" || device.state === "uncalibrated"
              ? "border-danger/30 bg-danger/10 text-danger"
              : device.state === "unlocked" || device.state === "unlatched"
                ? "border-warning/30 bg-warning/10 text-warning"
                : "border-border bg-muted text-muted-foreground";
    return (
        <Badge className={cn("gap-1.5", tone)}>
            {device.state === "moving" && <Loader2 className="size-3 animate-spin" />}
            {device.online ? kinds.DEVICE_STATE_LABELS[device.state] : "Not answering"}
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
                return (
                    <Button
                        key={action}
                        size="sm"
                        variant={action === "lock" ? "primary" : "outline"}
                        disabled={busy !== null || !device.online}
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
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="ml-auto"
                                    aria-label={`Edit ${device.name}`}
                                    title="Edit"
                                    onClick={() => onEdit(device)}
                                >
                                    <Pencil className="size-4" />
                                </Button>
                            )}
                        </header>

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
                                        device.batteryPercent !== null && `battery ${device.batteryPercent}%`,
                                        device.stateAt && `read at ${format.time(device.stateAt)}`
                                    ]
                                        .filter(Boolean)
                                        .join(" - ")}
                                </p>
                                {device.batteryCritical && (
                                    <p className="flex items-center gap-1.5 text-xs text-danger">
                                        <BatteryLow className="size-3.5 shrink-0" />
                                        The battery is nearly flat. A lock that runs out stops answering
                                        and has to be opened by hand.
                                    </p>
                                )}
                                {error && (
                                    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
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
                                        description="Every lock, unlock and opening lands here, including the ones that did not finish."
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
