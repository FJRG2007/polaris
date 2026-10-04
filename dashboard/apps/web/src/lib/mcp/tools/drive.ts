/**
 * Drive, as tools an agent can call.
 *
 * Finding a file and handing somebody a link to it is most of what an assistant
 * is asked to do with storage. These do that through the same pieces the Drive
 * screens use: `listAccessibleConnections` for which storages this account
 * reaches, `authorizeDrive` for whether it may read a path - ownership, the
 * per-folder rules and the password locks, every call - and the connection's
 * own driver for what is there. A folder somebody cannot open in the browser is
 * a folder their assistant cannot list.
 *
 * Deliberately not offered:
 *
 *   - A file's bytes. Reading a document into a model is a download, and a
 *     download through a tool a prompt can drive is the shortest way out of
 *     somebody's storage. The name, size and kind are what a model needs to say
 *     which file it means.
 *   - Uploading, renaming, moving and deleting. Each is a click in the screen,
 *     and the screen shows what is about to happen first.
 *   - A recursive search. The walk lives in the search route rather than in a
 *     service, so a tool would be a second copy of its bounds and lock rules;
 *     `drive_list` filters one folder by name instead.
 *   - Opening a password-locked folder. The password is typed into Polaris by a
 *     person; a locked folder is refused here with that said.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { StorageDriver } from "@polaris/storage";
import { moreLine, pageFields, pageOf } from "./paging";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";
import { isReservedPath, isReservedRootPath } from "@/lib/system-paths";

/**
 * The Drive services, loaded when a tool runs rather than when the catalogue
 * does: listing the tools should not start the storage drivers, the session
 * layer and the audit trail these reach.
 */
async function services() {
    const [authz, storage, workspace] = await Promise.all([
        import("@/lib/drive-authz"),
        import("@/lib/storage-service"),
        import("@/lib/workspace-scope")
    ]);
    return { authz, storage, workspace };
}

/** The ones only making a link needs. */
async function sharing() {
    const [audit, shares, domains, reach] = await Promise.all([
        import("@/lib/audit-service"),
        import("@/lib/share-service"),
        import("@/lib/domain-service"),
        import("@/lib/public-reach")
    ]);
    return { audit, shares, domains, reach };
}

const source = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The storage, by the id drive_sources returned.");

const pathField = z
    .string()
    .trim()
    .max(4_000)
    .describe('The path inside the storage, with "/" between folders. Empty is its top.');

/**
 * The path as the storage layer takes it, or a refusal.
 *
 * Polaris keeps its own folder (the trash, quarantine) at the top of every
 * storage and the screens never show it; a path into it is refused here the same
 * way a path that climbs out with ".." is.
 */
function cleanPath(raw: string): string {
    let path: string;
    try {
        path = core.normalizeRelPath(raw);
    } catch {
        throw new McpRefusal(`"${raw}" is not a path inside a storage.`);
    }
    if (isReservedPath(path)) {
        throw new McpRefusal("That folder belongs to Polaris and is not browsable.");
    }
    return path;
}

/**
 * Authorize a path and open the storage behind it.
 *
 * The same sentence for "does not exist" and "not yours", for the reason the
 * task tools give: a key must not be able to map what it may not open by
 * watching which refusal it gets.
 */
async function openFor(
    caller: McpCaller,
    connectionId: string,
    path: string,
    action: core.DriveAction
): Promise<StorageDriver> {
    const { authz, storage } = await services();
    try {
        await authz.authorizeDrive(caller.userId, connectionId, path, action);
    } catch (caught) {
        if (caught instanceof authz.DriveLockedError) {
            throw new McpRefusal(
                "That folder is locked with a password. It has to be opened in Polaris by the person it belongs to."
            );
        }
        if (caught instanceof authz.DriveAccessError) {
            throw new McpRefusal("No such location that this account can open.");
        }
        throw caught;
    }
    try {
        return await storage.getDriverForConnection(connectionId);
    } catch (caught) {
        if (caught instanceof storage.SmbShareRequiredError) {
            throw new McpRefusal(
                "That storage is not finished being set up. Open it in Drive to finish it."
            );
        }
        // Anything else names a host or a share; the protocol logs it and says
        // only that it could not be done.
        throw caught;
    }
}

