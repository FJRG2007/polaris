/**
 * A door, a camera or a room handed out as a link, as the person holding it sees it.
 * No session: the token is the right, and the core page around this has
 * already checked that it names one of them and is in force now
 * (`app/k/[[...path]]`). This reads the thing and draws what the link allows.
 */

import { notFound } from "next/navigation";
import { guestKey, guestPanel, guestRoom } from "../../../lib/guest-key";
import { PanelWall } from "../../../screens/panels/panel-wall";
import { guestCamera } from "../../../lib/guest-camera";
import { GuestKeyView } from "../../../screens/guest/guest-key-view";
import { GuestCameraView } from "../../../screens/guest/guest-camera-view";
import { RoomFooter } from "../../../screens/guest/room-footer";

export const dynamic = "force-dynamic";

export default async function GuestKeyPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { token } = await params;
    if (typeof token !== "string") notFound();
    const panel = await guestPanel(token);
    if (panel) {
        if (panel.standing !== "live") notFound();
        return (
            <PanelWall
                name={panel.panel.name}
                placeId={panel.panel.placeId}
                cards={panel.panel.cards}
                devices={panel.devices}
                rooms={panel.rooms}
                guestCameras={panel.cameras}
                automations={panel.automations}
                access={{ kind: "link", token, allowed: panel.allowed }}
            />
        );
    }
    const camera = await guestCamera(token);
    if (camera) {
        if (camera.standing !== "live") notFound();
        return (
            <GuestCameraView
                token={token}
                name={camera.name}
                until={camera.until}
                note={camera.note}
                initiallyPrivate={camera.private}
            />
        );
    }
    const room = await guestRoom(token);
    if (room) {
        if (room.standing !== "live") notFound();
        return (
            <div className="flex flex-col gap-4">
                <h1 className="min-w-0 truncate text-lg font-medium" title={room.name}>
                    {room.name}
                </h1>
                {room.devices.map((device) => (
                    <GuestKeyView
                        key={device.id}
                        token={token}
                        deviceId={device.id}
                        initial={device}
                        allowed={room.allowed}
                        nearbyMeters={room.nearbyMeters}
                        until={null}
                        note=""
                    />
                ))}
                {room.cameras.map((camera) => (
                    <GuestCameraView
                        key={camera.id}
                        token={token}
                        cameraId={camera.id}
                        name={camera.name}
                        until={null}
                        note=""
                        onPress
                        initiallyPrivate={camera.private}
                    />
                ))}
                <RoomFooter
                    until={room.until}
                    note={room.note}
                    empty={room.devices.length + room.cameras.length === 0}
                />
            </div>
        );
    }
    const key = await guestKey(token);
    if (!key || key.standing !== "live") notFound();
    return (
        <GuestKeyView
            token={token}
            initial={key.device}
            allowed={key.allowed}
            nearbyMeters={key.nearbyMeters}
            until={key.until}
            note={key.note}
        />
    );
}
