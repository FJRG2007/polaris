"use server";

/**
 * A Deploy database's Database tab: its data, its stats, its config and how to
 * connect to it - the Databases app's browser, bound to this one database.
 *
 * No connection is saved and none is asked for. The address and credentials are
 * read from the deploy row on every call (`managedAddress`), after the caller is
 * checked for `deploy.manage` and `databases.manage` on the project - what already
 * hands out this database's password, so reading its rows through Polaris grants
 * nothing that the Connect dialog does not. The owner-scoped call pattern the
 * rest of Deploy follows holds here too: access resolves the project's owner,
 * and every read after that is scoped to that owner.
 *
 * The browser opens read-only. `writable` is what the panel's Read-only switch
 * says; it can only narrow what the capability allows, never widen it, and the
 * driver - not this file - is what refuses a write on a read-only session.
 *
 * Administrative changes (vacuum, extensions, statement statistics, a new
 * password) are each written to the audit trail with what they changed, never
 * with a value.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { getPublicIp } from "@/lib/domain-service";
import { databaseConnection, type DatabaseConnection } from "@/lib/database-service";
import { revalidatePath } from "next/cache";
import { withDriver } from "@/lib/data/open";
import * as browser from "@/lib/data/browser";
import { requirePermission } from "@/lib/session";
import * as admin from "@/lib/database-ops/admin";
import { guardData } from "@/lib/data/action-guard";
import * as maintenance from "@/lib/data/maintenance";
import type { TableDraft } from "@/lib/data/row-edit";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { managedAddress } from "@/lib/data/connections";
import { redeployForEnvScope } from "@/lib/deploy-service";
import { DatabaseOperationError } from "@/lib/database-ops/ops";
import { requireDatabaseAccess } from "@/lib/deploy-project-access";
import { engineStatsAt, type DatabaseStats } from "@/lib/data/stats";
import { databaseInsightsAt, type DatabaseInsights } from "@/lib/data/insights";
import { rowDeleteSchema, rowInsertSchema, tableDraftSchema } from "@/lib/data/row-edit-schema";
import {
    cachedHealth,
    forgetHealth,
    healthAt,
    runnerFor,
    type HealthReport
} from "@/lib/data/health";
import {
    DataRequestError,
    type DataColumn,
    type DataNamespace,
    type DataPage,
    type DataRelation,
    type QueryResult
} from "@/lib/data/driver";

const DEPLOY_PATH = "/apps/deploy";

/** A request that does not have the shape any panel sends. */
const GENERIC = "That did not work. Nothing was changed.";

/** Which database, and whether the panel's Read-only switch is off. */
const sourceSchema = z.object({ databaseId: z.string().uuid(), writable: z.boolean() });

export type ManagedSource = z.infer<typeof sourceSchema>;

/** Gate one call and resolve the address it may use. */
async function open(source: ManagedSource) {
    const parsed = parse(sourceSchema, source);
    // deploy.manage, as the Connect dialog asks: reading every row of a
    // database is worth exactly as much as its password.
    const user = await requirePermission("deploy.manage");
    const access = await requireDatabaseAccess(parsed.databaseId, user.id, "databases.manage");
    const address = await managedAddress(access.ownerId, parsed.databaseId, !parsed.writable);
    return { userId: user.id, ownerId: access.ownerId, databaseId: parsed.databaseId, address };
}

const spoken = (caught: unknown) =>
    caught instanceof DatabaseOperationError ||
    (caught instanceof Error && caught.message === "Database not found");

/** Parse a request body, refusing with the schema's own sentence. */
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DataRequestError(parsed.error.issues[0]?.message ?? GENERIC);
    return parsed.data;
}

async function guard<T>(run: () => Promise<T>) {
    return guardData(run, spoken);
}

