import type { StorageProviderKind } from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { connectionWebUrl, listAccessibleConnections } from "@/lib/storage-service";
import { DriveExplorer } from "./drive-explorer";
import type { ConnectionSummary } from "./types";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/** Parse a stored config JSON string into a plain object (empty on any error). */
function parseConfig(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
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
    const connections: ConnectionSummary[] = (await listAccessibleConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as StorageProviderKind,
        requiresHostd: row.requiresHostd,
        webUrl: connectionWebUrl(row.kind, row.config),
        shared: row.shared,
        // Only the owner (or an admin) manages a connection's ACLs and locks; a
        // shared connection is browse-only from the grantee's side.
        canManageAccess: !row.shared || user.isAdmin,
        // Non-secret config for the edit form; parsed defensively.
        config: parseConfig(row.config)
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
