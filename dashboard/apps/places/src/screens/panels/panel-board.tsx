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
 *
 * Cameras follow the same split: signed in, a camera card is the camera wall's
 * tile and opens its viewer; through the link it is the link's own live view
 * (`/api/home/keys/<token>/watch`), which only reaches the panel's cameras and
 * never carries a camera's address or account. An automation button runs
 * through `runAutomationAction` signed in and through the link's `run` route
 * otherwise, which only starts the automations the panel has a button for.
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
import { Button } from "@polaris/ui";
import { ShieldQuestion } from "lucide-react";
import { CameraViewer } from "../camera-viewer";
import type { CameraView } from "../../lib/cameras";
import type { PanelAutomation } from "../../lib/panels";
import type { GuestPanelCamera } from "../../lib/guest-key";
import { runAutomationAction } from "../automations/actions";
import {
    ActionCard,
    CameraCard,
    ClockCard,
    DeviceTile,
    GoneCard,
    GuestCameraCard,
    RoomCard,
    SensorCard,
    type CardActs
} from "./panel-cards";

export type BoardAccess =
    | {
          readonly kind: "session";
          readonly canControl: boolean;
          /** Running an automation is `home.manage`, as on its own screen. */
          readonly canRun: boolean;
      }
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

/** How often a signed-in wall asks which cameras the relay is serving. */
const LIVE_POLL_MS = 15_000;

/** The cameras the relay is serving now, asked again on a timer while the
 *  wall is visible and shows a camera. */
function useServedCameras(enabled: boolean): ReadonlySet<string> {
    const [live, setLive] = useState<ReadonlySet<string>>(new Set());
    useEffect(() => {
        if (!enabled) return;
        let gone = false;
        const ask = async () => {
            if (document.visibilityState !== "visible") return;
            const body = (await fetch("/api/home/cameras/live", { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .catch(() => null)) as { live?: string[] } | null;
            if (!gone && body?.live) setLive(new Set(body.live));
        };
        void ask();
        const timer = setInterval(() => void ask(), LIVE_POLL_MS);
        return () => {
            gone = true;
            clearInterval(timer);
        };
    }, [enabled]);
    return live;
}

/** A link's POST, asked again with the browser's location when the link is
 *  fenced and the first answer says so. */
async function postThroughLink(
    url: string,
    payload: Record<string, unknown>
): Promise<{ ok: boolean; device?: DeviceView; error?: string }> {
    const send = async (where?: unknown) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, where })
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
    return result;
}

/** A press through the panel's link, judged on the server against the panel. */
async function pressThroughLink(
    token: string,
    deviceId: string,
    action: DeviceAction,
    command?: DeviceCommand
): Promise<{ device?: DeviceView; error?: string }> {
    const result = await postThroughLink(`/api/home/keys/${encodeURIComponent(token)}`, {
        action,
        deviceId,
        ...(command ? { command } : {})
    });
    return result.ok ? { device: result.device } : { error: result.error ?? "" };
}

