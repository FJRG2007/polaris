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
 * runs on is reached by that name, one published on a port on another machine is
 * reached through that machine's own SSH login (Polaris has it, and its pinned
 * key) at the port it is published on, and one on another machine with no
 * published port cannot be reached at all - which is said in those words, with
 * the setting that would fix it named, rather than left as a connection that
 * times out.
 *
 * A database Polaris already knows about is offered without anything being
 * saved: the deploy row holds the address and the credentials, and Polaris' own
 * database is in the environment, so making somebody re-enter either would be
 * asking for what is already there. Those are opened under an id that says where
 * it came from - `managed:<id>`, `polaris` - and each shape re-asks the question
 * behind it in `addressOf`, because an id in a request is a request rather than
 * a permission.
 *
 * A database somewhere else may also be reached through an SSH tunnel rather
 * than directly - through a server already registered in Servers, or through an
 * SSH login typed into the connection itself and pinned the way a Host is (see
 * `tunnel.ts`). The tunnel's own login is a second, separate secret from the
 * database's, encrypted the same way; `addressOf` resolves it fresh on every
 * open so a rotated key or a removed server is caught there rather than at a
 * saved address that quietly stopped being reachable.
 *
 * Three rules keep a stored secret where it was put:
 *
 * - **Every address typed here is judged before it is dialled** (`egress.ts`),
 *   on save and again on every open, and the driver is pointed at the address
 *   that was judged. Somebody who does not run the instance cannot point
 *   Polaris at its own network.
 * - **A kept secret is only kept for the same destination, over encryption at
 *   least as strong.** An edit that leaves the password empty keeps the stored
 *   one only while the engine, the address and the route to it are unchanged,
 *   and the TLS mode has not been weakened; pointing the connection somewhere
 *   else, or turning verification down, asks for the password again, so a
 *   stored password is never sent to an address - or over a channel - it was
 *   not typed for. The SSH login follows the same rule.
 * - **No secret leaves this module.** The views carry what a screen needs to
 *   say - that a password, a key or a client certificate is stored, a key's
 *   fingerprint, a certificate's subject - and never the thing itself.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { readFileSync } from "node:fs";
import { loadEnv } from "@polaris/config";
import { userHasPermission } from "@polaris/auth";
import type { DataAddress, DataEngine } from "./driver";
import { publicKeyLine, readPrivateKey, SshKeyError } from "./ssh-key";
import { legacyTlsMode, NO_TLS, type DataTls } from "./tls";
import { databaseCredentials } from "@/lib/database-service";
import type { SshAuth, SshConnectOptions } from "@polaris/ssh";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { resolveEgress, EgressRefusal, type EgressScope } from "./egress";
import { randomUUID, X509Certificate, createPrivateKey } from "node:crypto";
import {
    probeServerCertificate,
    summarize,
    CertificateProbeError,
    type CertificateSummary
} from "./tls-probe";
import {
    captureHostKey,
    openTunnel,
    presentedHostKey,
    sshFingerprint,
    TunnelError,
    type DataTunnel
} from "./tunnel";
import {
    getHostConnection,
    getHostConnectionUnscoped,
    HostCredentialsError
} from "@/lib/host-service";
import {
    saveConnectionSchema,
    weakerTls,
    type SaveConnectionInput,
    type SshAuthMethod,
    type TlsMode,
    type TlsTrust
} from "./connection-schema";

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
    /** Whether a password is stored. Never the password. */
    readonly hasPassword: boolean;
    /** How it is encrypted, without any key material. */
    readonly tls: TlsView;
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

/** A connection's encryption, as a screen may see it. */
export interface TlsView {
    readonly mode: TlsMode;
    readonly trust: TlsTrust;
    /** The authority it is checked against, when it is not a public one. */
    readonly authority: CertificateSummary | null;
    /** The client certificate it presents, when it presents one. Its key is
     *  stored and never shown. */
    readonly clientCertificate: CertificateSummary | null;
    /** Saved before modes existed, with encryption on and nothing checked:
     *  the form asks for a choice rather than inheriting that silently. */
    readonly legacy: boolean;
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
          /** The stored key's type and fingerprint, when the login is a key. */
          readonly keyType: string | null;
          readonly keyFingerprint: string | null;
          /** The pinned SSH server key, as OpenSSH prints it. */
          readonly hostKeyFingerprint: string | null;
      };

export class DataConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DataConnectionError";
    }
}

/** The sentences this module refuses in that `words.ts` matches by shape. */
export const CONNECTION_REFUSALS = {
    passwordAgain:
        "Enter the password again. The address changed, and a saved password is only sent to the address it was saved for.",
    passwordAgainTls:
        "Enter the password again. The encryption is weaker now, and a saved password is only sent over a connection as safe as the one it was saved for.",
    sshSecretAgain:
        "Enter the SSH password or key again. The SSH server changed, and a saved login is only sent to the server it was saved for.",
    caMissing: "Upload the certificate of the authority that signed the server's certificate.",
    caInvalid:
        "That certificate file could not be read. Use a PEM file with one or more certificates.",
    clientMissing: "Add the client certificate and its key.",
    clientInvalid: "That client certificate and key could not be read, or do not belong together.",
    keyChangedAgain:
        "The server's key changed again since you checked it. Check it again before trusting it.",
    certificateChangedAgain:
        "The server's certificate changed again since you checked it. Check it again before trusting it.",
    notTrustOnFirstUse:
        "This connection does not trust the server's own certificate, so there is nothing to check.",
    notManualTunnel: "This connection has no SSH login of its own to check.",
    noStoredKey: "This connection has no SSH key of its own to show.",
    secretUnreadable: "The saved password could not be read. Enter it again."
} as const;

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
            hasPassword: Boolean(row.encryptedCredential),
            tls: tlsView(row),
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

