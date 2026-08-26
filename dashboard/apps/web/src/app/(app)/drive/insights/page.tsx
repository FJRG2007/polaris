/**
 * Where the room went (/drive/insights).
 *
 * The question a full disk actually raises. Drive can say what a folder weighs
 * while you stand in it, which answers "is this the big one" and never "which
 * one is". This screen is the other way round: pick a location and it walks it
 * and ranks it - heaviest folders, biggest files, and what each kind of file
 * adds up to - with a way into every row, because knowing that photos are 40 GB
 * is only useful next to the button that opens them.
 *
 * The walk is bounded and says so when it ran out: every figure is then "at
 * least this much". A disk tool that quietly under-reports is worse than none.
 */

import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import type { StorageProviderKind } from "@polaris/core";
import { listAccessibleConnections } from "@/lib/storage-service";
import { DriveInsights, type InsightLocation } from "./drive-insights";

export const dynamic = "force-dynamic";

export default async function DriveInsightsPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requirePermission("drive.read");
    const params = await searchParams;
    const asked = Array.isArray(params.c) ? params.c[0] : params.c;

    const locations: InsightLocation[] = (await listAccessibleConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as StorageProviderKind
    }));

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Where the room went"
                description="Pick a location and Polaris walks it: the folders holding the most, the biggest single files, and what each kind of file adds up to."
            />
            <DriveInsights locations={locations} initial={asked ?? locations[0]?.id ?? null} />
        </div>
    );
}
