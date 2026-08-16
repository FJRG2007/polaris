/**
 * The databases somebody can open, and how each one is reached.
 *
 * Two sources, one list. A database Polaris runs is pointed at rather than
 * copied: its address and its credentials are read from the deploy row every
 * time it is opened, so rotating a password or replacing a container does not
 * leave a saved connection pointing at something that stopped being true. A
 * database somewhere else is a host, a port and a secret this table holds,
 * envelope-encrypted with the master key like every other credential in Polaris.
 *
 * Reaching a managed database is the part with a real constraint in it. Its
 * hostname is its container's name on the deploy target's proxy network, which
 * is a name only that machine resolves. So: a database on the machine Polaris
 * runs on is reached by that name, one published on a port is reached at the
 * target's address and that port, and one on another machine with no published
 * port cannot be reached at all - which is said in those words, with the setting
 * that would fix it named, rather than left as a connection that times out.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import type { DataAddress, DataEngine } from "./driver";
import { databaseCredentials } from "@/lib/database-service";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";

/** A saved connection as a screen may see it: no secret, ever. */
export interface DataConnectionView {
    readonly id: string;
    readonly name: string;
    readonly engine: DataEngine;
    /** Set when this is a shortcut to a database Polaris runs. */
    readonly managedDatabaseId: string | null;
    /** Where it points, for the list to say so. A managed one says which
     *  database, not which container. */
    readonly where: string;
    readonly database: string | null;
    readonly username: string | null;
    readonly readOnly: boolean;
    readonly tls: boolean;
    readonly lastUsedAt: string | null;
    readonly createdAt: string;
}

/** What a browser may send to save one. Nothing here is trusted: the engine is
 *  checked against the list, the port against the range, and the host is a
 *  hostname rather than a URL somebody pasted. */
export interface SaveConnectionInput {
    readonly id?: string | null;
    readonly name: string;
    readonly engine: DataEngine;
    readonly managedDatabaseId?: string | null;
    readonly host?: string | null;
    readonly port?: number | null;
    readonly database?: string | null;
    readonly username?: string | null;
    /** Left absent on an edit to keep the stored one. */
    readonly password?: string | null;
    readonly tls?: boolean;
    readonly readOnly?: boolean;
}

export class DataConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DataConnectionError";
    }
}

/** A database Polaris runs, offered as something to point a connection at. */
export interface ManagedOption {
    readonly id: string;
    readonly name: string;
    readonly engine: DataEngine;
    /** Where it lives, for a picker that would otherwise show three databases
     *  called "app". */
    readonly where: string;
    /** False when Polaris cannot open a socket to it from here, with the reason
     *  said in the form rather than discovered on the first query. */
    readonly reachable: boolean;
}

/**
 * The databases Polaris runs that this account may open.
 *
 * The same ownership rule the deploy screens use, asked once here rather than
 * per row: a project's owner reaches its databases.
 */
export async function listManagedOptions(userId: string): Promise<ManagedOption[]> {
    const rows = await prisma.managedDatabase.findMany({
        where: { environment: { project: { ownerId: userId } } },
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            engine: true,
            containerName: true,
            exposePort: true,
            environment: {
                select: { name: true, project: { select: { name: true } } }
            },
            parent: { select: { containerName: true, exposePort: true } },
            target: { select: { name: true, kind: true, host: { select: { address: true } } } }
        }
    });

    return rows.map((row) => {
        const local = row.target.kind === "local" || !row.target.host?.address;
        const container = row.parent ? row.parent.containerName : row.containerName;
        const published = (row.parent ? row.parent.exposePort : row.exposePort) ?? null;
        return {
            id: row.id,
            name: row.name,
            engine: row.engine as DataEngine,
            where: `${row.environment.project.name} / ${row.environment.name}`,
            reachable: Boolean((local && container) || published)
        };
    });
}

