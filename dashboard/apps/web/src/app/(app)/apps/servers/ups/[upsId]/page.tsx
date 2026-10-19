import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { hostSubject } from "@/lib/metrics-shared";
import * as upsService from "@/lib/ups/ups-service";
import { listServerRows } from "../../server-rows";
import { UpsDetailView } from "./ups-detail-view";

export const dynamic = "force-dynamic";

/** One UPS. Its stored settings come from the database, which is quick; what
 *  it says now and its history are read by the screen after it paints. */
export default async function UpsDetailPage({ params }: { params: Promise<{ upsId: string }> }) {
    const user = await requirePermission("system.manage");
    const { upsId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(upsId)) notFound();
    const [row, rows] = await Promise.all([upsService.getUps(upsId), listServerRows(user.id)]);
    if (!row) notFound();
    return (
        <UpsDetailView
            initial={upsService.toView(row)}
            machines={rows.map((one) => ({ id: hostSubject(one.id), name: one.name }))}
            canOfferNetwork={upsService.canOfferNetwork(row)}
        />
    );
}
