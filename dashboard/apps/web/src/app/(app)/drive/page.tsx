import type { StorageProviderKind } from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { getDriver, getUnasMetrics, listConnections } from "@/lib/storage-service";
import type { UnasMetrics } from "@/lib/unifi-unas";
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
    const selected = connections.find((connection) => connection.id === connectionId) ?? null;

    let entries: DriveEntry[] = [];
    let unasMetrics: UnasMetrics | null = null;
    let error: string | null = null;
    if (connectionId && selected?.kind === "unifi-unas") {
        // A UniFi UNAS connection is a monitoring connection: show device metrics
        // from the UniFi OS console API instead of a file browser.
        try {
            unasMetrics = await getUnasMetrics(connectionId, user.id);
        } catch (caught) {
            error = caught instanceof Error ? caught.message : "Unable to reach the UNAS console";
        }
    } else if (connectionId) {
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
                unasMetrics={unasMetrics}
            />
        </>
    );
}