/** Every connection this account has saved, newest use first. */
export async function listConnections(userId: string): Promise<DataConnectionView[]> {
    const rows = await prisma.dataConnection.findMany({
        where: { ownerId: userId },
        orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
        include: { managed: { select: { name: true, engine: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        engine: row.engine as DataEngine,
        managedDatabaseId: row.managedDatabaseId,
        where: row.managed ? row.managed.name : `${row.host ?? ""}:${row.port ?? ""}`,
        database: row.database,
        username: row.username,
        readOnly: row.readOnly,
        tls: row.tls,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    }));
}

/** Save a new connection or rewrite one this account owns. */
export async function saveConnection(userId: string, input: SaveConnectionInput): Promise<string> {
    const parsed = validate(input);

    if (parsed.managedDatabaseId) {
        // Proves the account may reach it, by the same rule the deploy screens
        // use - a database id in a form is a request, not a permission.
        await databaseCredentials(parsed.managedDatabaseId, userId);
    }

    const secret =
        parsed.password && !parsed.managedDatabaseId
            ? encryptCredentials({ password: parsed.password }, loadEnv().POLARIS_MASTER_KEY)
            : null;

    if (input.id) {
        const existing = await prisma.dataConnection.findFirst({
            where: { id: input.id, ownerId: userId },
            select: { id: true }
        });
        if (!existing) throw new DataConnectionError("That connection is not there any more.");
        await prisma.dataConnection.update({
            where: { id: existing.id },
            data: {
                name: parsed.name,
                engine: parsed.engine,
                managedDatabaseId: parsed.managedDatabaseId,
                host: parsed.host,
                port: parsed.port,
                database: parsed.database,
                username: parsed.username,
                tls: parsed.tls,
                readOnly: parsed.readOnly,
                // An edit that left the password alone keeps the stored one:
                // asking for it again to rename a connection is how people end
                // up keeping the password in a text file.
                ...(secret
                    ? {
                          encryptedCredential: secret.ciphertext,
                          credentialNonce: secret.nonce,
                          credentialKeyId: secret.keyId
                      }
                    : {})
            }
        });
        return existing.id;
    }

    const created = await prisma.dataConnection.create({
        data: {
            ownerId: userId,
            name: parsed.name,
            engine: parsed.engine,
            managedDatabaseId: parsed.managedDatabaseId,
            host: parsed.host,
            port: parsed.port,
            database: parsed.database,
            username: parsed.username,
            tls: parsed.tls,
            readOnly: parsed.readOnly,
            encryptedCredential: secret?.ciphertext ?? null,
            credentialNonce: secret?.nonce ?? null,
            credentialKeyId: secret?.keyId ?? null
        },
        select: { id: true }
    });
    return created.id;
}

export async function deleteConnection(userId: string, id: string): Promise<void> {
    const deleted = await prisma.dataConnection.deleteMany({ where: { id, ownerId: userId } });
    if (deleted.count === 0) throw new DataConnectionError("That connection is not there any more.");
}

/**
 * The address behind one saved connection, secret included.
 *
 * Server-only, obviously, and the one place a password is decrypted. Every read
 * the screens do goes through it, so "may this account open this database" is
 * answered once rather than at each of a dozen call sites.
 */
export async function addressOf(userId: string, id: string): Promise<DataAddress> {
    const row = await prisma.dataConnection.findFirst({ where: { id, ownerId: userId } });
    if (!row) throw new DataConnectionError("That connection is not there any more.");

    // Noted rather than awaited: the list orders by it, and nobody's page should
    // wait on a write that only decides a sort order.
    void prisma.dataConnection
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);

    if (row.managedDatabaseId) {
        return managedAddress(userId, row.managedDatabaseId, row.readOnly);
    }

    const password =
        row.encryptedCredential && row.credentialNonce
            ? decryptCredentials<{ password: string }>(
                  {
                      ciphertext: Buffer.from(row.encryptedCredential),
                      nonce: Buffer.from(row.credentialNonce),
                      keyId: row.credentialKeyId ?? ""
                  },
                  loadEnv().POLARIS_MASTER_KEY
              ).password
            : null;

    return {
        engine: row.engine as DataEngine,
        host: row.host ?? "127.0.0.1",
        port: row.port ?? core.DB_ENGINE_INFO[row.engine as DataEngine].port,
        database: row.database,
        username: row.username,
        password,
        tls: row.tls,
        readOnly: row.readOnly
    };
}

/**
 * Where a database Polaris runs answers, from this process.
 *
 * The three cases in the module note, in the order they are preferred: the
 * container's own name when Polaris shares its machine and its network, the
 * published port on the target's address when there is one, and a refusal that
 * names the setting when there is not.
 */
export async function managedAddress(
    userId: string,
    databaseId: string,
    readOnly: boolean
): Promise<DataAddress> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId: userId } } },
        include: {
            parent: { select: { containerName: true, exposePort: true } },
            target: { select: { kind: true, host: { select: { address: true } } } }
        }
    });
    if (!row) throw new DataConnectionError("That database is not there any more.");

    const credentials = await databaseCredentials(databaseId, userId);
    const engine = row.engine as DataEngine;
    const enginePort = core.DB_ENGINE_INFO[engine].port;
    const container = row.parent ? row.parent.containerName : row.containerName;
    const published = (row.parent ? row.parent.exposePort : row.exposePort) ?? null;
    const local = row.target.kind === "local" || !row.target.host?.address;

    if (local && container) {
        return address(engine, container, enginePort, credentials, readOnly);
    }
    if (published) {
        const host = local ? "127.0.0.1" : (row.target.host?.address as string);
        return address(engine, host, published, credentials, readOnly);
    }
    throw new DataConnectionError(
        "This database runs on another server and is not published on a port, so Polaris cannot reach it from here. Publish it on a port from the database's own screen, then open it again."
    );
}

