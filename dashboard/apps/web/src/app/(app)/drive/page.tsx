import type { StorageProviderKind } from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { listConnections } from "@/lib/storage-service";
import { DriveExplorer } from "./drive-explorer";
import type { ConnectionSummary } from "./types";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function DrivePage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requireUser();
    const params = await searchParams;

    // Only the fast, local query runs on the server so the page paints instantly.
    // The actual listing / device metrics load client-side (skeletons + cache),
    // which is what removes the multi-second delay a slow NAS used to add here.
    const connections: ConnectionSummary[] = (await listConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as StorageProviderKind,
        requiresHostd: row.requiresHostd
    }));

    const connectionId = pick(params.c) ?? connections[0]?.id ?? null;
    const path = pick(params.p) ?? "";

    return (
        <>
            <PageHeader
                title="Drive"
                description="Browse and manage files across every connected NAS and cloud."
            />
            <DriveExplorer connections={connections} connectionId={connectionId} path={path} />
        </>
    );
}
