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
 *
 * A database Polaris already knows about is offered without anything being
 * saved: the deploy row holds the address and the credentials, and Polaris' own
 * database is in the environment, so making somebody re-enter either would be
 * asking for what is already there. Those are opened under an id that says where
 * it came from - `managed:<id>`, `polaris` - and each shape re-asks the question
 * behind it in `addressOf`, because an id in a request is a request rather than
 * a permission.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { userHasPermission } from "@polaris/auth";
import type { DataAddress, DataEngine } from "./driver";
import type { SshAuth, SshConnectOptions } from "@polaris/ssh";
import { getHostConnection, HostCredentialsError } from "@/lib/host-service";
import { databaseCredentials } from "@/lib/database-service";
import { captureHostKey, TunnelError, type DataTunnel } from "./tunnel";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { saveConnectionSchema, type SaveConnectionInput, type SshAuthMethod } from "./connection-schema";

export type { SaveConnectionInput } from "./connection-schema";

/** A database Polaris runs, opened without a connection having been saved. */
const MANAGED_PREFIX = "managed:";

/** Polaris' own database, opened by whoever runs the instance. */
const POLARIS_ID = "polaris";

/** A database the browser may open, as a screen may see it: no secret, ever. */
export interface DataConnectionView {
    readonly id: string;
    readonly name: string;
    readonly engine: DataEngine;
    /** Where it came from. Only a saved one can be edited or removed - the other
     *  two are read off what Polaris already knows and have nothing to store. */
    readonly origin: "saved" | "managed" | "polaris";
    /** Set when this is a shortcut to a database Polaris runs. */
    readonly managedDatabaseId: string | null;
    /** Where it points, for the list to say so. A managed one says which
     *  database, not which container. */
    readonly where: string;
    readonly database: string | null;
    readonly username: string | null;
    readonly readOnly: boolean;
    readonly tls: boolean;
    /** The database's own address, for the form to edit. Null on a managed one. */
    readonly host: string | null;
    readonly port: number | null;
    /** How it is reached when not directly. Never carries a secret. */
    readonly tunnel: TunnelView | null;
    /** Something the row has to say before it is opened - that it cannot be
     *  reached from here, or why it is read-only. */
    readonly note: string | null;
    /** True when Polaris already knows it cannot open a socket to it from here,
     *  before anybody has tried. The note says why. */
    readonly unreachable: boolean;
    readonly lastUsedAt: string | null;
    readonly createdAt: string | null;
}

/** A connection's SSH tunnel, as a screen may see it. */
export type TunnelView =
    | {
          readonly mode: "server";
          /** Null once the server was removed from Servers. */
          readonly hostId: string | null;
          readonly hostName: string | null;
      }
    | {
          readonly mode: "manual";
          readonly host: string;
          readonly port: number;
          readonly username: string;
          readonly authMethod: SshAuthMethod;
          /** Set when the login is reached through a registered server. */
          readonly jumpHostId: string | null;
          readonly jumpHostName: string | null;
          /** True when the jump server this login needs was removed. */
          readonly jumpMissing: boolean;
      };

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
    /** Set when the browser cannot open it wherever it runs, and says why. */
    readonly refusal: string | null;
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
            clusterMasters: true,
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
            reachable: Boolean((local && container) || published),
            refusal: isRedisCluster(row) ? REDIS_CLUSTER : null
        };
    });
}

/** Every connection this account has saved, newest use first. */
export async function listConnections(userId: string): Promise<DataConnectionView[]> {
    const rows = await prisma.dataConnection.findMany({
        where: { ownerId: userId },
        orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
        include: {
            managed: { select: { name: true, engine: true } },
            sshServer: { select: { name: true } },
            sshJump: { select: { name: true } }
        }
    });
    return rows.map((row) => {
        const tunnel = row.managedDatabaseId ? null : tunnelView(row);
        const broken = tunnel ? tunnelBroken(tunnel) : null;
        const direct = `${row.host ?? ""}:${row.port ?? ""}`;
        return {
            id: row.id,
            name: row.name,
            engine: row.engine as DataEngine,
            origin: "saved",
            managedDatabaseId: row.managedDatabaseId,
            where: row.managed
                ? row.managed.name
                : tunnel
                  ? `${direct} via ${tunnelLabel(tunnel)}`
                  : direct,
            database: row.database,
            username: row.username,
            readOnly: row.readOnly,
            tls: row.tls,
            host: row.managedDatabaseId ? null : row.host,
            port: row.managedDatabaseId ? null : row.port,
            tunnel,
            note: broken,
            unreachable: broken !== null,
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString()
        };
    });
}

