"use client";

/**
 * Every door at this place, with its controls on the row.
 *
 * The frequent task here is one press long - lock the front door on the way out,
 * let somebody in - so it does not cost a dialog. The row carries the state, the
 * battery and the buttons; the panel behind it is for the two slower questions,
 * how often it is used and what it has done.
 *
 * The list refreshes itself while somebody is looking at it, because a lock's
 * state is the one thing on this screen that changes without them: a door opened
 * by a keypad downstairs has to appear here. It refreshes on a minute and only
 * while the tab is in front, since every refresh is a call to somebody else's
 * account and a screen nobody is watching does not need one.
 */

import * as actions from "../actions";
import { runAction } from "@/lib/run-action";
import { DeviceDialog } from "./device-dialog";
import { ConnectDialog } from "./connect-dialog";
import * as kinds from "@/lib/home/device-kinds";
import type { PlaceView } from "@/lib/home/place-kinds";
import { useCallback, useEffect, useState } from "react";
import { DeviceControls, DevicePanel } from "./device-panel";
import type { NukiConnection } from "@/lib/home/nuki-devices";
import { useDisplayFormat } from "@/components/display-format";
import type { DeviceAction, DeviceView } from "@/lib/home/device-kinds";
import { BatteryLow, DoorClosed, Plug, RefreshCw, Unplug } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    EmptyState,
    Skeleton,
    cn
} from "@polaris/ui";

/** How often the list goes and asks again, while the tab is in front. */
const REFRESH_MS = 60_000;

function stateTone(device: DeviceView): string {
    if (!device.online) return "border-border bg-muted text-muted-foreground";
    if (device.state === "locked") return "border-success/30 bg-success/10 text-success";
    if (device.state === "jammed" || device.state === "uncalibrated")
        return "border-danger/30 bg-danger/10 text-danger";
    if (device.state === "unlocked" || device.state === "unlatched")
        return "border-warning/30 bg-warning/10 text-warning";
    return "border-border bg-muted text-muted-foreground";
}

