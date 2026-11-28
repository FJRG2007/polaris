/**
 * The venue on the Overview: one card per venue picked, with what is on the
 * floor right now - open tables, covers, and what is waiting at the pass. It
 * stands behind `hospitality.use`, checked by the dashboard before it is asked,
 * so a reader who lost the permission sees "no longer have access" instead.
 *
 * One query per read, bounded, whatever the number of venues on the card.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { hospitalityT } from "./i18n";

const LIVE = ["open", "billed"];
/** The most venues one card watches. */
const MAX_VENUES = 12;

export async function targets() {
    const venues = await prisma.hospitalityVenue.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 100
    });
    return venues.map((venue) => ({ id: venue.id, label: venue.name }));
}

export async function read(ids: readonly string[]) {
    const venueIds = ids.slice(0, MAX_VENUES);
    const [t, venues, orders] = await Promise.all([
        hospitalityT(),
        prisma.hospitalityVenue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } }),
        prisma.hospitalityOrder.findMany({
            where: { venueId: { in: venueIds }, status: { in: LIVE } },
            select: { venueId: true, covers: true, lines: { where: { status: "ready" }, select: { id: true } } },
            take: 5_000
        })
    ]);
    const names = new Map(venues.map((venue) => [venue.id, venue.name]));
    return {
        items: venueIds.flatMap((id) => {
            const name = names.get(id);
            if (name === undefined) return [];
            const open = orders.filter((order) => order.venueId === id);
            const covers = open.reduce((sum, order) => sum + order.covers, 0);
            const waiting = open.reduce((sum, order) => sum + order.lines.length, 0);
            return [
                {
                    id,
                    title: name,
                    state: open.length ? t("overview.busy") : t("overview.quiet"),
                    tone: waiting > 0 ? ("warn" as const) : open.length ? ("ok" as const) : ("off" as const),
                    readings: [
                        { label: t("overview.open"), value: String(open.length) },
                        { label: t("overview.covers"), value: String(covers) },
                        {
                            label: t("overview.waiting"),
                            value: String(waiting),
                            ...(waiting > 0 ? { tone: "warn" as const } : {})
                        }
                    ],
                    controls: [],
                    href: "/hospitality"
                }
            ];
        })
    };
}

/** The card's name and what it shows, in the reader's language. */
export async function describe() {
    const t = await hospitalityT();
    return { label: t("overview.label"), hint: t("overview.hint") };
}
