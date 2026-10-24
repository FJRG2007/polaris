/**
 * A wall panel full screen, for somebody signed in who reads the house. Core
 * draws this outside the app's layout (`app/wall`), so the tablet shows the
 * cards and nothing else.
 */

import { notFound } from "next/navigation";
import { panelContents } from "../../../lib/panels";
import { requireHomeUser } from "../../../lib/access";
import { PanelWall } from "../../../screens/panels/panel-wall";

export const dynamic = "force-dynamic";

export default async function WallPanelPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { id } = await params;
    if (typeof id !== "string") notFound();
    const { install, canControl } = await requireHomeUser("home.read");
    const contents = await panelContents(install.id, id).catch(() => null);
    if (!contents) notFound();
    return (
        <PanelWall
            name={contents.panel.name}
            placeId={contents.panel.placeId}
            cards={contents.panel.cards}
            devices={contents.devices}
            rooms={contents.rooms}
            access={{ kind: "session", canControl }}
        />
    );
}
