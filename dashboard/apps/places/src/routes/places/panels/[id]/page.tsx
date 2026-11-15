/**
 * One wall panel's own page: arranged, styled, shared and previewed here, and
 * opened full screen at /wall/<id>. Reached from a row of the panels table.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { placesT } from "../../../../lib/i18n";
import { listRooms } from "../../../../lib/rooms";
import { listDevices } from "../../../../lib/devices";
import { requireHomeUser } from "../../../../lib/access";
import { addressesFor, listCameras } from "../../../../lib/cameras";
import { PanelDetail } from "../../../../screens/panels/panels-view";
import { automationChoices, requirePanel } from "../../../../lib/panels";

export const dynamic = "force-dynamic";

export default async function PanelPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { id } = await params;
    if (typeof id !== "string" || id.length > 64) notFound();
    const t = await placesT();
    const { install, canControl, canManage } = await requireHomeUser("home.read");
    const panel = await requirePanel(install.id, id).catch(() => null);
    if (!panel) notFound();
    const placeId = panel.placeId;
    const [devices, rooms, cameras, automations] = await Promise.all([
        listDevices(install.id, placeId),
        listRooms(install.id, placeId),
        listCameras(install.id, placeId),
        automationChoices(install.id, placeId)
    ]);
    const boardRooms = rooms.map((room) => ({
        id: room.id,
        name: room.name,
        deviceIds: devices.filter((device) => device.roomId === room.id).map((d) => d.id)
    }));
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-col items-start gap-2">
                <Link
                    href="/places/panels"
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="size-4 shrink-0" />
                    {t("panels.back")}
                </Link>
                <PageHeader title={t("panels.title")} description={t("panels.description")} />
            </div>
            <PanelDetail
                key={panel.id}
                placeId={placeId}
                panel={panel}
                devices={devices}
                rooms={boardRooms}
                cameras={addressesFor(cameras, canManage)}
                automations={automations}
                canControl={canControl}
                canManage={canManage}
            />
        </div>
    );
}
