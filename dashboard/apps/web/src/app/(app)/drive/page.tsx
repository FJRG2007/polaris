import type { StorageProviderKind } from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { getDriver, listConnections } from "@/lib/storage-service";
import { DriveExplorer } from "./drive-explorer";
import type { ConnectionSummary, DriveEntry } from "./types";

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

    const connections: ConnectionSummary[] = (await listConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as StorageProviderKind,
        requiresHostd: row.requiresHostd
    }));

    const connectionId = pick(params.c) ?? connections[0]?.id ?? null;
    const path = pick(params.p) ?? "";

    let entries: DriveEntry[] = [];
    let error: string | null = null;
    if (connectionId) {
        try {
            const driver = await getDriver(connectionId, user.id);
            try {
                const listing = await driver.list(path);
                entries = listing.entries.map((entry) => ({
                    name: entry.name,
                    path: entry.path,
                    kind: entry.kind,
                    size: entry.size.toString(),
                    modifiedAt: entry.modifiedAt.toISOString()
                }));
            } finally {
                await driver.dispose();
            }
        } catch (caught) {
            error = caught instanceof Error ? caught.message : "Unable to list this location";
        }
    }

    return (
        <>
            <PageHeader
                title="Drive"
                description="Browse and manage files across every connected NAS and cloud."
            />
            <DriveExplorer
                connections={connections}
                connectionId={connectionId}
                path={path}
                entries={entries}
                error={error}
            />
        </>
    );
}
