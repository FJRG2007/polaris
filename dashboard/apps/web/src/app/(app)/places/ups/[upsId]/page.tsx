import { notFound, redirect } from "next/navigation";
import { homePathForUser, requireUser } from "@/lib/session";
import { hostSubject } from "@/lib/metrics-shared";
import * as upsService from "@/lib/ups/ups-service";
import { upsStanding, visitorView } from "@/lib/ups/ups-access";
import { listServerRows } from "@/app/(app)/apps/servers/server-rows";
import { UpsDetailView } from "./ups-detail-view";

export const dynamic = "force-dynamic";

/** One UPS. Its stored settings come from the database, which is quick; what
 *  it says now and its history are read by the screen after it paints. An
 *  administrator runs it; somebody it was lent to sees what they were lent. */
export default async function UpsDetailPage({ params }: { params: Promise<{ upsId: string }> }) {
    const user = await requireUser();
    const { upsId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(upsId)) notFound();
    const standing = await upsStanding(user, upsId);
    if (!standing) redirect(`${await homePathForUser(user)}?denied=1`);
    const row = await upsService.getUps(upsId);
    if (!row) notFound();
    if (!standing.manage) {
        return (
            <UpsDetailView
                initial={visitorView(upsService.toView(row))}
                machines={[]}
                canOfferNetwork={false}
                places={[]}
                standing={{ manage: false, control: standing.control }}
            />
        );
    }
    const [rows, places] = await Promise.all([listServerRows(user.id), upsService.placeChoices()]);
    return (
        <UpsDetailView
            initial={upsService.toView(row)}
            machines={rows.map((one) => ({ id: hostSubject(one.id), name: one.name }))}
            canOfferNetwork={upsService.canOfferNetwork(row)}
            places={places}
        />
    );
}
