/**
 * The front page of a place: how it is doing, at a glance.
 *
 * What is on, what needs somebody, each room with its controls, and the cameras
 * as one card among those - the live wall is a press away at /places/live. The
 * server hands over the frame and who may do what; everything inside it is read
 * by the client, so the page is on screen before any device account or camera
 * has been asked anything.
 */

import Link from "next/link";
import { placesT } from "../../lib/i18n";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { PageHeader } from "@polaris/ui";
import { requireHomeReach } from "../../lib/access";
import { currentPlace } from "../../lib/current-place";
import { PlaceSwitcher } from "../../screens/place-switcher";
import { OverviewView } from "../../screens/overview/overview-view";

export const dynamic = "force-dynamic";

export default async function PlacePage() {
    const t = await placesT();
    // A visitor lent one door or one camera lands here too, and is shown that.
    const { install, user, reach, canManage, canControl } = await requireHomeReach();
    const place = await currentPlace(install.id);
    // The UPSes standing in this place. Their screens are core's (a UPS keeps
    // shutting machines down with Places uninstalled), so they are only listed
    // to whoever may open them, and read straight off the table.
    const upses = (await host.session.sessionCan(user, "system.manage"))
        ? await prisma.ups.findMany({
              where: { placeId: place.current.id },
              select: { id: true, name: true },
              orderBy: { name: "asc" },
              take: 50
          })
        : [];

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={place.current.name}
                    description={t("pages.overview.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <OverviewView
                placeId={place.current.id}
                places={place.places}
                resident={reach.everything}
                canControl={canControl}
                canManage={canManage}
            />
            {upses.length > 0 ? (
                <section aria-labelledby="place-ups" className="flex flex-col gap-2">
                    <h2 id="place-ups" className="text-sm font-medium">
                        {t("overview.upsTitle")}
                    </h2>
                    <ul className="flex flex-wrap gap-2">
                        {upses.map((ups) => (
                            <li key={ups.id} className="min-w-0">
                                <Link
                                    href={`/places/ups/${ups.id}`}
                                    className="block truncate rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                                >
                                    {ups.name}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
        </div>
    );
}