/** A size as a number when it fits in one, which is every file a person has. */
function sizeOf(size: bigint): number | string {
    return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : size.toString();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const sourcesInput = z.object({});

const sourcesTool: McpTool<z.infer<typeof sourcesInput>> = {
    name: "drive_sources",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List storages",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The storages this account can browse in Drive - its own, ones shared with it, its organization's. Start here to find the id drive_list takes.",
    input: sourcesInput,
    scope: "drive.read",
    readOnly: true,
    async run(_input, caller) {
        const { storage, workspace } = await services();
        const connections = await storage.listAccessibleConnections(
            caller.userId,
            await workspace.scopeOrgIdFor(caller.userId)
        );
        // The name and the id. A connection's configuration carries hosts and
        // credentials, and nothing a model does with a storage needs them.
        const sources = connections.map((connection) => ({
            id: connection.id,
            name: connection.name,
            kind: connection.kind
        }));
        return {
            text:
                sources.map((row) => `${row.id}  ${row.name}  (${row.kind})`).join("\n") ||
                "This account reaches no storage.",
            structured: { sources }
        };
    }
};

const listInput = z.object({
    source,
    path: pathField.default(""),
    query: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe(
            "Only entries whose name contains this. Searches this folder, not the ones inside it."
        ),
    ...pageFields
});

const listTool: McpTool<z.infer<typeof listInput>> = {
    name: "drive_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List a folder",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "What is in one folder of a storage: names, kinds, sizes and when each changed. Folders first. Does not read any file's contents.",
    input: listInput,
    scope: "drive.read",
    readOnly: true,
    async run(input, caller) {
        const path = cleanPath(input.path);
        const driver = await openFor(caller, input.source, path, "read");
        try {
            const listing = await driver.list(path);
            // The folder was authorized; a rule on something inside it (the
            // folder only Legal opens) is its own, and is asked per entry.
            const { authz } = await services();
            const mayRead = await authz.drivePathFilter(caller.userId, input.source, "read");
            const needle = input.query.toLowerCase();
            const visible = [];
            for (const entry of listing.entries) {
                if (isReservedRootPath(entry.path)) continue;
                if (needle && !entry.name.toLowerCase().includes(needle)) continue;
                if (!(await mayRead(entry.path))) continue;
                visible.push(entry);
            }
            visible.sort(
                (a, b) =>
                    Number(b.kind === "dir") - Number(a.kind === "dir") ||
                    a.name.localeCompare(b.name)
            );
            const page = pageOf(visible, input.offset, input.limit);
            const entries = page.items.map((entry) => ({
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
                size: entry.kind === "dir" ? null : sizeOf(entry.size),
                modifiedAt: entry.modifiedAt.toISOString()
            }));
            if (entries.length === 0) {
                return {
                    text: needle ? "Nothing in that folder matched." : "That folder is empty.",
                    structured: { entries: [], nextOffset: null }
                };
            }
            return {
                text:
                    entries
                        .map(
                            (entry) =>
                                `${entry.kind === "dir" ? "dir " : "file"}  ${entry.path}${
                                    entry.size === null ? "" : `  ${entry.size} bytes`
                                }`
                        )
                        .join("\n") + moreLine(page),
                structured: { entries, nextOffset: page.nextOffset }
            };
        } finally {
            await driver.dispose();
        }
    }
};

const statInput = z.object({
    source,
    path: pathField.min(1)
});

const statTool: McpTool<z.infer<typeof statInput>> = {
    name: "drive_stat",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Describe a file",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "One file or folder's details: its kind, size, type and when it changed. Does not read its contents.",
    input: statInput,
    scope: "drive.read",
    readOnly: true,
    async run(input, caller) {
        const path = cleanPath(input.path);
        if (!path) throw new McpRefusal("Name a file or a folder inside the storage.");
        const driver = await openFor(caller, input.source, path, "read");
        try {
            const entry = await driver.stat(path).catch(() => null);
            if (!entry) throw new McpRefusal("No such location that this account can open.");
            const details = {
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
                size: entry.kind === "dir" ? null : sizeOf(entry.size),
                type: entry.mime ?? null,
                modifiedAt: entry.modifiedAt.toISOString(),
                createdAt: (entry.createdAt ?? entry.modifiedAt).toISOString()
            };
            return {
                text: [
                    `${details.path} (${details.kind})`,
                    details.size === null ? "" : `Size: ${details.size} bytes`,
                    details.type ? `Type: ${details.type}` : "",
                    `Changed: ${details.modifiedAt}`
                ]
                    .filter((line) => line !== "")
                    .join("\n"),
                structured: details
            };
        } finally {
            await driver.dispose();
        }
    }
};

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

const shareInput = z.object({
    source,
    path: pathField.min(1),
    expiresInDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
            "Stop the link working after this many days. Absent keeps it working until revoked."
        ),
    maxDownloads: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("Stop the link working after this many downloads."),
    allowDownload: z
        .boolean()
        .default(true)
        .describe("Whether whoever opens it may download the file, or only preview it.")
});