/** The columns a tunnel is read from. */
interface TunnelColumns {
    readonly sshMode?: string | null;
    readonly sshHostId?: string | null;
    readonly sshHost?: string | null;
    readonly sshPort?: number | null;
    readonly sshUsername?: string | null;
    readonly sshAuthMethod?: string | null;
    readonly sshJumpHostId?: string | null;
    readonly sshServer?: { readonly name: string } | null;
    readonly sshJump?: { readonly name: string } | null;
}

function tunnelView(row: TunnelColumns): TunnelView | null {
    if (row.sshMode === "server") {
        return { mode: "server", hostId: row.sshHostId ?? null, hostName: row.sshServer?.name ?? null };
    }
    if (row.sshMode === "manual" || row.sshMode === "manual-jump") {
        return {
            mode: "manual",
            host: row.sshHost ?? "",
            port: row.sshPort ?? 22,
            username: row.sshUsername ?? "",
            authMethod: row.sshAuthMethod === "password" ? "password" : "key",
            jumpHostId: row.sshJumpHostId ?? null,
            jumpHostName: row.sshJump?.name ?? null,
            jumpMissing: row.sshMode === "manual-jump" && !row.sshJumpHostId
        };
    }
    return null;
}

function tunnelLabel(tunnel: TunnelView): string {
    if (tunnel.mode === "server") return tunnel.hostName ?? "a removed server";
    const login = `${tunnel.username}@${tunnel.host}${tunnel.port === 22 ? "" : `:${tunnel.port}`}`;
    return tunnel.jumpHostName ? `${login} through ${tunnel.jumpHostName}` : login;
}

/** Why a tunnel cannot be opened as saved, or null when it can. */
function tunnelBroken(tunnel: TunnelView): string | null {
    if (tunnel.mode === "server" && !tunnel.hostId) {
        return "The server this connection tunnels through was removed from Servers. Edit it to pick another.";
    }
    if (tunnel.mode === "manual" && tunnel.jumpMissing) {
        return "The server this tunnel jumps through was removed from Servers. Edit it to pick another.";
    }
    return null;
}

/** Said in the form and again on the list, because it is the one reason a
 *  database Polaris runs cannot be opened. */
const UNREACHABLE =
    "Runs on another server and is not published on a port, so Polaris cannot reach it from here.";

const REDIS_CLUSTER =
    "A Redis cluster spreads its keys over several masters, and the browser reads one server at a time, so it cannot open one.";

function isRedisCluster(row: { readonly engine: string; readonly clusterMasters: number | null }): boolean {
    return row.engine === "redis" && Boolean(row.clusterMasters);
}

/**
 * Everything this account can open, saved or not.
 *
 * What somebody saved comes first, then the databases Polaris runs for them, then
 * Polaris' own for whoever runs the instance. A managed database a saved
 * connection already points at is left out of the offered half: the saved one has
 * a name somebody chose and a read-only switch they set, and listing the same
 * database twice under two names is how anybody would end up querying the wrong
 * one.
 */
