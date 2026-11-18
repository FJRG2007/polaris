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
 * The list is live, the way Home Assistant's is: a device's state is the one
 * thing on this screen that changes without the reader, so the server reads the
 * accounts while somebody is looking and pushes each device the moment it is
 * found changed (`use-device-stream`). The screen opens on what this browser
 * last saw (`device-cache`) and the reads that follow move only the devices that
 * differ - so a screen nothing happened to does not visibly change. "Check
 * again" stays, for the read that wakes the devices themselves.
 */

import * as actions from "../actions";
import type { AccountNetwork } from "../../lib/network-details";
import { DeviceDialog } from "./device-dialog";
import { ConnectDialog, type Connected } from "./connect-dialog";
import { NukiLocalDialog } from "./nuki-local-dialog";
import { RoomsDialog } from "./rooms-dialog";
import { AccountOptionsDialog } from "./account-options-dialog";
import { AccountsTable, AccountsTableSkeleton } from "./accounts-table";
import { GoneDevices, HandoverNotes } from "./handover-notes";
import * as kinds from "../../lib/device-kinds";
import { batteryLine, batteryLow } from "../../lib/automation-kinds";
import type { PlaceView } from "../../lib/place-kinds";
import type { DeviceAccountView } from "../../lib/device-accounts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as registry from "../../lib/device-connections";
import { BatteryMeter } from "./battery-meter";
import {
    BatteryCharging,
    Link2,
    BatteryLow,
    Check,
    DoorOpen,
    Eye,
    HardDrive,
    MoreHorizontal,
    Plus,
    RefreshCw,
    Video,
    Workflow
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import * as list from "../../lib/device-list";
import type { HardwareView, ListEntry } from "../../lib/device-list";
import type { RoomView } from "../../lib/room-kinds";
import { usePlaceRooms } from "../use-place-rooms";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";
import { useDeviceAct } from "./use-device-act";
import { DeviceControls, DeviceIcon, DevicePanel, stateClass } from "./device-panel";
import { FilterChip } from "./air-controls";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    EmptyState,
    Skeleton,
    SearchField,
    cn
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { usePlacesT } from "../use-places-t";
import { placesRefusalText } from "../../lib/refusal-text";
import { readCachedDevices, writeCachedDevices } from "./device-cache";
import {
    applyDeviceChange,
    mergeDevices,
    sameAccounts,
    type DeviceChange
} from "../../lib/device-diff";
import { markSeen, useDeviceStream, useSeenAt } from "./use-device-stream";

const { runAction } = hostUi.runAction;
const { RelativeTime } = hostUi.relativeTime;

/** Record when each device in a full list was read. */
function markRead(devices: readonly DeviceView[]): void {
    markSeen(devices.map((device) => [device.id, device.stateAt] as const));
}

/**
 * How many rows are drawn before "Show more". A house of thirty devices never
 * sees it; one with hundreds of sockets and sensors does not draw them all on
 * every push.
 */
const PAGE = 100;

/** Where a camera, UPS or NAS opens: a camera on its own screen, the rest on
 *  theirs. */
function hardwareHref(hardware: HardwareView): string | null {
    return hardware.kind === "camera"
        ? `/places/cameras?open=${encodeURIComponent(hardware.id)}`
        : hardware.href;
}

export function DevicesView({
    places,
    placeId,
    cacheKey,
    canControl,
    canManage,
    section = "devices",
    initialAccount = null
}: {
    places: readonly PlaceView[];
    /** The place being looked at. */
    placeId: string;
    /** Whose screen of which place this is, for what this browser keeps of it. */
    cacheKey: string;
    canControl: boolean;
    canManage: boolean;
    /** Which screen this is: the devices, or the accounts they come from. One
     *  view for both, so both share one read, one live stream and one cache. */
    section?: "devices" | "accounts";
    /** The account the devices screen opens narrowed to (`?account=`). */
    initialAccount?: string | null;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const onAccounts = section === "accounts";
    const [devices, setDevices] = useState<DeviceView[] | null>(null);
    const [accounts, setAccounts] = useState<DeviceAccountView[]>([]);
    const [connecting, setConnecting] = useState(false);
    const [arranging, setArranging] = useState(false);
    /** The account being given a new credential, where that is what the dialog is
     *  open for. Null is connecting something new. */
    const [reconnecting, setReconnecting] = useState<DeviceAccountView | null>(null);
    const [editing, setEditing] = useState<DeviceView | null>(null);
    const [networks, setNetworks] = useState<AccountNetwork[]>([]);
    const [opened, setOpened] = useState<DeviceView | null>(null);
    const [disconnecting, setDisconnecting] = useState<DeviceAccountView | null>(null);
    /** A device that left, about to be removed for good. */
    const [forgetting, setForgetting] = useState<DeviceView | null>(null);
    /** The account whose switches are open, by id: read from the list so a
     *  switch flipped there is the switch drawn here. */
    const [adjusting, setAdjusting] = useState<string | null>(null);
    const [linking, setLinking] = useState<DeviceAccountView | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    // A device that left the house is listed apart, off limits, not among these.
    const here = useMemo(() => (devices ?? []).filter((device) => !device.gone), [devices]);
    const gone = useMemo(() => (devices ?? []).filter((device) => device.gone), [devices]);
    const [hardware, setHardware] = useState<HardwareView[] | null>(null);
    const [rooms, setRooms] = usePlaceRooms(placeId);
    const [query, setQuery] = useState("");
    const [kindsShown, setKindsShown] = useState<ReadonlySet<string>>(() => new Set());
    const [limit, setLimit] = useState(PAGE);
    const entries = useMemo(() => list.listEntries(here, hardware ?? []), [here, hardware]);
    const present = useMemo(() => list.presentGroups(entries, t), [entries, t]);
    const roomNames = useMemo(
        () => new Map((rooms ?? []).map((room) => [room.id, room.name] as const)),
        [rooms]
    );
    /** The account a row of the accounts table narrowed the list to. One that
     *  has since gone narrows nothing. */
    const [accountPicked, setAccountPicked] = useState<string | null>(initialAccount);
    const accountShown = accounts.find((account) => account.id === accountPicked) ?? null;
    const filtered = useMemo(() => {
        const found = list.filterEntries(entries, { groups: kindsShown, query }, t, (id) =>
            roomNames.get(id)
        );
        return accountShown
            ? found.filter(
                  (entry) => entry.type === "device" && entry.device.accountId === accountShown.id
              )
            : found;
    }, [entries, kindsShown, query, t, roomNames, accountShown]);
    const groups = useMemo(
        () => list.groupEntries(filtered.slice(0, limit), t),
        [filtered, limit, t]
    );
    // A new search starts from the top of the list rather than deep in it.
    useEffect(() => setLimit(PAGE), [query, kindsShown, accountPicked]);

    /** When each device was last pushed, so a full read that began before a
     *  push cannot put the older state back. */
    const pushedAt = useRef(new Map<string, number>());
    /** A full list from the server, moving only the devices that differ. */
    const take = useCallback(
        (
            result: { devices?: DeviceView[]; accounts?: DeviceAccountView[] },
            /** When the read began; a read with none is taken whole. */
            startedAt = Number.POSITIVE_INFINITY
        ) => {
            if (result.devices) {
                const next = result.devices;
                const newer = (id: string) => (pushedAt.current.get(id) ?? -1) >= startedAt;
                markRead(next.filter((entry) => !newer(entry.id)));
                setDevices((current) => mergeDevices(current, next, newer));
                setOpened((current) =>
                    current && !newer(current.id)
                        ? (next.find((entry) => entry.id === current.id) ?? current)
                        : current
                );
            }
            if (result.accounts) {
                const next = result.accounts;
                setAccounts((current) => (sameAccounts(current, next) ? current : next));
            }
        },
        []
    );

    /** The stored list, read again: no account is called. */
    const reread = useCallback(async () => {
        const startedAt = Date.now();
        take(await actions.listDevicesAction(), startedAt);
    }, [take]);

    /** Which screen the list on display belongs to, so another place's doors
     *  are never kept under this one's name while a switch is being read. */
    const listedFor = useRef<string | null>(null);

    // What this browser last saw, drawn before the first paint so a cached
    // screen never shows a skeleton; then the stored list, which moves only
    // what differs from it. Another place with nothing kept waits for its
    // read rather than showing this one's doors.
    useLayoutEffect(() => {
        const cached = readCachedDevices(cacheKey);
        listedFor.current = cached ? cacheKey : null;
        if (cached) markRead(cached.devices);
        setDevices(cached ? cached.devices : null);
        if (cached) setAccounts(cached.accounts);
    }, [cacheKey]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const startedAt = Date.now();
            const result = await actions.listDevicesAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            listedFor.current = cacheKey;
            take({ devices: result.devices ?? [], accounts: result.accounts ?? [] }, startedAt);
        })();
        return () => {
            cancelled = true;
        };
    }, [cacheKey, take]);

    const loadHardware = useCallback(async () => {
        const result = await actions
            .listPlaceHardwareAction()
            .catch(() => ({ hardware: undefined, error: undefined }));
        setHardware(result.hardware ?? []);
        if (result.error) setError(result.error);
    }, []);

    useEffect(() => {
        setHardware(null);
        void loadHardware();
    }, [cacheKey, loadHardware]);

    useEffect(() => {
        if (devices && listedFor.current === cacheKey) {
            writeCachedDevices(cacheKey, { devices, accounts });
        }
    }, [cacheKey, devices, accounts]);

    /**
     * Ask the account what it has now.
     *
     * `quiet` is spent without a spinner on a screen nobody asked to wait for -
     * the one-shot read fired a few seconds after a press, to catch a lock as
     * it settles, rather than making the devices themselves speak up. The loud
     * version is somebody pressing "Check again", and that one is allowed to
     * wake them: it is the difference between "as far as we know" and "as of
     * now", and it is only ever spent when a person asked for it.
     *
     * When it was last checked comes back with the devices, which is what moves
     * each row's "Updated" line (`markRead` through `take`).
     */
    const sync = useCallback(
        async (quiet = false) => {
            if (!quiet) setRefreshing(true);
            const startedAt = Date.now();
            const result = await actions.syncDevicesAction({ probe: !quiet });
            if (!quiet) setRefreshing(false);
            take(result, startedAt);
            if (!quiet) setError(result.error ?? "");
        },
        [take]
    );

    /** Put a change into both lists a device can be in, so the row and the open
     *  panel never disagree about what a door is doing. */
    const update = useCallback((change: (entry: DeviceView) => DeviceView) => {
        setDevices((current) => (current ?? []).map(change));
        setOpened((current) => (current ? change(current) : current));
    }, []);
    const settle = (device: DeviceView) =>
        update((entry) => (entry.id === device.id ? device : entry));

    const { busy, act } = useDeviceAct({ update, setError, resync: () => void sync(true) });

    const connected = accounts.length > 0;
    const accountList = JSON.stringify(accounts.map(({ id, settings }) => [id, settings]));
    useEffect(() => {
        if (!canManage || !connected) return;
        let current = true;
        void actions.accountNetworksAction().then(
            (answer) => {
                if (current) setNetworks(answer.networks ?? []);
            },
            () => {
                if (current) setNetworks([]);
            }
        );
        return () => {
            current = false;
        };
    }, [canManage, connected, accountList]);

    /**
     * A pushed change. Only the devices it names move; the "updated" line moves
     * for every device it confirms. An account connected or removed somewhere
     * else changes which devices are here at all, so that is read again whole.
     */
    const heldAccounts = useRef(accounts);
    heldAccounts.current = accounts;
    // A device being pressed is left alone until its answer: a read that
    // started before the press would otherwise flip the switch back under the
    // finger. Its answer, and the push that follows it, settle it.
    const pressing = useRef<string | null>(null);
    pressing.current = busy?.id ?? null;
    const receive = useCallback(
        (pushed: DeviceChange) => {
            const seen = pushed.seen;
            if (seen) markSeen(seen.ids.map((id) => [id, seen.at] as const));
            const change = {
                ...pushed,
                devices: pushed.devices.filter((entry) => entry.id !== pressing.current)
            };
            if (change.devices.length || change.removed.length) {
                const now = Date.now();
                for (const entry of change.devices) pushedAt.current.set(entry.id, now);
                for (const id of change.removed) pushedAt.current.set(id, now);
                setDevices((current) => applyDeviceChange(current, change));
                const gone = new Set(change.removed);
                setOpened((current) => {
                    if (!current) return current;
                    if (gone.has(current.id)) return null;
                    return change.devices.find((entry) => entry.id === current.id) ?? current;
                });
            }
            const next = change.accounts;
            if (next) {
                const before = heldAccounts.current.map((account) => account.id).sort();
                const after = next.map((account) => account.id).sort();
                setAccounts((current) => (sameAccounts(current, next) ? current : [...next]));
                if (before.join() !== after.join()) void reread();
            }
        },
        [reread]
    );

    // Every open - the first, a tab brought back, a dropped connection -
    // catches up on what it was not told: a change that landed between the
    // read above and the stream subscribing is never pushed afterwards.
    useDeviceStream({
        enabled: devices !== null,
        placeId,
        onChange: receive,
        onReady: () => void reread()
    });

    // Stable across renders, so a row whose device did not change is not
    // redrawn because the screen around it was.
    const latestAct = useRef(act);
    latestAct.current = act;
    const actOnRow = useCallback(
        (device: DeviceView, action: DeviceAction, command?: DeviceCommand) => {
            // Thrown by `act` so the panel can show it; on the row the line above
            // the list already has.
            void latestAct.current(device, action, command).catch(() => undefined);
        },
        []
    );
    const openDevice = useCallback((device: DeviceView) => setOpened(device), []);

    /**
     * Put a device, camera, UPS or NAS in a room. Moved on screen at once, and
     * put back with the reason if the server refuses.
     */
    const assign = useCallback(
        async (entry: ListEntry, roomId: string | null) => {
            const before = list.entryRoom(entry);
            if (before === roomId) return;
            const move = (to: string | null) =>
                entry.type === "device"
                    ? update((item) =>
                          item.id === entry.device.id ? { ...item, roomId: to } : item
                      )
                    : setHardware((current) =>
                          (current ?? []).map((item) =>
                              item.kind === entry.hardware.kind && item.id === entry.hardware.id
                                  ? { ...item, roomId: to }
                                  : item
                          )
                      );
            move(roomId);
            const result = await runAction(
                () =>
                    actions.assignRoomAction({
                        kind: entry.type === "device" ? "device" : entry.hardware.kind,
                        id: entry.type === "device" ? entry.device.id : entry.hardware.id,
                        roomId
                    }),
                setError
            );
            if (!result || result.error) {
                move(before);
                if (result?.error) setError(result.error);
            }
        },
        [update]
    );

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
        take({ devices: result.devices ?? [], accounts: result.accounts ?? [] });
    };

    const settleGone = async (device: DeviceView, choice: "restore" | "forget") => {
        const result = await runAction(
            () => actions.settleGoneDeviceAction(device.id, choice),
            setError
        );
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        take({ devices: result.devices ?? [] });
    };
    const forget = async () => {
        if (!forgetting) return;
        await settleGone(forgetting, "forget");
        setForgetting(null);
    };

    /** One dialog, two jobs, and the difference is which account it was opened
     *  on. Closing it has to forget that either way. */
    const settleConnection = (result: Connected) => {
        take(result);
        setConnecting(false);
        setReconnecting(null);
    };
    const closeConnect = () => {
        setConnecting(false);
        setReconnecting(null);
    };

    // One dialog, in the same place in every branch below: it can be opened
    // while the list is still being read, and a dialog that moved when the list
    // arrived would be a new one - with whatever had been typed into it gone.
    const connectDialog = (
        <ConnectDialog
            open={connecting || reconnecting !== null}
            reconnect={reconnecting}
            onClose={closeConnect}
            onConnected={settleConnection}
        />
    );

    // Still reading: the bar's own frame, with the button that connects
    // something already live. Only the accounts and the devices wait, since they
    // are what the read decides. t("devicesView.checkAgain") waits too - there is nothing yet
    // to check again.
    if (devices === null || (!connected && hardware === null)) {
        return (
            <>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Skeleton className="h-8 w-48" />
                        <span className="flex-1" />
                        {canManage && (
                            <Button size="sm" onClick={() => setConnecting(true)}>
                                <Plus className="size-4 shrink-0" />
                                {t("devicesView.connect")}
                            </Button>
                        )}
                    </div>
                    {onAccounts ? <AccountsTableSkeleton /> : <Skeleton className="h-20 w-full" />}
                </div>
                {connectDialog}
            </>
        );
    }

    if (!connected && hardware !== null && hardware.length === 0) {
        return (
            <>
                <EmptyState
                    title={t("devicesView.emptyTitle")}
                    description={
                        canManage ? t("devicesView.emptyManage") : t("devicesView.emptyView")
                    }
                    action={
                        canManage ? (
                            <Button size="sm" onClick={() => setConnecting(true)}>
                                <Plus className="size-4 shrink-0" />
                                {t("devicesView.connect")}
                            </Button>
                        ) : undefined
                    }
                />
                {connectDialog}
            </>
        );
    }

    // Held as a value so the dialog can sit beside it, where the two branches
    // above put theirs.
    const view = (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1" />
                {!onAccounts && accounts.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => router.push("/places/devices/accounts")}>
                        <Link2 className="size-4 shrink-0" />
                        {t("devicesView.accounts")}
                    </Button>
                )}
                {canManage && !onAccounts && (
                    <Button size="sm" variant="outline" onClick={() => setArranging(true)}>
                        <DoorOpen className="size-4 shrink-0" />
                        {t("devicesView.rooms")}
                    </Button>
                )}
                {canManage && (
                    <Button size="sm" onClick={() => setConnecting(true)}>
                        <Plus className="size-4 shrink-0" />
                        {t("devicesView.connect")}
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("devicesView.checkAgain")}
                    title={t("devicesView.checkAgain")}
                    disabled={refreshing}
                    onClick={() => void sync()}
                >
                    <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
                </Button>
            </div>

            {onAccounts && accounts.length === 0 && (
                <EmptyState
                    title={t("devicesView.noAccountsTitle")}
                    description={
                        canManage ? t("devicesView.noAccountsManage") : t("devicesView.noAccountsView")
                    }
                />
            )}

            {onAccounts && accounts.length > 0 && (
                <AccountsTable
                    accounts={accounts}
                    canManage={canManage}
                    shownAccountId={null}
                    onShowDevices={(id) =>
                        router.push(
                            id ? `/places/devices?account=${encodeURIComponent(id)}` : "/places/devices"
                        )
                    }
                    onReconnect={setReconnecting}
                    onConnect={() => setConnecting(true)}
                    onLink={setLinking}
                    onAdjust={setAdjusting}
                    onDisconnect={setDisconnecting}
                />
            )}

            {!onAccounts && accountShown && (
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium" title={accountShown.label}>
                        {t("devicesView.devicesOf", { name: accountShown.label })}
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            setAccountPicked(null);
                            router.replace("/places/devices");
                        }}
                    >
                        {t("devicesView.showAllDevices")}
                    </Button>
                </div>
            )}

            {onAccounts && (
                <HandoverNotes accounts={accounts} canManage={canManage} onRemove={setDisconnecting} />
            )}

            {accounts
                // One left empty by a move says so above, with its own button.
                .filter((account) => account.status !== "ok" && !account.movedOut)
                .map((account) => {
                    // A plan that ran out at the maker is fixed in the maker's
                    // console, so the way there is offered - and, where the make
                    // has a way in that needs no such plan, that one beside it.
                    const connection = registry.deviceConnection(account.connection);
                    const said = connection ? registry.connectionWords(t, connection) : null;
                    const instead = registry.recommendedConnection(account.brand);
                    const offerInstead =
                        account.status === "lapsed" && instead && instead.id !== account.connection;
                    return (
                        <div
                            key={account.id}
                            className="flex flex-wrap items-center gap-3 rounded-lg border border-danger-edge bg-danger-soft px-3 py-2"
                        >
                            <p className="min-w-0 flex-1 text-sm text-danger">
                                {account.status === "unauthorized"
                                    ? t("devicesView.refused", { name: account.label })
                                    : account.status === "lapsed"
                                      ? t("devicesView.lapsed", { name: account.label })
                                      : t("devicesView.unreachable", { name: account.label })}
                                {account.statusNote
                                    ? ` ${placesRefusalText(t, account.statusNote)}`
                                    : ""}
                            </p>
                            {canManage && account.status === "unauthorized" && (
                                <Button size="sm" onClick={() => setReconnecting(account)}>
                                    {t("devicesView.reconnect")}
                                </Button>
                            )}
                            {account.status === "lapsed" && connection?.link && (
                                <Button asChild size="sm">
                                    <a href={connection.link.href} target="_blank" rel="noreferrer">
                                        {t("devicesView.openWhere", {
                                            where: said?.link?.label ?? connection.link.label
                                        })}
                                    </a>
                                </Button>
                            )}
                            {canManage && offerInstead && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setConnecting(true)}
                                >
                                    {t("devicesView.connectInstead", {
                                        label: registry.connectionWords(t, instead).label
                                    })}
                                </Button>
                            )}
                        </div>
                    );
                })}

            {error && (
                <p
                    role="alert"
                    className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                    {error}
                </p>
            )}

            {!onAccounts && (
                <>
            {devices.some((device) => device.placeId === null) && (
                <p className="text-xs text-muted-foreground">{t("devicesView.unplacedNote")}</p>
            )}

            <GoneDevices
                devices={gone}
                canManage={canManage}
                onSettle={async (device, choice) => {
                    if (choice === "forget") setForgetting(device);
                    else await settleGone(device, choice);
                }}
            />

            {entries.length > 0 && (present.length > 1 || entries.length > 8) && (
                <div className="flex flex-wrap items-center gap-2">
                    <SearchField
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("devicesView.search")}
                        aria-label={t("devicesView.search")}
                        wrapperClassName="flex-1 sm:max-w-xs"
                    />
                    {present.length > 1 && (
                        <div
                            role="group"
                            aria-label={t("devicesView.typeFilter")}
                            className="flex min-w-0 flex-wrap items-center gap-1.5"
                        >
                            <Button
                                size="sm"
                                variant={kindsShown.size === 0 ? "secondary" : "ghost"}
                                aria-pressed={kindsShown.size === 0}
                                onClick={() => setKindsShown(new Set())}
                            >
                                {t("devicesView.allTypes")}
                            </Button>
                            {present.map((label) => {
                                const on = kindsShown.has(label);
                                return (
                                    <Button
                                        key={label}
                                        size="sm"
                                        variant={on ? "secondary" : "ghost"}
                                        aria-pressed={on}
                                        onClick={() =>
                                            setKindsShown((current) => {
                                                const next = new Set(current);
                                                if (on) next.delete(label);
                                                else next.add(label);
                                                return next;
                                            })
                                        }
                                    >
                                        {label}
                                    </Button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {entries.length === 0 && gone.length > 0 ? null : entries.length === 0 ? (
                <EmptyState
                    title={t("devicesView.nothingTitle")}
                    description={t("devicesView.nothingBody")}
                />
            ) : filtered.length === 0 ? (
                <EmptyState
                    title={t("devicesView.noMatchTitle")}
                    description={t("devicesView.noMatchBody")}
                />
            ) : (
                <div className="flex flex-col gap-6">
                    {groups.map((group) => (
                        <section key={group.label} className="flex flex-col gap-2">
                            {groups.length > 1 && (
                                <h2 className="text-xs font-medium text-muted-foreground">
                                    {group.label}
                                </h2>
                            )}
                            <ul className="flex flex-col gap-2">
                                {group.entries.map((entry) =>
                                    entry.type === "device" ? (
                                        <DeviceRow
                                            key={entry.key}
                                            device={entry.device}
                                            canControl={canControl}
                                            canManage={canManage}
                                            placeId={placeId}
                                            rooms={rooms}
                                            busy={
                                                busy?.id === entry.device.id ? busy.action : null
                                            }
                                            onOpen={openDevice}
                                            onAct={actOnRow}
                                            onAssign={assign}
                                        />
                                    ) : (
                                        <HardwareRow
                                            key={entry.key}
                                            entry={entry}
                                            canManage={canManage}
                                            placeId={placeId}
                                            rooms={rooms}
                                            roomName={
                                                entry.hardware.roomId
                                                    ? roomNames.get(entry.hardware.roomId)
                                                    : undefined
                                            }
                                            onAssign={assign}
                                        />
                                    )
                                )}
                            </ul>
                        </section>
                    ))}
                    {filtered.length > limit && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="self-center"
                            onClick={() => setLimit((current) => current + PAGE)}
                        >
                            {t("devicesView.showMore", {
                                count: Math.min(PAGE, filtered.length - limit)
                            })}
                        </Button>
                    )}
                </div>
            )}
                </>
            )}
            <DevicePanel
                device={opened}
                canControl={canControl}
                canManage={canManage}
                placeId={placeId}
                networks={networks}
                devices={here}
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
                onTracked={settle}
            />

            <NukiLocalDialog account={linking} onClose={() => setLinking(null)} />
            <RoomsDialog
                open={arranging}
                placeId={placeId}
                onClose={() => setArranging(false)}
                onChanged={() => {
                    void sync();
                    void loadHardware();
                    void actions.listRoomsAction(placeId).then(
                        (result) => setRooms(result.rooms ?? []),
                        () => undefined
                    );
                }}
            />
            <AccountOptionsDialog
                account={accounts.find((account) => account.id === adjusting) ?? null}
                onClose={() => setAdjusting(null)}
                onChanged={(changed) =>
                    setAccounts((current) =>
                        current.map((account) => (account.id === changed.id ? changed : account))
                    )
                }
            />
            <ConfirmDeleteDialog
                open={disconnecting !== null}
                onOpenChange={(open) => (open ? undefined : setDisconnecting(null))}
                name={disconnecting?.label ?? ""}
                kind="connection"
                title={t("devicesView.disconnectTitle")}
                question={t.rich("devicesView.disconnectQuestion", {
                    name: disconnecting?.label ?? "",
                    em: (chunks) => <span className="font-medium text-foreground">{chunks}</span>
                })}
                requireTyping={false}
                description={
                    disconnecting?.movedOut
                        ? t("devicesView.disconnectMovedBody", { to: disconnecting.movedOut.to })
                        : t("devicesView.disconnectBody")
                }
                confirmLabel={t("devicesView.disconnect")}
                onConfirm={disconnect}
            />
            <ConfirmDeleteDialog
                open={forgetting !== null}
                onOpenChange={(open) => (open ? undefined : setForgetting(null))}
                name={forgetting?.name ?? ""}
                kind="device"
                title={t("devicesView.goneRemoveTitle")}
                question={t.rich("devicesView.goneRemoveQuestion", {
                    name: forgetting?.name ?? "",
                    em: (chunks) => <span className="font-medium text-foreground">{chunks}</span>
                })}
                requireTyping={false}
                description={t("devicesView.goneRemoveBody")}
                confirmLabel={t("devicesView.goneRemove")}
                onConfirm={forget}
            />
        </div>
    );

    return (
        <>
            {view}
            {connectDialog}
        </>
    );
}

/**
 * One device on the list.
 *
 * Memoized, and handed the very object the list held unless that device
 * changed: a push about one door redraws that door's row and no other. When it
 * was last read is not part of what it is handed, for the same reason - see
 * `DeviceFreshness`.
 */
const DeviceRow = memo(function DeviceRow({
    device,
    canControl,
    canManage,
    placeId,
    rooms,
    busy,
    onOpen,
    onAct,
    onAssign
}: {
    device: DeviceView;
    canControl: boolean;
    canManage: boolean;
    placeId: string;
    rooms: readonly RoomView[] | null;
    busy: DeviceAction | null;
    onOpen: (device: DeviceView) => void;
    onAct: (device: DeviceView, action: DeviceAction, command?: DeviceCommand) => void;
    onAssign: (entry: ListEntry, roomId: string | null) => void;
}) {
    const t = usePlacesT();
    const entry: ListEntry = { type: "device", key: `device:${device.id}`, device };
    const actions: RowActions = {
        name: device.name,
        open: () => onOpen(device),
        rooms: canManage ? (rooms ?? []) : null,
        roomId: device.roomId ?? null,
        assign: (roomId) => onAssign(entry, roomId),
        automation: canManage ? list.automationHref(entry, placeId) : null
    };
    const details = [
        device.zone,
        device.model,
        device.doorState === "none" ? null : kinds.doorText(device.doorState, t)
    ]
        .filter(Boolean)
        .join(" - ");
    return (
        <RowShell actions={actions}>
            <button
                type="button"
                onClick={() => onOpen(device)}
                className="flex min-w-[10rem] flex-1 flex-col items-start gap-0.5 text-start"
            >
                <span className="flex min-w-0 max-w-full items-center gap-2">
                    <DeviceIcon
                        kind={device.kind}
                        className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate text-sm font-medium" title={device.name}>
                        {device.name}
                    </span>
                    <Badge className={cn("shrink-0", stateClass(device))}>
                        {kinds.badgeText(device, t)}
                    </Badge>
                    <FilterChip air={device.air} />
                    <BatteryMeter device={device} />
                    {batteryLow(device) && (
                        <Badge
                            className="shrink-0 gap-1 border-danger-edge bg-danger-soft text-danger-ink"
                            title={t("devicesView.batteryLowTitle", {
                                percent: batteryLine(device)
                            })}
                        >
                            <BatteryLow className="size-3 shrink-0" />
                            {t("power.labels.battery")}
                        </Badge>
                    )}
                    {device.placeId === null && (
                        <Badge className="shrink-0 border-border bg-muted text-muted-foreground">
                            {t("devicesView.notPlaced")}
                        </Badge>
                    )}
                </span>
                <span className="max-w-full truncate text-[0.6875rem] text-foreground-subtle">
                    {details}
                    <DeviceFreshness
                        id={device.id}
                        online={device.online}
                        separated={details.length > 0}
                    />
                </span>
            </button>
            <DeviceControls
                device={device}
                canControl={canControl}
                busy={busy}
                onAct={(action, command) => onAct(device, action, command)}
            />
        </RowShell>
    );
});

/**
 * When a device's state was last confirmed, beside it. A device that is not
 * answering says so in its badge, so this says nothing for it rather than the
 * same thing twice. Subscribed on its own, so the reads that confirm every
 * device move this line and leave the rest of the row alone.
 */
function DeviceFreshness({
    id,
    online,
    separated
}: {
    id: string;
    online: boolean;
    /** Whether something is printed before it on the line. */
    separated: boolean;
}) {
    const t = usePlacesT();
    const at = useSeenAt(id);
    if (!online || !at) return null;
    return (
        <span>
            {separated ? " - " : ""}
            {t("devicesView.updated")} <RelativeTime iso={at} formatStyle="narrow" />
        </span>
    );
}

/** What a row's menu offers, the same behind the three dots and a right-click. */
interface RowActions {
    readonly name: string;
    readonly open: () => void;
    /** The rooms it can be moved to; null where this reader may not move it. */
    readonly rooms: readonly RoomView[] | null;
    readonly roomId: string | null;
    readonly assign: (roomId: string | null) => void;
    readonly automation: string | null;
}

/** The pieces of one menu kind, so the dots and the right-click draw the same
 *  items from one list. */
interface MenuParts {
    Item: ComponentType<{
        onSelect?: (event: Event) => void;
        disabled?: boolean;
        role?: string;
        "aria-checked"?: boolean;
        children?: ReactNode;
    }>;
    Sub: ComponentType<{ children?: ReactNode }>;
    SubTrigger: ComponentType<{ children?: ReactNode }>;
    SubContent: ComponentType<{ children?: ReactNode }>;
    Separator: ComponentType;
}

const DROPDOWN_PARTS: MenuParts = {
    Item: DropdownMenuItem,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    Separator: DropdownMenuSeparator
};

const CONTEXT_PARTS: MenuParts = {
    Item: ContextMenuItem,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
    Separator: ContextMenuSeparator
};

/** Whether a row has anything to offer beyond opening it, which a click does. */
function hasMenu(actions: RowActions): boolean {
    return actions.rooms !== null || actions.automation !== null;
}

function RowMenuItems({ actions, parts }: { actions: RowActions; parts: MenuParts }) {
    const t = usePlacesT();
    const router = useRouter();
    const { Item, Sub, SubTrigger, SubContent, Separator } = parts;
    const room = (id: string | null, label: string) => (
        <Item
            key={id ?? ""}
            role="menuitemradio"
            aria-checked={actions.roomId === id}
            onSelect={() => actions.assign(id)}
        >
            <Check
                className={cn("size-4 shrink-0", actions.roomId === id ? "" : "opacity-0")}
            />
            <span className="min-w-0 truncate" title={label}>
                {label}
            </span>
        </Item>
    );
    return (
        <>
            <Item onSelect={actions.open}>
                <Eye className="size-4 shrink-0" />
                {t("devicesView.open")}
            </Item>
            {actions.rooms !== null || actions.automation !== null ? <Separator /> : null}
            {actions.rooms !== null && (
                <Sub>
                    <SubTrigger>
                        <DoorOpen className="size-4 shrink-0" />
                        {t("devicesView.moveToRoom")}
                    </SubTrigger>
                    <SubContent>
                        {room(null, t("devicesView.noRoom"))}
                        {actions.rooms.length > 0 ? <Separator /> : null}
                        {actions.rooms.map((entry) => room(entry.id, entry.name))}
                    </SubContent>
                </Sub>
            )}
            {actions.automation !== null && (
                <Item onSelect={() => router.push(actions.automation as string)}>
                    <Workflow className="size-4 shrink-0" />
                    {t("devicesView.createAutomation")}
                </Item>
            )}
        </>
    );
}

/** The three dots at the end of a row. */
function RowMenu({ actions }: { actions: RowActions }) {
    const t = usePlacesT();
    const label = t("devicesView.moreFor", { name: actions.name });
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label={label}
                    title={label}
                >
                    <MoreHorizontal className="size-4 shrink-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <RowMenuItems actions={actions} parts={DROPDOWN_PARTS} />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** A row that also answers a right-click with the same menu as its dots. */
function RowShell({ actions, children }: { actions: RowActions; children: ReactNode }) {
    const row = (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
            {children}
            {hasMenu(actions) && <RowMenu actions={actions} />}
        </li>
    );
    if (!hasMenu(actions)) return row;
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent>
                <RowMenuItems actions={actions} parts={CONTEXT_PARTS} />
            </ContextMenuContent>
        </ContextMenu>
    );
}

const HARDWARE_ICONS = { camera: Video, ups: BatteryCharging, nas: HardDrive } as const;

/** A camera, UPS or NAS on the list. Each opens its own screen. */
function HardwareRow({
    entry,
    canManage,
    placeId,
    rooms,
    roomName,
    onAssign
}: {
    entry: Extract<ListEntry, { type: "hardware" }>;
    canManage: boolean;
    placeId: string;
    rooms: readonly RoomView[] | null;
    roomName: string | undefined;
    onAssign: (entry: ListEntry, roomId: string | null) => void;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const { hardware } = entry;
    const href = hardwareHref(hardware);
    const Icon = HARDWARE_ICONS[hardware.kind];
    const details = [hardware.model, roomName].filter(Boolean).join(" - ");
    const actions: RowActions = {
        name: hardware.name,
        open: () => {
            if (href) router.push(href);
        },
        rooms: hardware.canArrange ? (rooms ?? []) : null,
        roomId: hardware.roomId,
        assign: (roomId) => onAssign(entry, roomId),
        automation: canManage ? list.automationHref(entry, placeId) : null
    };
    const body = (
        <>
            <span className="flex min-w-0 max-w-full items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium" title={hardware.name}>
                    {hardware.name}
                </span>
                <Badge className="shrink-0 border-border bg-muted text-muted-foreground">
                    {t(`devicesView.kinds.${hardware.kind}`)}
                </Badge>
            </span>
            {details && (
                <span
                    className="max-w-full truncate text-[0.6875rem] text-foreground-subtle"
                    title={details}
                >
                    {details}
                </span>
            )}
        </>
    );
    const className = "flex min-w-[10rem] flex-1 flex-col items-start gap-0.5 text-start";
    return (
        <RowShell actions={actions}>
            {href ? (
                <Link href={href} className={className}>
                    {body}
                </Link>
            ) : (
                <div className={className}>{body}</div>
            )}
        </RowShell>
    );
}
