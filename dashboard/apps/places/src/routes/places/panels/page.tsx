/**
 * A place's wall panels: built and arranged here, opened full screen at
 * /wall/<id>, or handed to a wall tablet as a link.
 */

import { PageHeader } from "@polaris/ui";
import { placesT } from "../../../lib/i18n";
import { listPanels } from "../../../lib/panels";
import { listRooms } from "../../../lib/rooms";
import { listDevices } from "../../../lib/devices";
import { requireHomeUser } from "../../../lib/access";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";
import { PanelsView } from "../../../screens/panels/panels-view";

export const dynamic = "force-dynamic";

export default async function PanelsPage() {
    const t = await placesT();
    const { install, canControl, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);
    const placeId = place.current.id;
    const [panels, devices, rooms] = await Promise.all([
        listPanels(install.id, placeId),
        listDevices(install.id, placeId),
        listRooms(install.id, placeId)
    ]);
    const boardRooms = rooms.map((room) => ({
        id: room.id,
        name: room.name,
        deviceIds: devices.filter((device) => device.roomId === room.id).map((d) => d.id)
    }));
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title={t("panels.title")} description={t("panels.description")} />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <PanelsView
                key={placeId}
                placeId={placeId}
                panels={panels}
                devices={devices}
                rooms={boardRooms}
                canControl={canControl}
                canManage={canManage}
            />
        </div>
    );
}