export async function listOpenable(userId: string): Promise<DataConnectionView[]> {
    const [saved, managed, own] = await Promise.all([
        listConnections(userId),
        listManagedOptions(userId),
        polarisDatabase(userId)
    ]);

    const pointedAt = new Set(saved.map((row) => row.managedDatabaseId).filter(Boolean));
    const offered = managed
        .filter((entry) => !pointedAt.has(entry.id))
        .map<DataConnectionView>((entry) => ({
            id: `${MANAGED_PREFIX}${entry.id}`,
            name: entry.name,
            engine: entry.engine,
            origin: "managed",
            managedDatabaseId: entry.id,
            where: entry.where,
            database: null,
            username: null,
            // Read-only until somebody saves a connection to it and says
            // otherwise: opening a production database from a list should not be
            // enough to write to it.
            readOnly: true,
            tls: false,
            host: null,
            port: null,
            tunnel: null,
            note: entry.refusal ?? (entry.reachable ? null : UNREACHABLE),
            unreachable: !entry.reachable,
            lastUsedAt: null,
            createdAt: null
        }));

    return [...saved, ...(own ? [own] : []), ...offered];
}

/**
 * Polaris' own database, for an account that runs the instance.
 *
 * Everything Polaris stores is in here - sessions, encrypted credentials, every
 * app's rows - so it is offered on `system.manage` and never on the `deploy.read`
 * that opens the app, and it is opened read-only: this is a place to look at what
 * the instance holds, not to edit it out from under the running process.
 */
async function polarisDatabase(userId: string): Promise<DataConnectionView | null> {
    const address = polarisAddress();
    if (!address || !(await userHasPermission(userId, "system.manage"))) return null;
    return {
        id: POLARIS_ID,
        name: "Polaris",
        engine: address.engine,
        origin: "polaris",
        managedDatabaseId: null,
        where: "The instance's own data",
        database: address.database ?? null,
        username: address.username ?? null,
        readOnly: true,
        tls: address.tls,
        host: null,
        port: null,
        tunnel: null,
        note: "Read-only. Polaris itself runs on this one.",
        unreachable: false,
        lastUsedAt: null,
        createdAt: null
    };
}

/**
 * Where Polaris' own database is, read from the environment it connects with.
 *
 * Null when there is nothing the browser could open: an instance on SQLite keeps
 * its data in a file rather than behind a socket, and the drivers here speak to
 * servers.
 */
function polarisAddress(): DataAddress | null {
    const env = loadEnv();
    if (env.POLARIS_DB_PROVIDER !== "postgresql") return null;

    let url: URL;
    try {
        url = new URL(env.POLARIS_DATABASE_URL);
    } catch {
        return null;
    }

    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!database) return null;

    return {
        engine: "postgres",
        host: url.hostname,
        port: url.port ? Number(url.port) : core.DB_ENGINE_INFO.postgres.port,
        database,
        username: decodeURIComponent(url.username) || null,
        password: decodeURIComponent(url.password) || null,
        tls: (url.searchParams.get("sslmode") ?? "") !== "" && url.searchParams.get("sslmode") !== "disable",
        readOnly: true
    };
}