export function DevicesView({
    places,
    canControl,
    canManage
}: {
    places: readonly PlaceView[];
    canControl: boolean;
    canManage: boolean;
}) {
    const format = useDisplayFormat();
    const [devices, setDevices] = useState<DeviceView[] | null>(null);
    const [account, setAccount] = useState<NukiConnection | null>(null);
    const [connecting, setConnecting] = useState(false);
    const [editing, setEditing] = useState<DeviceView | null>(null);
    const [opened, setOpened] = useState<DeviceView | null>(null);
    const [disconnecting, setDisconnecting] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState<{ id: string; action: DeviceAction } | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.listDevicesAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            setDevices(result.devices ?? []);
            setAccount(result.account ?? null);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /** Ask the account what it has now. `quiet` is the timer's version, which must
     *  not put a spinner on a screen nobody asked to wait. */
    const sync = useCallback(async (quiet = false) => {
        if (!quiet) setRefreshing(true);
        const result = await actions.syncDevicesAction();
        if (!quiet) setRefreshing(false);
        if (result.devices) setDevices(result.devices);
        if (!quiet) setError(result.error ?? "");
    }, []);

    useEffect(() => {
        if (!account?.connected) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void sync(true);
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [account?.connected, sync]);

    /** Put a device back into both lists it can be in, so the row and the open
     *  panel never disagree about what a door is doing. */
    const settle = (device: DeviceView) => {
        setDevices((current) => (current ?? []).map((entry) => (entry.id === device.id ? device : entry)));
        setOpened((current) => (current && current.id === device.id ? device : current));
    };

    const act = async (device: DeviceView, action: DeviceAction) => {
        setBusy({ id: device.id, action });
        setError("");
        const result = await runAction(() => actions.operateDeviceAction(device.id, action), setError);
        setBusy(null);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            throw new Error(result.error);
        }
        if (result.device) settle(result.device);
        // The lock answers before the door has finished moving, so the state that
        // matters is the one after it. Asked for once, a few seconds later, rather
        // than left saying "moving" until the minute is up.
        setTimeout(() => void sync(true), 4000);
    };

    const disconnect = async () => {
        const result = await runAction(() => actions.disconnectDeviceAccountAction(), setError);
        setDisconnecting(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setAccount(result.account ?? null);
        setDevices([]);
    };

    if (devices === null) {
        return (
            <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-48" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
            </div>
        );
    }

    if (!account?.connected) {
        return (
            <>
                <EmptyState
                    title="No locks yet."
                    description={
                        canManage
                            ? "Connect the account your locks are on and they appear here, with their state, their controls and everything they have done."
                            : "Somebody who administers Places can connect the account the locks are on."
                    }
                    action={
                        canManage ? (
                            <Button size="sm" onClick={() => setConnecting(true)}>
                                <Plug className="size-4" />
                                Connect Nuki
                            </Button>
                        ) : undefined
                    }
                />
                <ConnectDialog
                    open={connecting}
                    connected={false}
                    onClose={() => setConnecting(false)}
                    onConnected={(result) => {
                        setDevices(result.devices);
                        setAccount(result.account);
                        setConnecting(false);
                    }}
                />
            </>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Badge className="gap-1.5 border-border bg-muted text-muted-foreground">
                    {account.label || "Nuki"}
                </Badge>
                <span className="text-xs text-foreground-subtle">
                    {account.lastSyncedAt
                        ? `Checked at ${format.time(account.lastSyncedAt)}`
                        : "Not checked yet"}
                </span>
                <span className="flex-1" />
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Check again"
                    title="Check again"
                    disabled={refreshing}
                    onClick={() => void sync()}
                >
                    <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
                </Button>
                {canManage && (
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Disconnect the account"
                        title="Disconnect the account"
                        onClick={() => setDisconnecting(true)}
                    >
                        <Unplug className="size-4" />
                    </Button>
                )}
            </div>

            {account.status === "unauthorized" && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
                    <p className="flex-1 text-sm text-danger">
                        The account is refusing the token, so the doors are not being read. It was
                        probably revoked.
                    </p>
                    {canManage && (
                        <Button size="sm" onClick={() => setConnecting(true)}>
                            Reconnect
                        </Button>
                    )}
                </div>
            )}

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {devices.some((device) => device.placeId === null) && (
                <p className="text-xs text-muted-foreground">
                    An account arrives knowing what it holds and not where any of it is, so anything
                    marked not placed is on every place&apos;s list. Open one to say which it belongs to.
                </p>
            )}

            {devices.length === 0 ? (
                <EmptyState
                    title="The account answered with no doors."
                    description="Check that this is the account the locks are on, and that the token it was connected with may see them."
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {devices.map((device) => (
                        <li
                            key={device.id}
                            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3"
                        >
                            <button
                                type="button"
                                onClick={() => setOpened(device)}
                                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                            >
                                <span className="flex items-center gap-2">
                                    <DoorClosed className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate text-sm font-medium" title={device.name}>{device.name}</span>
                                    <Badge className={cn("shrink-0", stateTone(device))}>
                                        {device.online
                                            ? kinds.DEVICE_STATE_LABELS[device.state]
                                            : "Not answering"}
                                    </Badge>
                                    {device.batteryCritical && (
                                        <Badge className="shrink-0 gap-1 border-danger/30 bg-danger/10 text-danger">
                                            <BatteryLow className="size-3 shrink-0" />
                                            Battery
                                        </Badge>
                                    )}
                                    {device.placeId === null && (
                                        <Badge className="shrink-0 border-border bg-muted text-muted-foreground">
                                            Not placed
                                        </Badge>
                                    )}
                                </span>
                                <span className="truncate text-[0.6875rem] text-foreground-subtle">
                                    {[
                                        device.zone,
                                        device.model,
                                        device.doorState === "none"
                                            ? null
                                            : kinds.DOOR_STATE_LABELS[device.doorState],
                                        device.batteryPercent === null
                                            ? null
                                            : `Battery ${device.batteryPercent}%`
                                    ]
                                        .filter(Boolean)
                                        .join(" - ")}
                                </span>
                            </button>
                            <DeviceControls
                                device={device}
                                canControl={canControl}
                                busy={busy?.id === device.id ? busy.action : null}
                                onAct={(action) => {
                                    // Thrown by `act` so the panel can show it; on
                                    // the row the line above the list already has.
                                    void act(device, action).catch(() => undefined);
                                }}
                            />
                        </li>
                    ))}
                </ul>
            )}

            <DevicePanel
                device={opened}
                canControl={canControl}
                canManage={canManage}
                onClose={() => setOpened(null)}
                onAct={act}
                onEdit={(device) => {
                    setOpened(null);
                    setEditing(device);
                }}
            />

            <DeviceDialog
                device={editing}
                places={places}
                onClose={() => setEditing(null)}
                onSaved={(device) => {
                    settle(device);
                    setEditing(null);
                }}
            />

            <ConnectDialog
                open={connecting}
                connected
                onClose={() => setConnecting(false)}
                onConnected={(result) => {
                    setDevices(result.devices);
                    setAccount(result.account);
                    setConnecting(false);
                }}
            />

            <ConfirmDeleteDialog
                open={disconnecting}
                onOpenChange={(open) => (open ? undefined : setDisconnecting(false))}
                name={account.label || "Nuki"}
                kind="account"
                requireTyping={false}
                description="The doors go with it, and so does everything they have done. Polaris keeps no copy of a building it has been told it has no business with."
                confirmLabel="Disconnect"
                onConfirm={disconnect}
            />
        </div>
    );
}