/** The columns a connection's encryption is read from. */
interface TlsColumns {
    readonly tls: boolean;
    readonly tlsMode?: string | null;
    readonly tlsTrust?: string | null;
    readonly tlsCaCert?: string | null;
    readonly tlsClientCert?: string | null;
}

function tlsView(row: TlsColumns): TlsView {
    const mode = legacyTlsMode(row.tls, row.tlsMode);
    return {
        mode,
        trust: trustOf(row.tlsTrust),
        authority: mode.startsWith("verify") ? readableCertificate(row.tlsCaCert) : null,
        clientCertificate: mode === "disable" ? null : readableCertificate(row.tlsClientCert),
        legacy: !row.tlsMode && row.tls
    };
}

function trustOf(value: string | null | undefined): TlsTrust {
    return value === "upload" || value === "server" ? value : "system";
}

function readableCertificate(pem: string | null | undefined): CertificateSummary | null {
    if (!pem) return null;
    try {
        return summarize(pem);
    } catch {
        return null;
    }
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
    readonly sshHostKey?: string | null;
    readonly sshKeySummary?: string | null;
    readonly sshServer?: { readonly name: string } | null;
    readonly sshJump?: { readonly name: string } | null;
}

function tunnelView(row: TunnelColumns): TunnelView | null {
    if (row.sshMode === "server") {
        return {
            mode: "server",
            hostId: row.sshHostId ?? null,
            hostName: row.sshServer?.name ?? null
        };
    }
    if (row.sshMode === "manual" || row.sshMode === "manual-jump") {
        const authMethod = row.sshAuthMethod === "password" ? "password" : "key";
        const [keyType, keyFingerprint] =
            authMethod === "key" && row.sshKeySummary ? row.sshKeySummary.split(" ") : [];
        return {
            mode: "manual",
            host: row.sshHost ?? "",
            port: row.sshPort ?? 22,
            username: row.sshUsername ?? "",
            authMethod,
            jumpHostId: row.sshJumpHostId ?? null,
            jumpHostName: row.sshJump?.name ?? null,
            jumpMissing: row.sshMode === "manual-jump" && !row.sshJumpHostId,
            keyType: keyType ?? null,
            keyFingerprint: keyFingerprint ?? null,
            hostKeyFingerprint: row.sshHostKey ? sshFingerprint(row.sshHostKey) : null
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

function isRedisCluster(row: {
    readonly engine: string;
    readonly clusterMasters: number | null;
}): boolean {
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
            hasPassword: false,
            tls: NO_TLS_VIEW,
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

const NO_TLS_VIEW: TlsView = {
    mode: "disable",
    trust: "system",
    authority: null,
    clientCertificate: null,
    legacy: false
};

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
        hasPassword: false,
        tls: { ...NO_TLS_VIEW, mode: address.tls.mode },
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

    const sslmode = url.searchParams.get("sslmode") ?? "";
    const mode: TlsMode =
        sslmode === "" || sslmode === "disable"
            ? "disable"
            : sslmode === "verify-ca" || sslmode === "verify-full"
              ? sslmode
              : "require";
    return {
        engine: "postgres",
        host: url.hostname,
        port: url.port ? Number(url.port) : core.DB_ENGINE_INFO.postgres.port,
        database,
        username: decodeURIComponent(url.username) || null,
        password: decodeURIComponent(url.password) || null,
        tls: {
            ...NO_TLS,
            mode,
            ca: mode.startsWith("verify") ? polarisAuthority(url) : null,
            name: url.hostname
        },
        readOnly: true,
        // Its own database only: whatever else shares Polaris' server is not
        // something this read-only window was opened onto.
        confined: true
    };
}

/** The authority `DATABASE_URL` names, the way libpq (`sslrootcert`) or Prisma
 *  (`sslcert`) is told it. Null leaves the public authorities. */
function polarisAuthority(url: URL): string | null {
    const file = url.searchParams.get("sslrootcert") || url.searchParams.get("sslcert");
    if (!file || file === "system") return null;
    try {
        return readAuthorities(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

/* --------------------------------------------------------------------------
 * Saving.
 * ----------------------------------------------------------------------- */

/** The secrets a direct connection stores, sealed together. */
interface DatabaseSecrets {
    password?: string;
    clientKey?: string;
}

/** A saved row, as far as saving and opening read it. */
type StoredRow = NonNullable<Awaited<ReturnType<typeof prisma.dataConnection.findFirst>>>;

/** Who may reach how far in, for this account. */
async function egressScope(userId: string): Promise<EgressScope> {
    return (await userHasPermission(userId, "system.manage")) ? "instance" : "member";
}

/** `resolveEgress`, with its refusal said as one of this module's. */
async function judged(host: string, scope: EgressScope): Promise<string> {
    try {
        return (await resolveEgress(host, scope)).address;
    } catch (error) {
        if (error instanceof EgressRefusal) throw new DataConnectionError(error.message);
        throw error;
    }
}

/** Everything a save writes, and the address it describes - for a test to open
 *  without writing anything. */
interface PreparedConnection {
    readonly fields: Record<string, unknown>;
    readonly address: DataAddress | null;
}

/** Save a new connection or rewrite one this account owns. */
export async function saveConnection(userId: string, input: SaveConnectionInput): Promise<string> {
    const parsed = validate(input);
    const existing = parsed.id
        ? await prisma.dataConnection.findFirst({ where: { id: parsed.id, ownerId: userId } })
        : null;
    if (parsed.id && !existing)
        throw new DataConnectionError("That connection is not there any more.");

    const id = existing?.id ?? randomUUID();
    const { fields } = await prepareConnection(userId, parsed, existing);

    if (existing) {
        await prisma.dataConnection.update({ where: { id: existing.id }, data: fields as never });
        return existing.id;
    }
    const created = await prisma.dataConnection.create({
        data: { id, ownerId: userId, ...fields } as never,
        select: { id: true }
    });
    return created.id;
}

/**
 * Open a connection as the form describes it, without saving anything, and say
 * what answered. The same checks a save makes - the address, the SSH key, the
 * certificate - and the same rules about which stored secrets an edit keeps.
 */
export async function testDraft(
    userId: string,
    input: SaveConnectionInput,
    open: (address: DataAddress) => Promise<string>
): Promise<string> {
    const parsed = validate(input);
    const existing = parsed.id
        ? await prisma.dataConnection.findFirst({ where: { id: parsed.id, ownerId: userId } })
        : null;
    if (parsed.id && !existing)
        throw new DataConnectionError("That connection is not there any more.");
    if (parsed.managedDatabaseId) {
        return open(await managedAddress(userId, parsed.managedDatabaseId, true));
    }
    const { address } = await prepareConnection(userId, parsed, existing);
    if (!address) throw new DataConnectionError("That connection is not valid.");
    return open(address);
}

type Parsed = ReturnType<typeof validate>;

async function prepareConnection(
    userId: string,
    parsed: Parsed,
    existing: StoredRow | null
): Promise<PreparedConnection> {
    if (parsed.managedDatabaseId) {
        // Proves the account may reach it, by the same rule the deploy screens
        // use - a database id in a form is a request, not a permission.
        await databaseCredentials(parsed.managedDatabaseId, userId);
        const target = await prisma.managedDatabase.findFirst({
            where: { id: parsed.managedDatabaseId },
            select: { engine: true, clusterMasters: true }
        });
        if (target && isRedisCluster(target)) throw new DataConnectionError(REDIS_CLUSTER);
        return {
            fields: {
                ...baseFields(parsed),
                ...CLEAR_TUNNEL,
                ...CLEAR_TLS,
                encryptedCredential: null,
                credentialNonce: null,
                credentialKeyId: null
            },
            address: null
        };
    }

    const scope = await egressScope(userId);
    const tunnel = await tunnelColumns(userId, parsed, existing, scope);

    // Only now that the route is known: the database's own address is Polaris'
    // to judge when it dials it, and the SSH server's when it does.
    const dialled = parsed.ssh ? null : await judged(parsed.host, scope);

    const sameDestination = existing !== null && sameRoute(existing, parsed, tunnel);
    const weaker =
        existing !== null &&
        weakerTls(legacyTlsMode(existing.tls, existing.tlsMode), parsed.tlsMode);
    const keepsSecrets = sameDestination && !weaker;
    const previous = existing ? storedSecrets(existing, Boolean(parsed.password)) : {};
    // A password is only ever sent to the address it was typed for, and over a
    // channel at least as safe as the one it was typed for.
    if (!parsed.password && previous.password !== undefined && !keepsSecrets) {
        throw new DataConnectionError(
            sameDestination
                ? CONNECTION_REFUSALS.passwordAgainTls
                : CONNECTION_REFUSALS.passwordAgain
        );
    }
    const stored = keepsSecrets ? previous : {};
    const password = parsed.password ?? stored.password ?? null;

    const tls = await tlsColumns(parsed, existing, sameDestination, stored, tunnel, dialled);

    const secrets: DatabaseSecrets = {
        ...(password !== null ? { password } : {}),
        ...(tls.clientKey ? { clientKey: tls.clientKey } : {})
    };
    const sealed = Object.keys(secrets).length
        ? encryptCredentials(secrets, loadEnv().POLARIS_MASTER_KEY)
        : null;

    const fields = {
        ...baseFields(parsed),
        ...tunnel.columns,
        ...tls.columns,
        encryptedCredential: sealed?.ciphertext ?? null,
        credentialNonce: sealed?.nonce ?? null,
        credentialKeyId: sealed?.keyId ?? null
    };

    const address: DataAddress = {
        engine: parsed.engine,
        host: dialled ?? parsed.host,
        port: parsed.port,
        database: parsed.database,
        username: parsed.username,
        password,
        tls: tls.settings,
        readOnly: parsed.readOnly,
        tunnel: tunnel.tunnel
    };
    return { fields, address };
}

function baseFields(parsed: Parsed) {
    const managed = parsed.managedDatabaseId !== null;
    return {
        name: parsed.name,
        engine: parsed.engine,
        managedDatabaseId: parsed.managedDatabaseId,
        host: managed ? null : parsed.host,
        port: managed ? null : parsed.port,
        database: parsed.database,
        username: parsed.username,
        readOnly: parsed.readOnly
    };
}

/**
 * Whether an edit still points at the same database by the same route: the
 * engine, the address and the port, and the tunnel's own destination. The one
 * question that decides whether a stored secret may be kept.
 */
function sameRoute(existing: StoredRow, parsed: Parsed, tunnel: TunnelPlan): boolean {
    const columns = tunnel.columns;
    return (
        existing.managedDatabaseId === null &&
        existing.engine === parsed.engine &&
        (existing.host ?? "") === (parsed.host ?? "") &&
        existing.port === parsed.port &&
        (existing.sshMode ?? null) === columns.sshMode &&
        (existing.sshHostId ?? null) === columns.sshHostId &&
        (existing.sshHost ?? null) === columns.sshHost &&
        (existing.sshPort ?? null) === columns.sshPort &&
        (existing.sshJumpHostId ?? null) === columns.sshJumpHostId
    );
}

/**
 * What a row holds, for an edit to keep. A blob sealed under a master key this
 * instance no longer has cannot be kept, and is said as such unless the edit is
 * replacing it anyway.
 */
function storedSecrets(row: StoredRow, replacing: boolean): DatabaseSecrets {
    try {
        return readSecrets(row);
    } catch (error) {
        if (replacing) return {};
        console.error("databases: a saved connection's secret could not be read", error);
        throw new DataConnectionError(CONNECTION_REFUSALS.secretUnreadable);
    }
}

function readSecrets(row: StoredRow): DatabaseSecrets {
    if (!row.encryptedCredential || !row.credentialNonce) return {};
    return decryptCredentials<DatabaseSecrets>(
        {
            ciphertext: Buffer.from(row.encryptedCredential),
            nonce: Buffer.from(row.credentialNonce),
            keyId: row.credentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** Every TLS column, emptied: a managed connection has none of its own. */
const CLEAR_TLS = {
    tls: false,
    tlsMode: null,
    tlsTrust: null,
    tlsCaCert: null,
    tlsClientCert: null
} as const;

/** How many certificates an authority file may hold. */
const MAX_AUTHORITIES = 16;

/**
 * The TLS columns for a save, and the settings a test opens with.
 *
 * - An uploaded authority is parsed, every certificate in it; an edit that
 *   uploads nothing keeps the stored one.
 * - "The server's own certificate" is read from the server now when there is
 *   none stored for this destination, and kept otherwise. A certificate that
 *   changed later is trusted again only from the connection's settings, after
 *   the reader has seen it (`trustCertificate`).
 * - A client certificate and its key are parsed and must belong together; the
 *   key is sealed with the database's password, never stored in the clear.
 */
async function tlsColumns(
    parsed: Parsed,
    existing: StoredRow | null,
    sameDestination: boolean,
    stored: DatabaseSecrets,
    tunnel: TunnelPlan,
    dialled: string | null
): Promise<{ columns: Record<string, unknown>; settings: DataTls; clientKey: string | null }> {
    const mode = parsed.tlsMode;
    if (mode === "disable") {
        return { columns: { ...CLEAR_TLS }, settings: NO_TLS, clientKey: null };
    }
    const verifying = mode === "verify-ca" || mode === "verify-full";
    const trust: TlsTrust = verifying ? parsed.tlsTrust : "system";

    let ca: string | null = null;
    if (trust === "upload") {
        if (parsed.tlsCaCert) ca = readAuthorities(parsed.tlsCaCert);
        else if (existing?.tlsTrust === "upload" && existing.tlsCaCert) ca = existing.tlsCaCert;
        else throw new DataConnectionError(CONNECTION_REFUSALS.caMissing);
    } else if (trust === "server") {
        const kept =
            sameDestination && existing?.tlsTrust === "server" && existing.tlsCaCert
                ? existing.tlsCaCert
                : null;
        ca = kept ?? (await readServerCertificate(parsed, tunnel.tunnel, dialled)).anchor;
    }

    let clientCert: string | null = null;
    let clientKey: string | null = null;
    if (parsed.tlsClientAuth) {
        if (parsed.tlsClientCert && parsed.tlsClientKey) {
            clientCert = parsed.tlsClientCert;
            clientKey = readClientPair(parsed.tlsClientCert, parsed.tlsClientKey);
        } else if (existing?.tlsClientCert && sameDestination && stored.clientKey) {
            clientCert = existing.tlsClientCert;
            clientKey = stored.clientKey;
        } else {
            throw new DataConnectionError(CONNECTION_REFUSALS.clientMissing);
        }
    }

    return {
        columns: {
            tls: true,
            tlsMode: mode,
            tlsTrust: trust,
            tlsCaCert: ca,
            tlsClientCert: clientCert
        },
        settings: { mode, ca, clientCert, clientKey, name: parsed.host },
        clientKey
    };
}

/** Every certificate in an uploaded authority file, re-written as PEM so what is
 *  stored is exactly what was parsed. */
function readAuthorities(text: string): string {
    const blocks =
        text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (blocks.length === 0 || blocks.length > MAX_AUTHORITIES) {
        throw new DataConnectionError(CONNECTION_REFUSALS.caInvalid);
    }
    try {
        return blocks.map((block) => new X509Certificate(block).toString()).join("");
    } catch {
        throw new DataConnectionError(CONNECTION_REFUSALS.caInvalid);
    }
}

/** A client certificate and its key, checked to belong together. Returns the
 *  key as PKCS#8 PEM, which every driver reads. */
function readClientPair(certificate: string, key: string): string {
    try {
        const parsedCertificate = new X509Certificate(certificate);
        const parsedKey = createPrivateKey(key);
        if (!parsedCertificate.checkPrivateKey(parsedKey)) throw new Error("mismatch");
        return parsedKey.export({ type: "pkcs8", format: "pem" }).toString();
    } catch {
        throw new DataConnectionError(CONNECTION_REFUSALS.clientInvalid);
    }
}

/** The certificate the server presents, through the tunnel when there is one. */
async function readServerCertificate(
    target: { engine: DataEngine; host: string; port: number },
    tunnel: DataTunnel | null,
    dialled: string | null
) {
    const probe = async (host: string, port: number) => {
        try {
            return await probeServerCertificate(target.engine, { host, port, name: target.host });
        } catch (error) {
            if (error instanceof CertificateProbeError)
                throw new DataConnectionError(error.message);
            throw error;
        }
    };
    if (!tunnel) return probe(dialled ?? target.host, target.port);
    const forwarded = await openTunnel(tunnel, target.host, target.port).catch(rethrowTunnel);
    try {
        return await probe(forwarded.host, forwarded.port);
    } finally {
        forwarded.close();
    }
}

function rethrowTunnel(error: unknown): never {
    if (error instanceof TunnelError) throw new DataConnectionError(error.message);
    throw error;
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
    sshKeySummary: null,
    sshJumpHostId: null
};

type TunnelColumnValues = {
    -readonly [K in keyof typeof CLEAR_TUNNEL]:
        | (typeof CLEAR_TUNNEL)[K]
        | string
        | number
        | Uint8Array;
} & {
    sshMode: string | null;
    sshHostId: string | null;
    sshHost: string | null;
    sshPort: number | null;
    sshJumpHostId: string | null;
};

/** What a save writes for the tunnel, and the tunnel a test or a certificate
 *  read opens. */
interface TunnelPlan {
    readonly columns: TunnelColumnValues;
    readonly tunnel: DataTunnel | null;
}

/**
 * The tunnel columns for a save.
 *
 * A registered server is checked to be this account's and nothing of it is
 * copied. A typed login is signed in to once - through the jump server when
 * there is one - both to prove it works and to capture the key to pin; an edit
 * that changed none of where it points or how it signs in keeps the pinned key
 * and the stored secret instead of asking for them again. A stored secret is
 * only ever offered to the server it was saved for: changing the SSH host, its
 * port or the user asks for it again.
 */
async function tunnelColumns(
    userId: string,
    parsed: Parsed,
    existing: StoredRow | null,
    scope: EgressScope
): Promise<TunnelPlan> {
    const ssh = parsed.ssh;
    if (!ssh) return { columns: { ...CLEAR_TUNNEL }, tunnel: null };

    if (ssh.mode === "server") {
        const server = await ownServer(
            userId,
            ssh.hostId,
            "The server to tunnel through is not one of yours."
        );
        return {
            columns: { ...CLEAR_TUNNEL, sshMode: "server", sshHostId: ssh.hostId },
            tunnel: { target: serverOptions(server), jump: null, label: server.name }
        };
    }

    const jump = ssh.jumpHostId
        ? await ownServer(userId, ssh.jumpHostId, "The server to jump through is not one of yours.")
        : null;
    // Through a jump server the SSH host is that server's to reach, on its own
    // network; straight to it, it is Polaris' and is judged like any address.
    const dialled = jump ? ssh.host : await judged(ssh.host, scope);

    const stored =
        existing && (existing.sshMode === "manual" || existing.sshMode === "manual-jump")
            ? existing
            : null;
    const sameServer =
        stored !== null &&
        stored.sshHost === ssh.host &&
        stored.sshPort === ssh.port &&
        stored.sshUsername === ssh.username;
    const typed = typedSecret(ssh);
    const keepSecret =
        !typed &&
        sameServer &&
        stored?.sshAuthMethod === ssh.authMethod &&
        stored.sshEncryptedCredential;
    if (!typed && !keepSecret) {
        if (
            !sameServer &&
            stored?.sshEncryptedCredential &&
            stored.sshAuthMethod === ssh.authMethod
        ) {
            throw new DataConnectionError(CONNECTION_REFUSALS.sshSecretAgain);
        }
        throw new DataConnectionError(
            ssh.authMethod === "password"
                ? "Enter the password for the SSH login."
                : "Paste the private key for the SSH login."
        );
    }
    const credentials: SshCredentials =
        typed?.credentials ?? readSshCredentials(stored as StoredRow);
    const keySummary = typed ? typed.summary : (stored?.sshKeySummary ?? null);

    // The key already on record for this same login. A re-save keeps being
    // checked against it - typing a new secret is a rotation, not a reason to
    // trust whatever answers at that address - and only the route to it can have
    // changed, so the jump server is no part of this.
    const pinned: string | null = sameServer && stored?.sshHostKey ? stored.sshHostKey : null;
    const unchanged =
        !typed && pinned !== null && (stored?.sshJumpHostId ?? null) === ssh.jumpHostId;

    let hostKey = unchanged ? pinned : null;
    if (!hostKey) {
        try {
            hostKey = await captureHostKey(
                {
                    host: dialled,
                    port: ssh.port,
                    username: ssh.username,
                    auth: toSshAuth(credentials),
                    ...(pinned ? { pinnedHostKey: [pinned] } : {})
                },
                jump ? serverOptions(jump) : null,
                undefined,
                jump?.name ?? null
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

    const blob = typed ? encryptCredentials(typed.credentials, loadEnv().POLARIS_MASTER_KEY) : null;
    return {
        columns: {
            ...CLEAR_TUNNEL,
            sshMode: jump ? "manual-jump" : "manual",
            sshHost: ssh.host,
            sshPort: ssh.port,
            sshUsername: ssh.username,
            sshAuthMethod: ssh.authMethod,
            sshEncryptedCredential: blob
                ? blob.ciphertext
                : (stored?.sshEncryptedCredential ?? null),
            sshCredentialNonce: blob ? blob.nonce : (stored?.sshCredentialNonce ?? null),
            sshCredentialKeyId: blob ? blob.keyId : (stored?.sshCredentialKeyId ?? null),
            sshHostKey: hostKey,
            sshKeySummary: ssh.authMethod === "key" ? keySummary : null,
            sshJumpHostId: jump ? jump.id : null
        },
        tunnel: {
            target: {
                host: dialled,
                port: ssh.port,
                username: ssh.username,
                auth: toSshAuth(credentials),
                pinnedHostKey: [hostKey]
            },
            jump: jump ? serverOptions(jump) : null,
            label: ssh.host,
            ...(jump ? { jumpLabel: jump.name } : {})
        }
    };
}

/** An SSH secret, in the shape a registered server's is stored in. */
type SshCredentials =
    | { method: "password"; password: string }
    | { method: "key"; privateKey: string; passphrase?: string };

/**
 * The secret typed into the form, read: a key is parsed (and converted when it is
 * PKCS#8 or PuTTY), so a wrong passphrase or a public key is refused here, in a
 * sentence, rather than by the SSH server as a failed sign-in.
 */
function typedSecret(
    ssh: Extract<Parsed["ssh"], { mode: "manual" }>
): { credentials: SshCredentials; summary: string | null } | null {
    if (ssh.authMethod === "password") {
        return ssh.password
            ? { credentials: { method: "password", password: ssh.password }, summary: null }
            : null;
    }
    if (!ssh.privateKey) return null;
    let key;
    try {
        key = readPrivateKey(ssh.privateKey, ssh.passphrase);
    } catch (error) {
        if (error instanceof SshKeyError) throw new DataConnectionError(error.message);
        throw error;
    }
    return {
        credentials: key.passphrase
            ? { method: "key", privateKey: key.privateKey, passphrase: key.passphrase }
            : { method: "key", privateKey: key.privateKey },
        summary: `${key.type} ${key.fingerprint}`
    };
}

function readSshCredentials(row: StoredRow): SshCredentials {
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
    let server: OwnedServer;
    try {
        server = await getHostConnection(hostId, userId);
    } catch (error) {
        if (error instanceof HostCredentialsError) {
            console.error("databases: a tunnel server's stored login could not be read", error);
            throw new DataConnectionError(
                `Polaris cannot read the login stored for ${error.hostName}. Add that server again under Servers, then save this connection.`
            );
        }
        throw new DataConnectionError(refusal);
    }
    if (!server.hostKey) {
        throw new DataConnectionError(
            `Polaris has no key on record to check ${server.name} against, so it will not tunnel through it. Remove it under Servers and add it again, then save this connection.`
        );
    }
    return server;
}

function serverOptions(server: OwnedServer): SshConnectOptions {
    return {
        host: server.address,
        port: server.port,
        username: server.username,
        auth: server.auth,
        pinnedHostKey: [server.hostKey as string]
    };
}

export async function deleteConnection(userId: string, id: string): Promise<void> {
    const deleted = await prisma.dataConnection.deleteMany({ where: { id, ownerId: userId } });
    if (deleted.count === 0)
        throw new DataConnectionError("That connection is not there any more.");
}

/* --------------------------------------------------------------------------
 * Opening.
 * ----------------------------------------------------------------------- */

/**
 * The address behind one saved connection, secret included.
 *
 * Server-only, obviously, and the one place a password is decrypted. Every read
 * the screens do goes through it, so "may this account open this database" is
 * answered once rather than at each of a dozen call sites.
 */
export async function addressOf(userId: string, id: string): Promise<DataAddress> {
    // Owned by this account and this id, so calls on it share a held session
    // with nobody else's (`sessions.ts`). Resolved afresh every time all the
    // same: the session is found by what this resolves to, never instead of it.
    const owned = (address: DataAddress): DataAddress => ({
        ...address,
        session: { userId, connectionId: id }
    });
    return owned(await resolvedAddress(userId, id));
}

async function resolvedAddress(userId: string, id: string): Promise<DataAddress> {
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

    const row = await savedRow(userId, id);

    if (row.managedDatabaseId) {
        const resolved = await managedAddress(userId, row.managedDatabaseId, row.readOnly);
        noteUse(row.id);
        return resolved;
    }

    const secrets = readSecrets(row);
    const tunnel = await resolveTunnel(userId, row);
    const host = row.host ?? "127.0.0.1";
    // Judged again on every open: the rule may have tightened, the account
    // may have lost the permission, and the name may answer differently now.
    const dialled = tunnel ? host : await judged(host, await egressScope(userId));
    noteUse(row.id);
    return {
        engine: row.engine as DataEngine,
        host: dialled,
        port: row.port ?? core.DB_ENGINE_INFO[row.engine as DataEngine].port,
        database: row.database,
        username: row.username,
        password: secrets.password ?? null,
        tls: rowTls(row, secrets),
        readOnly: row.readOnly,
        tunnel
    };
}

/** Noted rather than awaited: the list orders by it, and nobody's page should
 *  wait on a write that only decides a sort order. Only once the address was
 *  resolved, so a refused open is not a use. */
function noteUse(id: string): void {
    void prisma.dataConnection
        .update({ where: { id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
}

async function savedRow(userId: string, id: string): Promise<StoredRow> {
    const row = await prisma.dataConnection.findFirst({ where: { id, ownerId: userId } });
    if (!row) throw new DataConnectionError("That connection is not there any more.");
    return row;
}

function rowTls(row: StoredRow, secrets: DatabaseSecrets): DataTls {
    const mode = legacyTlsMode(row.tls, row.tlsMode);
    if (mode === "disable") return NO_TLS;
    return {
        mode,
        ca: mode.startsWith("verify") ? (row.tlsCaCert ?? null) : null,
        clientCert: row.tlsClientCert ?? null,
        clientKey: row.tlsClientCert ? (secrets.clientKey ?? null) : null,
        name: row.host
    };
}

/**
 * The logins a saved tunnel needs, re-read on every open: a registered server's
 * from its own row, so rotating its key reaches every connection through it.
 */
async function resolveTunnel(userId: string, row: StoredRow): Promise<DataTunnel | null> {
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
        throw new DataConnectionError(
            "This connection's SSH login is incomplete. Edit it and save it again."
        );
    }
    const jump = view.jumpHostId
        ? await ownServer(
              userId,
              view.jumpHostId,
              "The server this tunnel jumps through is not one of yours any more."
          )
        : null;
    return {
        target: {
            host: jump ? view.host : await judged(view.host, await egressScope(userId)),
            port: view.port,
            username: view.username,
            auth: toSshAuth(readSshCredentials(row)),
            pinnedHostKey: [row.sshHostKey]
        },
        jump: jump ? serverOptions(jump) : null,
        // i18n-ignore part of a refusal that lib/data/words says in the reader's words
        label: jump ? `${view.host} (through ${jump.name})` : view.host,
        ...(jump ? { jumpLabel: jump.name } : {})
    };
}

/* --------------------------------------------------------------------------
 * A key or a certificate that changed: read it, show it, trust it.
 * ----------------------------------------------------------------------- */

/** The pinned SSH key against the one the server presents now. */
export interface HostKeyCheck {
    readonly pinned: string | null;
    readonly presented: string;
    readonly matches: boolean;
}

async function manualTunnelRow(userId: string, id: string) {
    const row = await savedRow(userId, id);
    const view = tunnelView(row);
    if (!view || view.mode !== "manual")
        throw new DataConnectionError(CONNECTION_REFUSALS.notManualTunnel);
    const broken = tunnelBroken(view);
    if (broken) throw new DataConnectionError(broken);
    const jump = view.jumpHostId
        ? await ownServer(
              userId,
              view.jumpHostId,
              "The server this tunnel jumps through is not one of yours any more."
          )
        : null;
    const host = jump ? view.host : await judged(view.host, await egressScope(userId));
    return { row, view, jump, host };
}

/**
 * The public half of the SSH key a saved connection signs in with, as the line
 * that goes in the SSH server's `authorized_keys`.
 *
 * Only ever the public line. The private key is decrypted here, read, and goes
 * no further: a screen that could get the private key back would make every
 * saved login one XSS or one shoulder away from being copied, and the public
 * line is all anybody needs to let this key in somewhere. Owner only, through
 * the same `savedRow` every other read of a saved connection goes through.
 */
export async function savedPublicKey(userId: string, id: string): Promise<string> {
    const row = await savedRow(userId, id);
    const view = tunnelView(row);
    if (
        !view ||
        view.mode !== "manual" ||
        view.authMethod !== "key" ||
        !row.sshEncryptedCredential ||
        !row.sshCredentialNonce
    ) {
        throw new DataConnectionError(CONNECTION_REFUSALS.noStoredKey);
    }
    const credentials = readSshCredentials(row);
    if (credentials.method !== "key") throw new DataConnectionError(CONNECTION_REFUSALS.noStoredKey);
    try {
        return publicKeyLine(credentials.privateKey, credentials.passphrase ?? null);
    } catch (error) {
        if (error instanceof SshKeyError) throw new DataConnectionError(error.message);
        throw error;
    }
}

/** Read the key the SSH server presents now, without signing in, next to the
 *  one pinned for this connection. */
export async function checkHostKey(userId: string, id: string): Promise<HostKeyCheck> {
    const { row, view, jump, host } = await manualTunnelRow(userId, id);
    const presented = await presentedHostKey(
        { host, port: view.port, username: view.username },
        jump ? serverOptions(jump) : null,
        jump?.name ?? null
    ).catch(rethrowTunnel);
    return {
        pinned: row.sshHostKey ? sshFingerprint(row.sshHostKey) : null,
        presented: sshFingerprint(presented),
        matches: presented === row.sshHostKey
    };
}

/**
 * Pin the key the SSH server presents now - but only the one the reader saw.
 *
 * The fingerprint they were shown comes back with the request, and the key is
 * read again and compared with it: a server that changed its key a second time
 * in between is not trusted on the strength of the first look. The stored login
 * is then signed in with, against that key, before anything is written.
 */
export async function trustHostKey(
    userId: string,
    id: string,
    fingerprint: string
): Promise<string> {
    const { row, view, jump, host } = await manualTunnelRow(userId, id);
    const presented = await presentedHostKey(
        { host, port: view.port, username: view.username },
        jump ? serverOptions(jump) : null,
        jump?.name ?? null
    ).catch(rethrowTunnel);
    if (sshFingerprint(presented) !== fingerprint) {
        throw new DataConnectionError(CONNECTION_REFUSALS.keyChangedAgain);
    }
    try {
        await captureHostKey(
            {
                host,
                port: view.port,
                username: view.username,
                auth: toSshAuth(readSshCredentials(row)),
                pinnedHostKey: [presented]
            },
            jump ? serverOptions(jump) : null,
            undefined,
            jump?.name ?? null
        );
    } catch (error) {
        if (error instanceof TunnelError) throw new DataConnectionError(error.message);
        console.error("databases: the SSH login did not work against the new key", error);
        throw new DataConnectionError(
            `Polaris could not sign in to ${view.host}:${view.port} over SSH${
                jump ? ` through ${jump.name}` : ""
            }. Check the address, the user and the ${view.authMethod === "password" ? "password" : "key"}.`
        );
    }
    await prisma.dataConnection.update({ where: { id: row.id }, data: { sshHostKey: presented } });
    return sshFingerprint(presented);
}

/** The trusted certificate against the one the server presents now. */
export interface CertificateCheck {
    readonly trusted: CertificateSummary | null;
    readonly presented: CertificateSummary;
    readonly matches: boolean;
}

async function trustOnFirstUseRow(userId: string, id: string) {
    const row = await savedRow(userId, id);
    const mode = legacyTlsMode(row.tls, row.tlsMode);
    if (row.managedDatabaseId || !mode.startsWith("verify") || row.tlsTrust !== "server") {
        throw new DataConnectionError(CONNECTION_REFUSALS.notTrustOnFirstUse);
    }
    const tunnel = await resolveTunnel(userId, row);
    const host = row.host ?? "127.0.0.1";
    const dialled = tunnel ? null : await judged(host, await egressScope(userId));
    const target = { engine: row.engine as DataEngine, host, port: row.port ?? 0 };
    return { row, tunnel, dialled, target };
}

export async function checkCertificate(userId: string, id: string): Promise<CertificateCheck> {
    const { row, tunnel, dialled, target } = await trustOnFirstUseRow(userId, id);
    const presented = await readServerCertificate(target, tunnel, dialled);
    const trusted = readableCertificate(row.tlsCaCert);
    return {
        trusted,
        presented: presented.summary,
        matches: trusted?.fingerprint === presented.summary.fingerprint
    };
}

/** Trust the certificate the server presents now, if it is the one the reader
 *  was shown. */
export async function trustCertificate(
    userId: string,
    id: string,
    fingerprint: string
): Promise<CertificateSummary> {
    const { row, tunnel, dialled, target } = await trustOnFirstUseRow(userId, id);
    const presented = await readServerCertificate(target, tunnel, dialled);
    if (presented.summary.fingerprint !== fingerprint) {
        throw new DataConnectionError(CONNECTION_REFUSALS.certificateChangedAgain);
    }
    await prisma.dataConnection.update({
        where: { id: row.id },
        data: { tlsCaCert: presented.anchor }
    });
    return presented.summary;
}

/* --------------------------------------------------------------------------
 * Databases Polaris runs.
 * ----------------------------------------------------------------------- */

/**
 * Where a database Polaris runs answers, from this process.
 *
 * The three cases in the module note, in the order they are preferred: the
 * container's own name when Polaris shares its machine and its network, the
 * published port reached through the target's own SSH login when it is on
 * another machine, and a refusal that names the setting when there is no port.
 *
 * The SSH leg is the point: these databases speak without TLS, and a published
 * port on another machine is otherwise crossed in the clear - password and rows
 * alike - over whatever network lies between the two. A target registered
 * without a pinned key is still reached at the published port directly, as it
 * was before, since there is no key to hold the tunnel to.
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
            target: { select: { kind: true, host: { select: { id: true, address: true } } } }
        }
    });
    if (!row) throw new DataConnectionError("That database is not there any more.");
    if (!core.isDbEngine(row.engine)) {
        throw new DataConnectionError(
            "An object store is browsed from its Buckets panel, not as a database."
        );
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
        return address(engine, container, enginePort, credentials, readOnly, hosted, null);
    }
    if (published) {
        if (local)
            return address(engine, "127.0.0.1", published, credentials, readOnly, hosted, null);
        const tunnel = await targetTunnel(row.target.host?.id ?? null);
        if (tunnel)
            return address(engine, "127.0.0.1", published, credentials, readOnly, hosted, tunnel);
        const host = row.target.host?.address as string;
        return address(engine, host, published, credentials, readOnly, hosted, null);
    }
    throw new DataConnectionError(
        "This database runs on another server and is not published on a port, so Polaris cannot reach it from here. Publish it on a port from the database's own screen, then open it again."
    );
}

/**
 * The SSH login of the server a managed database runs on, as a tunnel - or null
 * when it has no pinned key to hold one to. Not scoped to the account: the
 * caller has already proved the account owns the project the database is in,
 * which is what puts this server behind it.
 */
async function targetTunnel(hostId: string | null): Promise<DataTunnel | null> {
    if (!hostId) return null;
    try {
        const server = await getHostConnectionUnscoped(hostId);
        if (!server.hostKey) return null;
        return { target: serverOptions(server), jump: null, label: server.name };
    } catch (error) {
        console.error("databases: a deploy target's SSH login could not be read", error);
        return null;
    }
}

function address(
    engine: DataEngine,
    host: string,
    port: number,
    credentials: { username: string; password: string; database: string },
    readOnly: boolean,
    hosted: boolean,
    tunnel: DataTunnel | null
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
        tls: NO_TLS,
        readOnly,
        tunnel
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
        throw new DataConnectionError(
            parsed.error.issues[0]?.message ?? "That connection is not valid."
        );
    }
    const value = parsed.data;
    if (value.managedDatabaseId) {
        return {
            ...value,
            host: "",
            port: 0,
            database: null,
            username: null,
            password: null,
            tlsMode: "disable" as TlsMode,
            ssh: null
        };
    }
    // A port left out is the engine's own, which is what a client assumes too.
    return {
        ...value,
        host: value.host as string,
        port: value.port ?? core.DB_ENGINE_INFO[value.engine].port
    };
}