async function audit(
    actorId: string,
    action: string,
    databaseId: string,
    metadata?: Record<string, unknown>
) {
    await recordDeployAudit({
        actorId,
        action,
        targetType: "database",
        targetId: databaseId,
        ...(metadata ? { metadata } : {})
    });
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

export async function managedBrowseAction(
    source: ManagedSource,
    namespace: string | null
): Promise<{
    shape?: string;
    namespaces?: DataNamespace[];
    relations?: DataRelation[];
    namespace?: string | null;
    error?: string;
}> {
    const result = await guard(async () => {
        const { address } = await open(source);
        return browser.browseAt(address, namespace === null ? null : String(namespace));
    });
    return result.error ? { error: result.error } : { ...result.value };
}

export async function managedRowsAction(
    source: ManagedSource,
    namespace: string | null,
    relation: string,
    query: browser.RowRequest
): Promise<{ page?: DataPage; columns?: DataColumn[]; error?: string }> {
    const result = await guard(async () => {
        const { address } = await open(source);
        return browser.rowsAt(
            address,
            namespace === null ? null : String(namespace),
            String(relation),
            {
                limit: Number(query.limit) || undefined,
                offset: Number(query.offset) || 0,
                orderBy:
                    query.orderBy === null || query.orderBy === undefined
                        ? null
                        : String(query.orderBy),
                descending: query.descending === true,
                filter:
                    query.filter === null || query.filter === undefined
                        ? null
                        : String(query.filter),
                cursor:
                    query.cursor === null || query.cursor === undefined
                        ? null
                        : String(query.cursor)
            }
        );
    });
    return result.error ? { error: result.error } : { page: result.value };
}

export async function managedRunAction(
    source: ManagedSource,
    statement: string
): Promise<{ results?: QueryResult[]; error?: string }> {
    const result = await guard(async () => {
        const opened = await open(source);
        const results = await browser.runAt(opened.address, String(statement));
        const changed = results.filter((entry) => entry.affected !== null).length;
        // What ran is not recorded - a statement can carry a password or a
        // customer's data - only that something written was run, and how much.
        if (changed > 0)
            await audit(opened.userId, "deploy.db.statement", opened.databaseId, {
                statements: changed
            });
        return results;
    });
    return result.error ? { error: result.error } : { results: result.value };
}

export async function managedUpdateCellAction(
    source: ManagedSource,
    edit: {
        namespace: string | null;
        relation: string;
        column: string;
        value: string | null;
        key: Record<string, unknown>;
    }
): Promise<{ changed?: number; error?: string }> {
    const result = await guard(async () => {
        const opened = await open(source);
        const changed = await browser.updateCellAt(opened.address, {
            namespace: edit.namespace === null ? null : String(edit.namespace),
            relation: String(edit.relation),
            column: String(edit.column),
            value: edit.value === null ? null : String(edit.value),
            key: edit.key
        });
        await audit(opened.userId, "deploy.db.row.update", opened.databaseId, {
            table: String(edit.relation)
        });
        return changed;
    });
    return result.error ? { error: result.error } : { changed: result.value?.changed ?? 0 };
}

export async function managedInsertRowAction(
    source: ManagedSource,
    insert: unknown
): Promise<{ changed?: number; error?: string }> {
    const result = await guard(async () => {
        const parsed = parse(rowInsertSchema, insert);
        const opened = await open(source);
        const done = await browser.insertRowAt(opened.address, parsed);
        await audit(opened.userId, "deploy.db.row.insert", opened.databaseId, {
            table: parsed.relation
        });
        return done;
    });
    return result.error ? { error: result.error } : { changed: result.value?.changed ?? 0 };
}

export async function managedDeleteRowsAction(
    source: ManagedSource,
    removal: unknown
): Promise<{ changed?: number; error?: string }> {
    const result = await guard(async () => {
        const parsed = parse(rowDeleteSchema, removal);
        const opened = await open(source);
        const done = await browser.deleteRowsAt(opened.address, parsed);
        await audit(opened.userId, "deploy.db.row.delete", opened.databaseId, {
            table: parsed.relation,
            rows: done.changed
        });
        return done;
    });
    return result.error ? { error: result.error } : { changed: result.value?.changed ?? 0 };
}

export async function managedCreateTableAction(
    source: ManagedSource,
    draft: unknown
): Promise<{ error?: string }> {
    const result = await guard(async () => {
        const parsed = parse(tableDraftSchema, draft) as TableDraft;
        const opened = await open(source);
        await browser.createTableAt(opened.address, parsed);
        forgetHealth(opened.databaseId);
        await audit(opened.userId, "deploy.db.table.create", opened.databaseId, {
            table: parsed.name,
            columns: parsed.columns.length
        });
    });
    return result.error ? { error: result.error } : {};
}

export async function managedRedisValueAction(
    source: ManagedSource,
    namespace: string | null,
    key: string
): Promise<{ value?: browser.KeyValueView; error?: string }> {
    const result = await guard(async () => {
        const { address } = await open(source);
        return browser.keyValueAt(
            address,
            namespace === null ? null : String(namespace),
            String(key)
        );
    });
    return result.error ? { error: result.error } : { value: result.value };
}

export async function managedStatsAction(
    source: ManagedSource
): Promise<{ stats?: DatabaseStats; error?: string }> {
    const result = await guard(async () => engineStatsAt((await open(source)).address));
    return result.error ? { error: result.error } : { stats: result.value };
}

export async function managedInsightsAction(
    source: ManagedSource
): Promise<{ insights?: DatabaseInsights; error?: string }> {
    const result = await guard(async () => databaseInsightsAt((await open(source)).address));
    return result.error ? { error: result.error } : { insights: result.value };
}

// ---------------------------------------------------------------------------
// Stats and Config
// ---------------------------------------------------------------------------

/**
 * The Stats report. Read-only and bounded (see `health.ts`), and served from
 * memory for 30 seconds - `fresh` skips that, for the Refresh button.
 */
export async function databaseHealthAction(
    databaseId: string,
    fresh = false
): Promise<{ report?: HealthReport; error?: string }> {
    const result = await guard(async () => {
        const { address, databaseId: id } = await open({ databaseId, writable: false });
        if (fresh === true) forgetHealth(id);
        return cachedHealth(id, () => healthAt(address));
    });
    return result.error ? { error: result.error } : { report: result.value };
}

export async function vacuumTableAction(
    databaseId: string,
    table: { schema: string; name: string }
): Promise<{ error?: string }> {
    const result = await guard(async () => {
        const target = parse(
            z.object({ schema: z.string().min(1).max(256), name: z.string().min(1).max(256) }),
            table
        );
        const opened = await open({ databaseId, writable: true });
        if (opened.address.engine !== "postgres")
            throw new DatabaseOperationError("Vacuum is a PostgreSQL command.");
        await withDriver(opened.address, (driver) =>
            maintenance.vacuumTable(runnerFor(driver), target.schema, target.name)
        );
        forgetHealth(opened.databaseId);
        await audit(opened.userId, "deploy.db.vacuum", opened.databaseId, {
            table: `${target.schema}.${target.name}`
        });
    });
    return result.error ? { error: result.error } : {};
}

export async function listExtensionsAction(
    databaseId: string
): Promise<{ extensions?: maintenance.ExtensionView[]; error?: string }> {
    const result = await guard(async () => {
        const { address } = await open({ databaseId, writable: false });
        if (address.engine !== "postgres") return [];
        return withDriver(address, (driver) => maintenance.listExtensions(runnerFor(driver)));
    });
    return result.error ? { error: result.error } : { extensions: result.value };
}

export async function setExtensionAction(
    databaseId: string,
    input: { name: string; installed: boolean }
): Promise<{ error?: string }> {
    const result = await guard(async () => {
        const wanted = parse(
            z.object({ name: z.string().min(1).max(63), installed: z.boolean() }),
            input
        );
        const opened = await open({ databaseId, writable: true });
        if (opened.address.engine !== "postgres")
            throw new DatabaseOperationError("Extensions are a PostgreSQL feature.");
        if (wanted.name === "pg_stat_statements") {
            // Loaded at start, so it is the instance setting, not just the extension.
            await admin.setStatStatements(
                opened.databaseId,
                opened.ownerId,
                opened.userId,
                wanted.installed
            );
        } else {
            await withDriver(opened.address, (driver) =>
                wanted.installed
                    ? maintenance.installExtension(runnerFor(driver), wanted.name)
                    : maintenance.uninstallExtension(runnerFor(driver), wanted.name)
            );
        }
        forgetHealth(opened.databaseId);
        await audit(
            opened.userId,
            wanted.installed ? "deploy.db.extension.install" : "deploy.db.extension.remove",
            opened.databaseId,
            { extension: wanted.name }
        );
    });
    if (!result.error) revalidatePath(DEPLOY_PATH);
    return result.error ? { error: result.error } : {};
}

/** Turn statement statistics on: load the library at start, then install it. */
export async function enableStatStatementsAction(databaseId: string): Promise<{ error?: string }> {
    return setExtensionAction(databaseId, { name: "pg_stat_statements", installed: true });
}

/** Who restarts if the password changes - asked before the dialog is confirmed. */
export async function passwordDependentsAction(
    databaseId: string
): Promise<{ services?: admin.DependentService[]; error?: string }> {
    const result = await guard(async () => {
        const opened = await open({ databaseId, writable: false });
        return admin.dependentServices(opened.databaseId, opened.ownerId);
    });
    return result.error ? { error: result.error } : { services: result.value };
}

/**
 * A new generated password, stored, and every service that reads it restarted.
 * The restarts run after the answer, each from its kept image, so the dialog
 * does not wait on several deploys.
 */
export async function regeneratePasswordAction(
    databaseId: string
): Promise<{ restarted?: admin.DependentService[]; error?: string }> {
    const result = await guard(async () => {
        const opened = await open({ databaseId, writable: true });
        const restarted = await admin.regeneratePassword(
            opened.databaseId,
            opened.ownerId,
            opened.userId,
            (ids) => {
                for (const id of ids) {
                    void redeployForEnvScope("application", id, opened.ownerId, opened.userId, {
                        reason: "database-password",
                        databaseId: opened.databaseId
                    }).catch((error: unknown) =>
                        console.error("deploy: a restart after a password change failed", error)
                    );
                }
            }
        );
        await audit(opened.userId, "deploy.db.password.regenerate", opened.databaseId, {
            restarted: restarted.map((service) => service.id)
        });
        return restarted;
    });
    if (!result.error) revalidatePath(DEPLOY_PATH);
    return result.error ? { error: result.error } : { restarted: result.value };
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export interface ConnectInfo {
    readonly connection: DatabaseConnection;
    /** Where the published port answers from outside, when it is published. */
    readonly publicHost: string | null;
    /** The variables a service can take from this database by reference. */
    readonly referenceKeys: readonly string[];
    readonly slug: string;
}

/** Everything the Connect panel shows. Hands out the password, so it is gated
 *  like the Connect dialog: `databases.manage`. */
export async function databaseConnectInfoAction(
    databaseId: string
): Promise<{ info?: ConnectInfo; error?: string }> {
    const result = await guard(async () => {
        const id = parse(z.string().uuid(), databaseId);
        const user = await requirePermission("deploy.manage");
        const access = await requireDatabaseAccess(id, user.id, "databases.manage");
        const connection = await databaseConnection(id, access.ownerId);
        const row = await prisma.managedDatabase.findFirst({
            where: { id, environment: { project: { ownerId: access.ownerId } } },
            select: {
                slug: true,
                engine: true,
                parent: {
                    select: {
                        target: { select: { kind: true, host: { select: { address: true } } } }
                    }
                },
                target: { select: { kind: true, host: { select: { address: true } } } }
            }
        });
        if (!row) throw new DataRequestError("That database is not there any more.");
        const target = row.parent?.target ?? row.target;
        const publicHost = connection.exposedPort
            ? target.kind === "local" || !target.host?.address
                ? await getPublicIp()
                : target.host.address
            : null;
        const referenceKeys = Object.keys(
            core.databaseReferenceKeys({
                engine: row.engine,
                host: "",
                port: 0,
                database: "",
                username: "",
                password: "",
                uri: "",
                clusterNodes: connection.cluster ? [""] : null,
                readUri: connection.readUri ? "-" : null
            })
        );
        return { connection, publicHost, referenceKeys, slug: row.slug };
    });
    return result.error ? { error: result.error } : { info: result.value };
}

/** Publish the database on a port of its server, or stop. Redeploys it. */
export async function setPublicPortAction(
    databaseId: string,
    port: number | null
): Promise<{ error?: string }> {
    const result = await guard(async () => {
        const wanted = parse(z.number().int().nullable(), port);
        const id = parse(z.string().uuid(), databaseId);
        const user = await requirePermission("deploy.manage");
        const access = await requireDatabaseAccess(id, user.id, "databases.manage");
        await admin.setPublicPort(id, access.ownerId, user.id, wanted);
        await audit(
            user.id,
            wanted === null ? "deploy.db.public.close" : "deploy.db.public.open",
            id,
            {
                ...(wanted === null ? {} : { port: wanted })
            }
        );
    });
    if (!result.error) revalidatePath(DEPLOY_PATH);
    return result.error ? { error: result.error } : {};
}