function address(
    engine: DataEngine,
    host: string,
    port: number,
    credentials: { username: string; password: string; database: string },
    readOnly: boolean
): DataAddress {
    return {
        engine,
        host,
        port,
        database: credentials.database,
        username: engine === "redis" ? null : credentials.username,
        password: credentials.password,
        // Polaris creates a Mongo database's account inside that database, so
        // that is where it signs in - `admin`, the default everywhere else,
        // does not know it.
        authSource: engine === "mongo" ? credentials.database : null,
        tls: false,
        readOnly
    };
}

/** Checks a save before anything is stored. Everything a browser sent is
 *  suspect, including the parts a form would normally get right. */
function validate(input: SaveConnectionInput): {
    name: string;
    engine: DataEngine;
    managedDatabaseId: string | null;
    host: string | null;
    port: number | null;
    database: string | null;
    username: string | null;
    password: string | null;
    tls: boolean;
    readOnly: boolean;
} {
    const name = String(input.name ?? "").trim();
    if (!name) throw new DataConnectionError("Give the connection a name.");
    if (name.length > 80) throw new DataConnectionError("That name is too long.");

    const engine = input.engine;
    if (!core.DB_ENGINES.includes(engine)) throw new DataConnectionError("Unknown engine.");

    const managedDatabaseId = input.managedDatabaseId?.trim() || null;
    if (managedDatabaseId) {
        return {
            name,
            engine,
            managedDatabaseId,
            host: null,
            port: null,
            database: null,
            username: null,
            password: null,
            tls: false,
            readOnly: input.readOnly !== false
        };
    }

    const host = String(input.host ?? "").trim();
    if (!host) throw new DataConnectionError("Give the address of the database.");
    // A hostname or an address, not a URL: pasting a whole connection string in
    // here silently produces a host nothing resolves.
    if (/[\s/@]/.test(host)) {
        throw new DataConnectionError("Enter a hostname or an IP address, without the rest of a URL.");
    }

    const port = Number(input.port ?? core.DB_ENGINE_INFO[engine].port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new DataConnectionError("That is not a port.");
    }

    return {
        name,
        engine,
        managedDatabaseId: null,
        host,
        port,
        database: input.database?.trim() || null,
        username: input.username?.trim() || null,
        password: input.password ?? null,
        tls: input.tls === true,
        readOnly: input.readOnly !== false
    };
}