const shareTool: McpTool<z.infer<typeof shareInput>> = {
    name: "drive_share_create",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Create a share link",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Make a public link to a file or folder that anybody holding it can open, and return it. Only do this when the person asked for a link; it can be revoked in Drive.",
    input: shareInput,
    scope: "shares.create",
    readOnly: false,
    // Additive, but it publishes: whatever the link points at becomes readable
    // by anybody who is handed it. Left as destructive so a client asks the
    // person first rather than letting a prompt in a document hand their files
    // out.
    destructive: true,
    async run(input, caller) {
        // A link is a way to read the file, so the key has to be one that may
        // read it - holding shares.create alone does not make a key a reader.
        if (!caller.scopes.includes("drive.read")) {
            throw new McpRefusal(
                "This connection cannot drive_share_create without the drive.read scope as well."
            );
        }
        const path = cleanPath(input.path);
        // Asked as a download, which is what a link hands out. Stricter than
        // the screen's own check, deliberately: a tool call has no folder open
        // to have been authorized already.
        const driver = await openFor(caller, input.source, path, "download");
        try {
            const exists = await driver.stat(path).catch(() => null);
            if (!exists) throw new McpRefusal("No such location that this account can open.");
        } finally {
            await driver.dispose();
        }

        const parsed = core.createShareSchema.parse({
            connectionId: input.source,
            path,
            kind: "public",
            allowDownload: input.allowDownload,
            ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads }),
            ...(input.expiresInDays === undefined
                ? {}
                : { expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) })
        });
        const { audit, shares, domains, reach } = await sharing();
        const { id, token } = await shares.createShare(caller.userId, parsed);
        // The same record the screen writes, so the link shows up in the
        // account's own history as one it made.
        await audit.recordAudit({
            actorId: caller.userId,
            action: "share.create",
            targetType: "share",
            targetId: id,
            metadata: {
                connectionId: parsed.connectionId,
                path: parsed.path,
                kind: parsed.kind,
                hasPassword: false,
                allowUpload: false,
                via: "mcp"
            }
        });
        await reach.ensureShareReachability();
        const url = `${await domains.sharingBaseUrl()}/s/${token}`;
        return {
            text: `Anybody with this link can open ${path}: ${url}`,
            structured: {
                id,
                url,
                expiresAt: parsed.expiresAt?.toISOString() ?? null,
                maxDownloads: parsed.maxDownloads ?? null
            }
        };
    }
};

export const DRIVE_TOOLS = [
    sourcesTool,
    listTool,
    statTool,
    shareTool
] as unknown as McpTool<never>[];