export function PanelBoard({
    placeId,
    cards,
    devices: initial,
    rooms,
    cameras = [],
    guestCameras = [],
    automations = [],
    access,
    editing = false,
    onCardsChange,
    onError
}: {
    placeId: string;
    cards: readonly PanelCard[];
    devices: readonly DeviceView[];
    rooms: readonly BoardRoom[];
    /** The panel's cameras, signed in. */
    cameras?: readonly CameraView[];
    /** The panel's cameras as its link sees them. */
    guestCameras?: readonly GuestPanelCamera[];
    automations?: readonly PanelAutomation[];
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
    const cameraById = useMemo(() => new Map(cameras.map((camera) => [camera.id, camera])), [cameras]);
    const guestCameraById = useMemo(
        () => new Map(guestCameras.map((camera) => [camera.id, camera])),
        [guestCameras]
    );
    const automationById = useMemo(
        () => new Map(automations.map((automation) => [automation.id, automation])),
        [automations]
    );
    const showsCamera = access.kind === "session" && cards.some((card) => card.type === "camera");
    const served = useServedCameras(showsCamera);
    const [viewing, setViewing] = useState<string | null>(null);
    const viewed = viewing ? (cameraById.get(viewing) ?? null) : null;

    /** Run one automation; an error sentence, or null once it started. */
    const runAutomation = async (id: string): Promise<string | null> => {
        onError("");
        const error =
            access.kind === "session"
                ? ((await runAutomationAction(id).catch(() => ({ error: "" }))).error ?? null)
                : await postThroughLink(`/api/home/keys/${encodeURIComponent(access.token)}/run`, {
                      automationId: id
                  }).then((result) => (result.ok ? null : (result.error ?? "")));
        if (error !== null) onError(error || t("panels.runFailed"));
        return error;
    };

    const labelOf = (card: PanelCard): string => {
        if (card.type === "device") return byId.get(card.deviceId)?.name ?? t("panels.addDevice");
        if (card.type === "room") return roomById.get(card.roomId)?.name ?? t("panels.addRoom");
        if (card.type === "sensor") return byId.get(card.deviceId)?.name ?? t("panels.addSensor");
        if (card.type === "camera")
            return (
                cameraById.get(card.cameraId)?.name ??
                guestCameraById.get(card.cameraId)?.name ??
                t("panels.addCamera")
            );
        if (card.type === "action")
            return automationById.get(card.automationId)?.name ?? t("panels.addAction");
        return t("panels.clock");
    };
    const render = (card: PanelCard) => {
        if (card.type === "clock") return <ClockCard />;
        if (card.type === "device") {
            const device = byId.get(card.deviceId);
            return device ? <DeviceTile device={device} acts={acts} /> : <GoneCard />;
        }
        if (card.type === "sensor") {
            const device = byId.get(card.deviceId);
            return device ? <SensorCard device={device} /> : <GoneCard />;
        }
        if (card.type === "camera") {
            if (access.kind === "link") {
                const camera = guestCameraById.get(card.cameraId);
                return camera ? <GuestCameraCard token={access.token} camera={camera} /> : <GoneCard />;
            }
            const camera = cameraById.get(card.cameraId);
            return camera ? (
                <CameraCard
                    camera={camera}
                    live={served.has(camera.id)}
                    canControl={access.canControl}
                    idle={viewing !== null || editing}
                    onOpen={() => setViewing(camera.id)}
                />
            ) : (
                <GoneCard />
            );
        }
        if (card.type === "action") {
            const automation = automationById.get(card.automationId);
            return automation ? (
                <ActionCard
                    automation={automation}
                    confirm={card.confirm}
                    // A link only hears of the automations it may start.
                    canRun={access.kind === "link" || access.canRun}
                    onRun={() => runAutomation(automation.id)}
                />
            ) : (
                <GoneCard />
            );
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
                extra={(card) =>
                    card.type === "action" && onCardsChange ? (
                        <Button
                            type="button"
                            size="sm"
                            variant={card.confirm ? "primary" : "outline"}
                            aria-pressed={card.confirm}
                            aria-label={t("panels.askFirst", { name: labelOf(card) })}
                            title={t("panels.askFirst", { name: labelOf(card) })}
                            onClick={() =>
                                onCardsChange(
                                    cards.map((entry) =>
                                        entry.id === card.id && entry.type === "action"
                                            ? { ...entry, confirm: !entry.confirm }
                                            : entry
                                    )
                                )
                            }
                            className="size-9 p-0"
                        >
                            <ShieldQuestion className="size-4" />
                        </Button>
                    ) : null
                }
            />
            {viewed && access.kind === "session" ? (
                <CameraViewer
                    camera={viewed}
                    canControl={access.canControl}
                    onClose={() => setViewing(null)}
                />
            ) : null}
        </LentActionsProvider>
    );
}
