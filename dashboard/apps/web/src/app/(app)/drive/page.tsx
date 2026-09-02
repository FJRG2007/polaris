import { PageHeader } from "@polaris/ui";
import { DriveExplorer } from "./drive-explorer";
import { requirePermission } from "@/lib/session";
import { isSavedConnection, type ConnectionSummary } from "./types";
import { isPersonalKind, type StorageProviderKind } from "@polaris/core";
import { ensurePersonalDrive, PERSONAL_DRIVE_TAKEN } from "@/lib/personal-drive";
import {
    connectionWebUrl,
    getContainerConnection,
    getSharedConnection,
    listAccessibleConnections
} from "@/lib/storage-service";

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
    const user = await requirePermission("drive.read");
    const params = await searchParams;

    // Everybody has their own drive, and this is where it starts existing. It is
    // one upsert on a row that is already there for everybody who has opened
    // Drive once, and it is what makes the app useful to an account that has
    // never connected a storage - which, before this, opened Drive and found
    // nothing at all.
    //
    // A drive that cannot be opened does not take Drive with it. The one case
    // where it refuses - a row under this account's id that is not its drive -
    // is exactly the one somebody needs the rest of this screen to work out, so
    // the reason is shown on it rather than replacing it with a server error.
    //
    // Only that refusal is passed on. Anything else that fails in there is a
    // storage or a query, and its message names tables and paths - it goes to
    // the log, and the reader is told the one thing that is true and useful.
    let driveNotice: string | undefined;
    try {
        await ensurePersonalDrive(user.id);
    } catch (caught) {
        if (caught instanceof Error && caught.message === PERSONAL_DRIVE_TAKEN) {
            driveNotice = PERSONAL_DRIVE_TAKEN;
        } else {
            console.error("polaris: a personal drive could not be opened:", caught);
            driveNotice = "Your own drive could not be opened";
        }
    }

    // Only the fast, local query runs on the server so the page paints instantly.
    // The actual listing / device metrics load client-side (skeletons + cache),
    // which is what removes the multi-second delay a slow NAS used to add here.
    const connections: ConnectionSummary[] = (await listAccessibleConnections(user.id)).map(
        (row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind as StorageProviderKind,
            requiresHostd: row.requiresHostd,
            webUrl: connectionWebUrl(row.kind, row.config),
            shared: row.shared,
            // Only whoever runs a connection's rules manages its ACLs and locks; a
            // shared connection is browse-only from the grantee's side, and a server
            // borrowed from the Servers app is managed there, not here. An
            // organization's shelf is nobody's to own, so what answers there is the
            // organization's own permission - carried on the row, because a screen
            // cannot work it out from ownership that does not exist.
            canManageAccess: isSavedConnection(row.id) && (row.manageable || user.isAdmin),
            // Their own drive is theirs to share out of, and nobody's to reconfigure.
            editable:
                isSavedConnection(row.id) &&
                (!row.shared || user.isAdmin) &&
                !isPersonalKind(row.kind),
            // Non-secret config for the edit form; parsed defensively.
            config: parseConfig(row.config),
            // Flag connections whose credentials predate the current master key so the
            // UI can offer a re-key instead of a dead "cannot decrypt" error.
            needsRekey: row.needsRekey
        })
    );

    const requested = pick(params.c);
    // Something somebody shared. The storage it is on is deliberately absent
    // from the sidebar (it is not a location of yours), so it is resolved here
    // and added for this visit, exactly as a container source is.
    if (
        requested &&
        isSavedConnection(requested) &&
        !connections.some((row) => row.id === requested)
    ) {
        const shared = await getSharedConnection(user.id, requested);
        if (shared) {
            connections.unshift({
                id: shared.id,
                name: shared.name,
                kind: shared.kind as StorageProviderKind,
                requiresHostd: shared.requiresHostd,
                webUrl: undefined,
                shared: true,
                rootPath: shared.rootPath,
                canManageAccess: false,
                config: parseConfig(shared.config),
                needsRekey: false
            });
        }
    }

    // A deployed app's container is browsed on demand (Deploy -> View in Drive), not
    // kept in the connections list. When one is explicitly requested, resolve just it
    // and add it so the browser can open it without cluttering the saved connections.
    if (requested?.startsWith("container:") && !connections.some((row) => row.id === requested)) {
        const appId = requested.slice("container:".length);
        const container = await getContainerConnection(user.id, appId);
        if (container) {
            connections.unshift({
                id: container.id,
                name: container.name,
                kind: container.kind as StorageProviderKind,
                requiresHostd: container.requiresHostd,
                webUrl: undefined,
                shared: false,
                canManageAccess: false,
                config: parseConfig(container.config),
                needsRekey: false
            });
        }
    }

    const connectionId = requested ?? connections[0]?.id ?? null;
    const path = pick(params.p) ?? "";

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
                notice={driveNotice}
            />
        </>
    );
}
