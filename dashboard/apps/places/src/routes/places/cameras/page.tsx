/**
 * Every camera in the place: live on the wall, and managed from it.
 *
 * The wall and the camera settings used to be two screens, and somebody looking
 * at a camera that had stopped answering had to go to the other one to do
 * anything about it. Now each tile carries what managing that camera offers,
 * and a compact list is a toggle away for a house with many of them.
 *
 * The server hands over the frame and nothing else: the heading, the place and
 * the buttons are on screen before a single camera has been asked for, which
 * matters here because a camera that is asleep takes a moment to answer.
 */

import { PageHeader } from "@polaris/ui";
import { CamerasView } from "../../../screens/cameras/cameras-view";
import { requireHomeReach } from "../../../lib/access";
import { placesT } from "../../../lib/i18n";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";

export const dynamic = "force-dynamic";

export default async function CamerasPage({
    searchParams
}: {
    searchParams: Promise<{ open?: string }>;
}) {
    const t = await placesT();
    // A visitor lent one camera lands here too, and sees that one with nothing
    // to manage: both grants below are false for them.
    const { install, canManage, canControl } = await requireHomeReach();
    const place = await currentPlace(install.id);
    const { open } = await searchParams;

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 2xl:max-w-screen-2xl">
            <CamerasView
                canManage={canManage}
                canControl={canControl}
                openId={open ?? null}
                header={
                    <PageHeader
                        title={t("pages.cameras.title")}
                        description={t("pages.cameras.description")}
                    />
                }
                switcher={
                    <PlaceSwitcher
                        places={place.places}
                        current={place.current}
                        canManage={canManage}
                    />
                }
            />
        </div>
    );
}
