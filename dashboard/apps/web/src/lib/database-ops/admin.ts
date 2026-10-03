/**
 * The two changes a database's Config screen makes to the instance itself:
 * loading pg_stat_statements, and giving its account a new password.
 *
 * Both are undone when they go wrong rather than left half-done. Loading the
 * library is a redeploy with a setting in the row, so an instance that does not
 * come back that way has the setting taken out again and is deployed as it was.
 * A new password is set in the engine first and stored second; if storing it
 * fails, the engine is told the old one again, so the stored credential and the
 * one the engine checks never disagree.
 *
 * What depends on the password is said before and acted on after: every service
 * whose variables name this database (`${{name.KEY}}`) is restarted, because a
 * container keeps the environment it was started with.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { slugify } from "@polaris/deploy";
import { loadEnv } from "@polaris/config";
import { withDriver } from "@/lib/data/open";
import { encryptCredentials } from "@polaris/storage";
import { managedAddress } from "@/lib/data/connections";
import { decryptedValue } from "@/lib/deploy/env-values";
import { forgetHealth, runnerFor } from "@/lib/data/health";
import { installExtension, uninstallExtension } from "@/lib/data/maintenance";
import { deployDatabaseAndWait, type DbCredentials } from "@/lib/database-service";
import {
    DatabaseOperationError,
    instanceContext,
    lastLine,
    withPorts,
    type InstanceContext
} from "./ops";

/** A dedicated, deployed PostgreSQL instance the owner holds. */
async function postgresInstance(databaseId: string, ownerId: string) {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: {
            id: true,
            engine: true,
            parentId: true,
            containerName: true,
            statStatements: true
        }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (row.engine !== "postgres")
        throw new DatabaseOperationError("Query statistics are recorded by PostgreSQL only.");
    if (row.parentId) {
        throw new DatabaseOperationError(
            "This database lives inside another instance; turn statistics on for that instance."
        );
    }
    if (!row.containerName)
        throw new DatabaseOperationError("Deploy this database first - it has no container yet.");
    return row;
}

/**
 * Start the instance with pg_stat_statements loaded (or without it), then
 * create the extension so its view exists. A deploy that fails that way is put
 * back.
 */
export async function setStatStatements(
    databaseId: string,
    ownerId: string,
    userId: string,
    enabled: boolean
): Promise<void> {
    const row = await postgresInstance(databaseId, ownerId);
    if (row.statStatements !== enabled) {
        await prisma.managedDatabase.update({
            where: { id: row.id },
            data: { statStatements: enabled }
        });
        const failure = await deployDatabaseAndWait(row.id, ownerId, userId);
        if (failure) {
            await prisma.managedDatabase.update({
                where: { id: row.id },
                data: { statStatements: row.statStatements }
            });
            await deployDatabaseAndWait(row.id, ownerId, userId);
            throw new DatabaseOperationError(
                `The instance did not start that way, so it was put back: ${failure}`
            );
        }
    }
    const address = await managedAddress(ownerId, row.id, false);
    await withDriver(address, async (driver) => {
        const run = runnerFor(driver);
        if (enabled) await installExtension(run, "pg_stat_statements");
        else await uninstallExtension(run, "pg_stat_statements").catch(() => undefined);
    });
    forgetHealth(row.id);
}

/** A service that will be restarted when this database's password changes. */
export interface DependentService {
    readonly id: string;
    readonly name: string;
}

/**
 * The deployed services whose variables name this database.
 *
 * A reference in the environment's shared variables reaches every service in
 * it; one in a service's own variables reaches that service. Secrets are opened
 * only to find the reference, and nothing but the service's name leaves here.
 */
