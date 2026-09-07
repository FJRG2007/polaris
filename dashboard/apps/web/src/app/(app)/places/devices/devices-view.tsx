"use client";

/**
 * Every device at this place, with its controls on the row.
 *
 * The frequent task here is one press long - lock the front door on the way out,
 * let somebody in, switch off the thing that was left on - so it does not cost a
 * dialog. The row carries the state, the battery and the buttons; the panel
 * behind it is for the two slower questions, how often it is used and what it has
 * done.
 *
 * More than one thing can be connected, and they are shown as what they are:
 * several makes in one house, or one make reached two ways. Each says when it was
 * last heard from and each fails on its own, because "the switches are out" and
 * "the locks are out" are different sentences and a screen that merged them would
 * tell somebody neither.
 *
 * The list refreshes itself while somebody is looking at it, because a device's
 * state is the one thing on this screen that changes without them: a door opened
 * by a keypad downstairs has to appear here. It refreshes on the half minute,
 * only while the tab is in front, and again the moment it comes back to the
 * front - every refresh is a call to somebody else's account, and a screen nobody
 * is watching does not need one.
 */

import * as actions from "../actions";
import { runAction } from "@/lib/run-action";
import { DeviceDialog } from "./device-dialog";
import { ConnectDialog, type Connected } from "./connect-dialog";
import * as kinds from "@/lib/home/device-kinds";
import type { PlaceView } from "@/lib/home/place-kinds";
import type { DeviceAccountView } from "@/lib/home/device-accounts";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IntegrationLogo } from "@/components/logos";
import * as registry from "@/lib/home/device-connections";
import { BatteryLow, Plus, RefreshCw, Unplug } from "lucide-react";
import type { DeviceAction, DeviceView } from "@/lib/home/device-kinds";
import { DeviceControls, DeviceIcon, DevicePanel, stateClass } from "./device-panel";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    EmptyState,
    Skeleton,
    cn
} from "@polaris/ui";

/** How often the list goes and asks again, while the tab is in front. Short
 *  enough that a door somebody else just used is right by the time the reader
 *  looks up; nothing is woken to answer it, so the cost is one call to the
 *  account and no battery. */
const REFRESH_MS = 30_000;

/**
 * The devices of one sort, together.
 *
 * A place with six doors reads as a list; the same place with six doors and
 * thirty sockets reads as neither unless they are apart. The order is the order
 * of the kinds themselves rather than of whatever synced first, so the doors are
 * always at the top - which is what somebody opening this screen in a hurry came
 * for.
 */