/** Save a new connection or rewrite one this account owns. */
export async function saveConnection(userId: string, input: SaveConnectionInput): Promise<string> {
    const parsed = validate(input);

    if (parsed.managedDatabaseId) {
        // Proves the account may reach it, by the same rule the deploy screens
        // use - a database id in a form is a request, not a permission.
        await databaseCredentials(parsed.managedDatabaseId, userId);
        const target = await prisma.managedDatabase.findFirst({
            where: { id: parsed.managedDatabaseId },
            select: { engine: true, clusterMasters: true }
        });
        if (target && isRedisCluster(target)) throw new DataConnectionError(REDIS_CLUSTER);
    }

    const existing = parsed.id
        ? await prisma.dataConnection.findFirst({ where: { id: parsed.id, ownerId: userId } })
        : null;
    if (parsed.id && !existing) throw new DataConnectionError("That connection is not there any more.");

    const secret =
        parsed.password && !parsed.managedDatabaseId
            ? encryptCredentials({ password: parsed.password }, loadEnv().POLARIS_MASTER_KEY)
            : null;
    const tunnel = parsed.managedDatabaseId ? CLEAR_TUNNEL : await tunnelColumns(userId, parsed, existing);

    const fields = {
        name: parsed.name,
        engine: parsed.engine,
        managedDatabaseId: parsed.managedDatabaseId,
        host: parsed.host,
        port: parsed.port,
        database: parsed.database,
        username: parsed.username,
        tls: parsed.tls,
        readOnly: parsed.readOnly,
        ...tunnel
    };

    if (existing) {
        await prisma.dataConnection.update({
            where: { id: existing.id },
            data: {
                ...fields,
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
            ...fields,
            encryptedCredential: secret?.ciphertext ?? null,
            credentialNonce: secret?.nonce ?? null,
            credentialKeyId: secret?.keyId ?? null
        },
        select: { id: true }
    });
    return created.id;
}

/** Every tunnel column, emptied: a direct connection, or a managed one. */
const CLEAR_TUNNEL = {
    sshMode: null,
    sshHostId: null,
    sshHost: null,
    sshPort: null,
    sshUsername: null,
    sshAuthMethod: null,
    sshEncryptedCredential: null,
    sshCredentialNonce: null,
    sshCredentialKeyId: null,
    sshHostKey: null,
    sshJumpHostId: null
} as const;

/** What a saved row already holds for its tunnel, when one is being edited. */
interface StoredTunnel {
    readonly sshMode: string | null;
    readonly sshHost: string | null;
    readonly sshPort: number | null;
    readonly sshUsername: string | null;
    readonly sshAuthMethod: string | null;
    readonly sshEncryptedCredential: Uint8Array | null;
    readonly sshCredentialNonce: Uint8Array | null;
    readonly sshCredentialKeyId: string | null;
    readonly sshHostKey: string | null;
    readonly sshJumpHostId: string | null;
}

/**
 * The tunnel columns for a save.
 *
 * A registered server is checked to be this account's and nothing of it is
 * copied. A typed login is signed in to once - through the jump server when
 * there is one - both to prove it works and to capture the key to pin; an edit
 * that changed none of where it points or how it signs in keeps the pinned key
 * and the stored secret instead of asking for them again.
 */
async function tunnelColumns(
    userId: string,
    parsed: ReturnType<typeof validate>,
    existing: StoredTunnel | null
) {
    const ssh = parsed.ssh;
    if (!ssh) return CLEAR_TUNNEL;

    if (ssh.mode === "server") {
        await ownServer(userId, ssh.hostId, "The server to tunnel through is not one of yours.");
        return { ...CLEAR_TUNNEL, sshMode: "server", sshHostId: ssh.hostId };
    }

    const jump = ssh.jumpHostId
        ? await ownServer(userId, ssh.jumpHostId, "The server to jump through is not one of yours.")
        : null;

    const stored = existing && (existing.sshMode === "manual" || existing.sshMode === "manual-jump") ? existing : null;
    const typed = typedSecret(ssh);
    const keepSecret = !typed && stored?.sshAuthMethod === ssh.authMethod && stored.sshEncryptedCredential;
    if (!typed && !keepSecret) {
        throw new DataConnectionError(
            ssh.authMethod === "password"
                ? "Enter the password for the SSH login."
                : "Paste the private key for the SSH login."
        );
    }
    const credentials: SshCredentials = typed ?? readSshCredentials(stored as StoredTunnel);

    // The key already on record for this same login. A re-save keeps being
    // checked against it - typing a new secret is a rotation, not a reason to
    // trust whatever answers at that address - and only the route to it can have
    // changed, so the jump server is no part of this.
    const pinned: string | null =
        stored?.sshHostKey &&
        stored.sshHost === ssh.host &&
        stored.sshPort === ssh.port &&
        stored.sshUsername === ssh.username
            ? stored.sshHostKey
            : null;

    const unchanged = !typed && pinned !== null && (stored?.sshJumpHostId ?? null) === ssh.jumpHostId;

    let hostKey = unchanged ? pinned : null;
    if (!hostKey) {
        try {
            hostKey = await captureHostKey(
                {
                    host: ssh.host,
                    port: ssh.port,
                    username: ssh.username,
                    auth: toSshAuth(credentials),
                    ...(pinned ? { pinnedHostKey: [pinned] } : {})
                },
                jump ? serverOptions(jump) : null
            );
        } catch (error) {
            // A key that stopped matching says so in its own words; anything else
            // is an address, a user or a secret that did not work.
            if (error instanceof TunnelError) throw new DataConnectionError(error.message);
            console.error("databases: the SSH login did not work", error);
            throw new DataConnectionError(
                `Polaris could not sign in to ${ssh.host}:${ssh.port} over SSH${
                    jump ? ` through ${jump.name}` : ""
                }. Check the address, the user and the ${ssh.authMethod === "password" ? "password" : "key"}.`
            );
        }
    }

    const blob = typed ? encryptCredentials(typed, loadEnv().POLARIS_MASTER_KEY) : null;
    return {
        ...CLEAR_TUNNEL,
        sshMode: jump ? "manual-jump" : "manual",
        sshHost: ssh.host,
        sshPort: ssh.port,
        sshUsername: ssh.username,
        sshAuthMethod: ssh.authMethod,
        sshEncryptedCredential: blob ? blob.ciphertext : (stored?.sshEncryptedCredential ?? null),
        sshCredentialNonce: blob ? blob.nonce : (stored?.sshCredentialNonce ?? null),
        sshCredentialKeyId: blob ? blob.keyId : (stored?.sshCredentialKeyId ?? null),
        sshHostKey: hostKey,
        sshJumpHostId: jump ? jump.id : null
    };
}

/** An SSH secret, in the shape a registered server's is stored in. */
type SshCredentials =
    | { method: "password"; password: string }
    | { method: "key"; privateKey: string; passphrase?: string };

function typedSecret(ssh: Extract<ReturnType<typeof validate>["ssh"], { mode: "manual" }>): SshCredentials | null {
    if (ssh.authMethod === "password") return ssh.password ? { method: "password", password: ssh.password } : null;
    if (!ssh.privateKey) return null;
    return ssh.passphrase
        ? { method: "key", privateKey: ssh.privateKey, passphrase: ssh.passphrase }
        : { method: "key", privateKey: ssh.privateKey };
}

function readSshCredentials(row: StoredTunnel): SshCredentials {
    return decryptCredentials<SshCredentials>(
        {
            ciphertext: Buffer.from(row.sshEncryptedCredential as Uint8Array),
            nonce: Buffer.from(row.sshCredentialNonce as Uint8Array),
            keyId: row.sshCredentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

function toSshAuth(credentials: SshCredentials): SshAuth {
    return credentials.method === "password"
        ? { method: "password", password: credentials.password }
        : { method: "key", privateKey: credentials.privateKey, passphrase: credentials.passphrase };
}

type OwnedServer = Awaited<ReturnType<typeof getHostConnection>>;

/**
 * A registered server this account owns, or the refusal given.
 *
 * A server that is theirs but whose stored login cannot be read is a different
 * thing from one that is not theirs, and is said as itself: telling somebody
 * their own server is not theirs is untrue and leaves them nothing to do about it.
 */
async function ownServer(userId: string, hostId: string, refusal: string): Promise<OwnedServer> {
    try {
        return await getHostConnection(hostId, userId);
    } catch (error) {
        if (error instanceof HostCredentialsError) {
            console.error("databases: a tunnel server's stored login could not be read", error);
            throw new DataConnectionError(
                `Polaris cannot read the login stored for ${error.hostName}. Add that server again under Servers, then save this connection.`
            );
        }
        throw new DataConnectionError(refusal);
    }
}

function serverOptions(server: OwnedServer): SshConnectOptions {
    return {
        host: server.address,
        port: server.port,
        username: server.username,
        auth: server.auth,
        // A registered server is pinned when it is added; one with no key on
        // record (added before pinning) is refused rather than trusted.
        pinnedHostKey: server.hostKey ? [server.hostKey] : []
    };
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
    // The two offered ids carry no row, so each re-asks its own question here
    // rather than being trusted for having been in the list a moment ago.
    if (id.startsWith(MANAGED_PREFIX)) {
        return managedAddress(userId, id.slice(MANAGED_PREFIX.length), true);
    }
    if (id === POLARIS_ID) {
        const address = polarisAddress();
        if (!address || !(await userHasPermission(userId, "system.manage"))) {
            throw new DataConnectionError("That database is not one you can open.");
        }
        return address;
    }

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
        readOnly: row.readOnly,
        tunnel: await resolveTunnel(userId, row)
    };
}

/**
 * The logins a saved tunnel needs, re-read on every open: a registered server's
 * from its own row, so rotating its key reaches every connection through it.
 */
async function resolveTunnel(userId: string, row: StoredTunnel & TunnelColumns): Promise<DataTunnel | null> {
    const view = tunnelView(row);
    if (!view) return null;
    const broken = tunnelBroken(view);
    if (broken) throw new DataConnectionError(broken);

    if (view.mode === "server") {
        const server = await ownServer(
            userId,
            view.hostId as string,
            "The server this connection tunnels through is not one of yours any more."
        );
        return { target: serverOptions(server), jump: null, label: server.name };
    }

    if (!row.sshHostKey || !row.sshEncryptedCredential || !row.sshCredentialNonce) {
        throw new DataConnectionError("This connection's SSH login is incomplete. Edit it and save it again.");
    }
    const jump = view.jumpHostId
        ? await ownServer(userId, view.jumpHostId, "The server this tunnel jumps through is not one of yours any more.")
        : null;
    return {
        target: {
            host: view.host,
            port: view.port,
            username: view.username,
            auth: toSshAuth(readSshCredentials(row)),
            pinnedHostKey: [row.sshHostKey]
        },
        jump: jump ? serverOptions(jump) : null,
        label: jump ? `${view.host} (through ${jump.name})` : view.host
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
    if (!core.isDbEngine(row.engine)) {
        throw new DataConnectionError("An object store is browsed from its Buckets panel, not as a database.");
    }
    if (isRedisCluster(row)) throw new DataConnectionError(REDIS_CLUSTER);

    const credentials = await databaseCredentials(databaseId, userId);
    const engine = row.engine as DataEngine;
    const enginePort = core.DB_ENGINE_INFO[engine].port;
    const container = row.parent ? row.parent.containerName : row.containerName;
    const published = (row.parent ? row.parent.exposePort : row.exposePort) ?? null;
    const local = row.target.kind === "local" || !row.target.host?.address;
    const hosted = row.parent !== null;

    if (local && container) {
        return address(engine, container, enginePort, credentials, readOnly, hosted);
    }
    if (published) {
        const host = local ? "127.0.0.1" : (row.target.host?.address as string);
        return address(engine, host, published, credentials, readOnly, hosted);
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
    readOnly: boolean,
    hosted: boolean
): DataAddress {
    return {
        engine,
        host,
        port,
        database: credentials.database,
        username: engine === "redis" ? null : credentials.username,
        password: credentials.password,
        // A Mongo database hosted on an instance has its account created inside
        // itself, so that is where it signs in; a dedicated instance's account
        // is the root account the image creates, which lives in `admin`.
        authSource: engine === "mongo" ? (hosted ? credentials.database : "admin") : null,
        tls: false,
        readOnly
    };
}

/**
 * Checks a save before anything is stored, with the schema the form validates
 * against as it is typed. Everything a browser sent is suspect, including the
 * parts a form would normally get right.
 */
function validate(input: SaveConnectionInput) {
    const parsed = saveConnectionSchema.safeParse(input);
    if (!parsed.success) {
        throw new DataConnectionError(parsed.error.issues[0]?.message ?? "That connection is not valid.");
    }
    const value = parsed.data;
    if (value.managedDatabaseId) {
        return {
            ...value,
            host: null,
            port: null,
            database: null,
            username: null,
            password: null,
            tls: false,
            ssh: null
        };
    }
    // A port left out is the engine's own, which is what a client assumes too.
    return { ...value, host: value.host as string, port: value.port ?? core.DB_ENGINE_INFO[value.engine].port };
}