export async function dependentServices(
    databaseId: string,
    ownerId: string
): Promise<DependentService[]> {
    const database = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: { environmentId: true, slug: true, name: true }
    });
    if (!database) throw new DatabaseOperationError("That database is not there any more.");
    const names = new Set([database.slug.toLowerCase(), slugify(database.name).toLowerCase()]);
    const applications = await prisma.application.findMany({
        where: { environmentId: database.environmentId, currentDeploymentId: { not: null } },
        select: { id: true, name: true }
    });
    if (applications.length === 0) return [];
    const variables = await prisma.envVar.findMany({
        where: {
            OR: [
                { scopeType: "environment", scopeId: database.environmentId },
                { scopeType: "application", scopeId: { in: applications.map((app) => app.id) } }
            ]
        }
    });
    let everyone = false;
    const named = new Set<string>();
    for (const variable of variables) {
        let value: string | null = null;
        try {
            value = decryptedValue(variable);
        } catch {
            continue;
        }
        if (!value || !core.referencesIn(value).some((reference) => names.has(reference.name)))
            continue;
        if (variable.scopeType === "environment") everyone = true;
        else named.add(variable.scopeId);
    }
    return applications
        .filter((app) => everyone || named.has(app.id))
        .map((app) => ({ id: app.id, name: app.name }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

/** What a regenerated password can be: the shape `changePasswordCommands` takes. */
function newPassword(): string {
    return randomBytes(24).toString("base64url");
}

async function applyPassword(
    context: InstanceContext,
    password: string,
    adminPassword: string
): Promise<void> {
    const commands = core.changePasswordCommands({
        engine: context.engine as core.DbEngine,
        username: context.own.username,
        database: context.own.database,
        newPassword: password,
        adminUser: context.admin.username,
        adminPassword,
        hosted: context.hosted
    });
    await withPorts(context, async (ports) => {
        for (const command of commands) {
            const result = await ports.runIn(context.container, [...command.argv]);
            if (result.code !== 0) {
                const said = lastLine(result.output, [password, adminPassword]);
                throw new DatabaseOperationError(
                    `${command.describe} failed${said ? `: ${said}` : ""}`
                );
            }
        }
    });
}

/**
 * Give the database's account a new generated password, store it, and restart
 * every service that reads it. Answers the services restarted.
 */
export async function regeneratePassword(
    databaseId: string,
    ownerId: string,
    userId: string,
    restart: (serviceIds: readonly string[]) => void
): Promise<DependentService[]> {
    await oneChangeAtATime(databaseId, () => changePassword(databaseId, ownerId, userId));
    const dependents = await dependentServices(databaseId, ownerId);
    if (dependents.length > 0) restart(dependents.map((service) => service.id));
    return dependents;
}

/** Password changes waiting or running, by database. */
const passwordChanges = new Map<string, Promise<void>>();

/**
 * Run `work` once every change already asked of this database has finished.
 * Two at once would each set the engine and each store their own, in whichever
 * order they finish, and leave the stored password one the engine refuses.
 */
function oneChangeAtATime(databaseId: string, work: () => Promise<void>): Promise<void> {
    const turn = (passwordChanges.get(databaseId) ?? Promise.resolve()).then(work);
    const settled = turn.catch(() => undefined);
    passwordChanges.set(databaseId, settled);
    void settled.then(() => {
        if (passwordChanges.get(databaseId) === settled) passwordChanges.delete(databaseId);
    });
    return turn;
}

/** Set a new password in the engine and store it, read from what is stored now. */
async function changePassword(databaseId: string, ownerId: string, userId: string): Promise<void> {
    const context = await instanceContext(databaseId, ownerId);
    if (!core.isDbEngine(context.engine)) {
        throw new DatabaseOperationError(
            "An object store's keys are managed from its Buckets panel."
        );
    }
    if (context.cluster || context.topology.kind !== "single") {
        throw new DatabaseOperationError(
            "This instance runs as several containers, and their passwords are changed together by redeploying it, not from here."
        );
    }
    const password = newPassword();
    // A dedicated instance signs in with its own account, whose password is
    // about to change; a hosted one with its instance's, which does not.
    const adminBefore = context.admin.password;
    await applyPassword(context, password, adminBefore);

    const stored: DbCredentials = { ...context.own, password };
    try {
        await storeCredentials(context.id, stored);
    } catch (error) {
        // Put the engine back on the password that is still stored.
        await applyPassword(
            context,
            context.own.password,
            context.hosted ? adminBefore : password
        ).catch((undo: unknown) =>
            console.error("databases: a password change could not be undone", undo)
        );
        throw error;
    }
    forgetHealth(context.id);
    // Redis reads its password from the container's command, which still names
    // the old one; started again as it is, it would come back on that.
    if (context.engine === "redis" && !context.hosted) {
        const failure = await deployDatabaseAndWait(context.id, ownerId, userId);
        if (failure) {
            await storeCredentials(context.id, context.own);
            await deployDatabaseAndWait(context.id, ownerId, userId);
            forgetHealth(context.id);
            throw new DatabaseOperationError(
                `The database did not start that way, so it was put back: ${failure}`
            );
        }
    }
}

async function storeCredentials(databaseId: string, credentials: DbCredentials): Promise<void> {
    const blob = encryptCredentials(credentials, loadEnv().POLARIS_MASTER_KEY);
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: {
            encryptedCredential: blob.ciphertext,
            credentialNonce: blob.nonce,
            credentialKeyId: blob.keyId
        }
    });
}

/**
 * Publish the database on a port of its server, or stop publishing it.
 *
 * The container is deployed again with the port mapped; one that does not come
 * back that way is put back as it was. A port another database on the same
 * server already holds, or one in the range applications are given, is refused
 * before anything changes.
 */
export async function setPublicPort(
    databaseId: string,
    ownerId: string,
    userId: string,
    port: number | null
): Promise<void> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: { id: true, parentId: true, targetId: true, exposePort: true, containerName: true }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (row.parentId) {
        throw new DatabaseOperationError(
            "This database lives inside another instance; publish that instance instead."
        );
    }
    if (port !== null) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new DatabaseOperationError("Pick a port between 1024 and 65535.");
        }
        if (port >= core.APP_HOST_PORTS.from && port <= core.APP_HOST_PORTS.to) {
            throw new DatabaseOperationError(
                "Ports 20000 to 39999 are kept for services. Pick another."
            );
        }
        const clash = await prisma.managedDatabase.findFirst({
            where: { targetId: row.targetId, exposePort: port, id: { not: row.id } },
            select: { id: true }
        });
        if (clash)
            throw new DatabaseOperationError(
                "Another database on this server already uses that port."
            );
    }
    if (row.exposePort === port) return;
    await prisma.managedDatabase.update({ where: { id: row.id }, data: { exposePort: port } });
    if (!row.containerName) return;
    const failure = await deployDatabaseAndWait(row.id, ownerId, userId);
    if (failure) {
        await prisma.managedDatabase.update({
            where: { id: row.id },
            data: { exposePort: row.exposePort }
        });
        await deployDatabaseAndWait(row.id, ownerId, userId);
        throw new DatabaseOperationError(
            `The database did not start that way, so it was put back: ${failure}`
        );
    }
}