function groupDevices(devices: readonly DeviceView[]): { label: string; devices: DeviceView[] }[] {
    const groups = new Map<string, { label: string; devices: DeviceView[] }>();
    for (const kind of kinds.DEVICE_KINDS) {
        const label = kinds.DEVICE_GROUP_LABELS[kind];
        if (!groups.has(label)) groups.set(label, { label, devices: [] });
    }
    for (const device of devices) {
        groups.get(kinds.DEVICE_GROUP_LABELS[kinds.deviceKind(device.kind)])?.devices.push(device);
    }
    return [...groups.values()].filter((group) => group.devices.length > 0);
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
    const [accounts, setAccounts] = useState<DeviceAccountView[]>([]);
    const [connecting, setConnecting] = useState(false);
    /** The account being given a new credential, where that is what the dialog is
     *  open for. Null is connecting something new. */
    const [reconnecting, setReconnecting] = useState<DeviceAccountView | null>(null);
    const [editing, setEditing] = useState<DeviceView | null>(null);
    const [opened, setOpened] = useState<DeviceView | null>(null);
    const [disconnecting, setDisconnecting] = useState<DeviceAccountView | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState<{ id: string; action: DeviceAction } | null>(null);
    const [error, setError] = useState("");
    const groups = useMemo(() => groupDevices(devices ?? []), [devices]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.listDevicesAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            setDevices(result.devices ?? []);
            setAccounts(result.accounts ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * Ask the account what it has now.
     *
     * `quiet` is the timer's version, which must not put a spinner on a screen
     * nobody asked to wait - and which reads what the account already knows
     * rather than making the devices themselves speak up. The loud version is
     * somebody pressing the button, and that one is allowed to wake them: it is
     * the difference between "as far as we know" and "as of now", and it is only
     * ever spent when a person asked for it.
     *
     * When it was last checked comes back with the devices. Without it the line
     * at the top kept the time of the first read for as long as the tab was open,
     * which is a screen refreshing itself every half a minute while saying it
     * has not looked since you arrived.
     */
    const sync = useCallback(async (quiet = false) => {
        if (!quiet) setRefreshing(true);
        const result = await actions.syncDevicesAction({ probe: !quiet });
        if (!quiet) setRefreshing(false);
        if (result.devices) setDevices(result.devices);
        if (result.accounts) setAccounts(result.accounts);
        if (!quiet) setError(result.error ?? "");
    }, []);

    const connected = accounts.length > 0;

    useEffect(() => {
        if (!connected) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void sync(true);
        }, REFRESH_MS);
        // A tab that has been in the background is a tab whose every state is as
        // old as the moment it was left. Coming back to it is exactly when
        // somebody is about to read a door and believe it, so it is read again
        // then rather than up to half a minute later.
        const wake = () => {
            if (document.visibilityState === "visible") void sync(true);
        };
        document.addEventListener("visibilitychange", wake);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", wake);
        };
    }, [connected, sync]);

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
        if (!disconnecting) return;
        const result = await runAction(
            () => actions.disconnectDeviceAccountAction(disconnecting.id),
            setError
        );
        setDisconnecting(null);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setAccounts(result.accounts ?? []);
        setDevices(result.devices ?? []);
    };

    /** One dialog, two jobs, and the difference is which account it was opened
     *  on. Closing it has to forget that either way. */
    const settleConnection = (result: Connected) => {
        setDevices(result.devices);
        setAccounts(result.accounts);
        setConnecting(false);
        setReconnecting(null);
    };
    const closeConnect = () => {
        setConnecting(false);
        setReconnecting(null);
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

    if (!connected) {
        return (
            <>
                <EmptyState
                    title="Nothing connected yet."
                    description={
                        canManage
                            ? "Connect what your locks, switches and lights are on and they appear here, with their state, their controls and everything they have done."
                            : "Somebody who administers Places can connect what the devices are on."
                    }
                    action={
                        canManage ? (
                            <Button size="sm" onClick={() => setConnecting(true)}>
                                <Plus className="size-4 shrink-0" />
                                Connect a device
                            </Button>
                        ) : undefined
                    }
                />
                <ConnectDialog
                    open={connecting}
                    reconnect={null}
                    onClose={closeConnect}
                    onConnected={settleConnection}
                />
            </>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                {accounts.map((account) => (
                    <span
                        key={account.id}
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-card py-1 pl-2.5 pr-1"
                    >
                        <IntegrationLogo
                            slug={registry.deviceConnection(account.connection)?.logo ?? ""}
                            className="size-4 w-5 shrink-0 object-contain"
                        />
                        <span className="text-xs font-medium">{account.label}</span>
                        <span className="text-[0.6875rem] text-foreground-subtle">
                            {account.status === "ok"
                                ? account.lastSyncedAt
                                    ? format.time(account.lastSyncedAt)
                                    : "not checked yet"
                                : account.status === "unauthorized"
                                  ? "refusing what it was given"
                                  : "not answering"}
                        </span>
                        {canManage && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="size-6 p-0"
                                aria-label={`Disconnect ${account.label}`}
                                title={`Disconnect ${account.label}`}
                                onClick={() => setDisconnecting(account)}
                            >
                                <Unplug className="size-3.5" />
                            </Button>
                        )}
                    </span>
                ))}
                <span className="flex-1" />
                {canManage && (
                    <Button size="sm" onClick={() => setConnecting(true)}>
                        <Plus className="size-4 shrink-0" />
                        Connect a device
                    </Button>
                )}
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
            </div>

            {accounts
                .filter((account) => account.status !== "ok")
                .map((account) => (
                    <div
                        key={account.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2"
                    >
                        <p className="flex-1 text-sm text-danger">
                            {account.status === "unauthorized"
                                ? `${account.label} is refusing what Polaris opens it with, so its devices are not being read. It was probably revoked.`
                                : `${account.label} could not be reached, so its devices are as they were when it last answered.`}
                            {account.statusNote ? ` ${account.statusNote}` : ""}
                        </p>
                        {canManage && account.status === "unauthorized" && (
                            <Button size="sm" onClick={() => setReconnecting(account)}>
                                Reconnect
                            </Button>
                        )}
                    </div>
                ))}

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
                    title="The account answered with nothing."
                    description="Check that this is the account the devices are on, and that what it was connected with may see them."
                />
            ) : (
                <div className="flex flex-col gap-6">
                    {groups.map((group) => (
                        <section key={group.label} className="flex flex-col gap-2">
                            {groups.length > 1 && (
                                <h2 className="text-xs font-medium text-muted-foreground">{group.label}</h2>
                            )}
                            <ul className="flex flex-col gap-2">
                                {group.devices.map((device) => (
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
                                                <DeviceIcon
                                                    kind={device.kind}
                                                    className="size-4 shrink-0 text-muted-foreground"
                                                />
                                                <span className="truncate text-sm font-medium" title={device.name}>
                                                    {device.name}
                                                </span>
                                                <Badge className={cn("shrink-0", stateClass(device))}>
                                                    {device.online
                                                        ? kinds.stateLabel(device.kind, device.state)
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
                        </section>
                    ))}
                </div>
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
                open={connecting || reconnecting !== null}
                reconnect={reconnecting}
                onClose={closeConnect}
                onConnected={settleConnection}
            />

            <ConfirmDeleteDialog
                open={disconnecting !== null}
                onOpenChange={(open) => (open ? undefined : setDisconnecting(null))}
                name={disconnecting?.label ?? ""}
                kind="connection"
                requireTyping={false}
                description="Its devices go with it, and so does everything they have done. Polaris keeps no copy of a building it has been told it has no business with."
                confirmLabel="Disconnect"
                onConfirm={disconnect}
            />
        </div>
    );
}
