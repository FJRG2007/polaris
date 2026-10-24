"use client";

/**
 * A panel's cards with live devices behind them, for the wall and for the
 * editor alike.
 *
 * Two ways in. Signed in, a press is the devices screen's own
 * (`useDeviceAct`) and the live channel is the devices screen's
 * (`useDeviceStream`). Through the panel's link there is no session: a press
 * goes to the link's endpoint, which judges it against the panel, and the live
 * channel is the link's own. Either way a press moves the card at once and
 * moves it back on a refusal, and a reconnect reads the panel again.
 */

import { whereNow } from "@polaris/core";
import { PanelGrid } from "./panel-grid";
import { useRouter } from "next/navigation";
import { usePlacesT } from "../use-places-t";
import type { PanelCard } from "../../lib/panel-layout";
import { useDeviceAct } from "../devices/use-device-act";
import { useEffect, useMemo, useRef, useState } from "react";
import { LentActionsProvider } from "../devices/lent-actions";
import { applyPanelChange, optimisticDevice, rolledBack } from "./panel-state";
import { parseDeviceFrame, useDeviceStream } from "../devices/use-device-stream";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";
import { ClockCard, DeviceTile, GoneCard, RoomCard, type CardActs } from "./panel-cards";

export type BoardAccess =
    | { readonly kind: "session"; readonly canControl: boolean }
    | { readonly kind: "link"; readonly token: string; readonly allowed: readonly string[] };

export interface BoardRoom {
    readonly id: string;
    readonly name: string;
    readonly deviceIds: readonly string[];
}

/** The link's live channel, open while the wall is visible. */
function useLinkStream(
    token: string | null,
    onChange: (change: Parameters<typeof applyPanelChange>[1]) => void,
    onReady: () => void
): void {
    const handlers = useRef({ onChange, onReady });
    handlers.current = { onChange, onReady };
    useEffect(() => {
        if (!token || typeof EventSource === "undefined") return;
        let source: EventSource | null = null;
        const open = () => {
            if (source || document.visibilityState !== "visible") return;
            source = new EventSource(`/api/home/keys/${encodeURIComponent(token)}/live`);
            source.onmessage = (event: MessageEvent<string>) => {
                const frame = parseDeviceFrame(event.data);
                if (!frame) return;
                if (frame.kind === "ready") handlers.current.onReady();
                else handlers.current.onChange(frame);
            };
            source.onerror = () => {
                if (source?.readyState === EventSource.CLOSED) source = null;
            };
        };
        const shut = () => {
            source?.close();
            source = null;
        };
        const visibility = () => (document.visibilityState === "visible" ? open() : shut());
        open();
        document.addEventListener("visibilitychange", visibility);
        return () => {
            document.removeEventListener("visibilitychange", visibility);
            shut();
        };
    }, [token]);
}

/** A press through the panel's link, judged on the server against the panel. */
async function pressThroughLink(
    token: string,
    deviceId: string,
    action: DeviceAction,
    command?: DeviceCommand
): Promise<{ device?: DeviceView; error?: string }> {
    const send = async (where?: unknown) => {
        const response = await fetch(`/api/home/keys/${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, deviceId, ...(command ? { command } : {}), where })
        });
        const body = (await response.json().catch(() => ({}))) as {
            device?: DeviceView;
            error?: string;
            nearby?: string;
        };
        return { ok: response.ok, ...body };
    };
    let result = await send();
    if (!result.ok && result.nearby === "unasked") {
        const where = await whereNow();
        if (where) result = await send(where);
    }
    return result.ok ? { device: result.device } : { error: result.error ?? "" };
}

export function PanelBoard({
    placeId,
    cards,
    devices: initial,
    rooms,
    access,
    editing = false,
    onCardsChange,
    onError
}: {
    placeId: string;
    cards: readonly PanelCard[];
    devices: readonly DeviceView[];
    rooms: readonly BoardRoom[];
    access: BoardAccess;
    editing?: boolean;
    onCardsChange?: (cards: PanelCard[]) => void;
    onError: (message: string) => void;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const [devices, setDevices] = useState<DeviceView[]>([...initial]);
    // A fresh read from the server (a reconnect, a saved panel) replaces the list.
    useEffect(() => setDevices([...initial]), [initial]);
    const update = (change: (entry: DeviceView) => DeviceView) =>
        setDevices((list) => list.map(change));
    const resync = () => router.refresh();
    const sessionAct = useDeviceAct({ update, setError: onError, resync });
    const [linkBusy, setLinkBusy] = useState<{ id: string; action: DeviceAction } | null>(null);

    const live = (change: Parameters<typeof applyPanelChange>[1]) =>
        setDevices((list) => applyPanelChange(list, change));
    useDeviceStream({
        enabled: access.kind === "session",
        placeId,
        onChange: live,
        onReady: resync
    });
    useLinkStream(access.kind === "link" ? access.token : null, live, resync);

    const linkAct = async (device: DeviceView, action: DeviceAction, command?: DeviceCommand) => {
        if (access.kind !== "link") return;
        setLinkBusy({ id: device.id, action });
        onError("");
        const pressed = optimisticDevice(device, action, command);
        if (pressed) update((entry) => (entry.id === device.id ? pressed : entry));
        const result = await pressThroughLink(access.token, device.id, action, command);
        setLinkBusy(null);
        if (result.error !== undefined) {
            if (pressed) update((entry) => rolledBack(entry, device, pressed));
            onError(result.error || t("refusals.deviceCannot"));
            return;
        }
        if (result.device) update((entry) => (entry.id === device.id ? result.device! : entry));
    };

    const acts: CardActs =
        access.kind === "session"
            ? {
                  canControl: access.canControl,
                  busy: sessionAct.busy,
                  onAct: (device, action, command) =>
                      void sessionAct.act(device, action, command).catch(() => undefined)
              }
            : { canControl: false, busy: linkBusy, onAct: (d, a, c) => void linkAct(d, a, c) };

    // A link's grant decides button by button, as a lent door does.
    const lent = useMemo(
        () =>
            access.kind === "link"
                ? Object.fromEntries(devices.map((device) => [device.id, access.allowed]))
                : {},
        [access, devices]
    );
    const byId = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);
    const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);

    const labelOf = (card: PanelCard): string => {
        if (card.type === "device") return byId.get(card.deviceId)?.name ?? t("panels.addDevice");
        if (card.type === "room") return roomById.get(card.roomId)?.name ?? t("panels.addRoom");
        return t("panels.clock");
    };
    const render = (card: PanelCard) => {
        if (card.type === "clock") return <ClockCard />;
        if (card.type === "device") {
            const device = byId.get(card.deviceId);
            return device ? <DeviceTile device={device} acts={acts} /> : <GoneCard />;
        }
        const room = roomById.get(card.roomId);
        if (!room) return <GoneCard />;
        const inRoom = room.deviceIds.flatMap((id) => {
            const device = byId.get(id);
            return device ? [device] : [];
        });
        return <RoomCard name={room.name} devices={inRoom} acts={acts} />;
    };

    return (
        <LentActionsProvider lent={lent}>
            <PanelGrid
                cards={cards}
                editing={editing}
                onChange={(next) => onCardsChange?.(next)}
                render={render}
                labelOf={labelOf}
            />
        </LentActionsProvider>
    );
}
