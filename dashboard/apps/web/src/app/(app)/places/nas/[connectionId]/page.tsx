import { notFound, redirect } from "next/navigation";
import { homePathForUser, requireUser } from "@/lib/session";
import { nasStanding } from "@/lib/nas/nas-access";
import { nasRow } from "@/lib/nas/nas-service";
import { placeChoices } from "@/lib/ups/ups-service";
import { NasDetailView } from "./nas-detail-view";

export const dynamic = "force-dynamic";

/** One NAS. Its name and place come from the database, which is quick; what
 *  the console says and its history are read by the screen after it paints. */
export default async function NasDetailPage({
    params
}: {
    params: Promise<{ connectionId: string }>;
}) {
    const user = await requireUser();
    const { connectionId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) notFound();
    const row = await nasRow(connectionId);
    if (!row) notFound();
    const standing = await nasStanding(user, row.id);
    if (!standing) redirect(`${await homePathForUser(user)}?denied=1`);
    return (
        <NasDetailView
            nas={{ id: row.id, name: row.name, placeId: row.placeId }}
            standing={{ manage: standing.manage, fan: standing.fan, backup: standing.backup }}
            places={standing.manage ? await placeChoices() : []}
        />
    );
}
