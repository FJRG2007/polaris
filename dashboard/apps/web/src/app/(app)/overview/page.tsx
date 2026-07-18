import type { StorageProviderKind } from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { listConnections } from "@/lib/storage-service";
import type { ConnectionSummary } from "../drive/types";
import { OverviewView } from "./overview-view";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
    const user = await requireUser();
    const connections: ConnectionSummary[] = (await listConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as StorageProviderKind,
        requiresHostd: row.requiresHostd
    }));

    return (
        <>
            <PageHeader title="Overview" description="Your connected NAS devices and their health." />
            <OverviewView connections={connections} />
        </>
    );
}
