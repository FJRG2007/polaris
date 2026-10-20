import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { hostSubject } from "@/lib/metrics-shared";
import { grantedSubjects } from "@/lib/access/grants";
import { getTranslations } from "@/lib/i18n/request";
import { homePathForUser, requireUser, sessionCan } from "@/lib/session";
import { listServerRows } from "@/app/(app)/apps/servers/server-rows";
import { UpsListView } from "./ups-list-view";

export const dynamic = "force-dynamic";

/** Every UPS Polaris watches. The machines are named from the database; what
 *  each UPS says arrives after the page has painted. Somebody lent a UPS, and
 *  holding nothing else, is shown the ones they were lent. */
export default async function UpsPage() {
    const user = await requireUser();
    if (await sessionCan(user, "system.manage")) {
        const rows = await listServerRows(user.id);
        return (
            <UpsListView
                machines={rows.map((row) => ({ id: hostSubject(row.id), name: row.name }))}
            />
        );
    }
    const lent = [...(await grantedSubjects(user.id, "place.ups")).keys()];
    if (lent.length === 0) redirect(`${await homePathForUser(user)}?denied=1`);
    if (lent.length === 1) redirect(`/places/ups/${lent[0]}`);
    const [t, upses] = await Promise.all([
        getTranslations("servers"),
        prisma.ups.findMany({
            where: { id: { in: lent } },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: 100
        })
    ]);
    return (
        <>
            <PageHeader title={t("ups.heading")} />
            <ul className="flex flex-col divide-y rounded-md border">
                {upses.map((ups) => (
                    <li key={ups.id} className="min-w-0">
                        <Link
                            href={`/places/ups/${ups.id}`}
                            className="block truncate px-3 py-2 text-sm hover:bg-muted"
                            title={ups.name}
                        >
                            {ups.name}
                        </Link>
                    </li>
                ))}
            </ul>
        </>
    );
}
