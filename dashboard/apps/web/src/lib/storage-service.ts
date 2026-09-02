/**
 * Server-side storage service. Turns a stored connection row into a live driver:
 * loads it (scoped to its owner), decrypts credentials with the master key, and
 * asks the registry to build the right driver for the current edition. Providers
 * that need a kernel mount are handled by pointing a local driver at the path
 * where polaris-hostd mounts them; establishing that mount is a separate
 * activation step (see enigma marker).
 */

import { isUuid } from "@/lib/uuid";
import { prisma } from "@polaris/db";
import { mkdir } from "node:fs/promises";
import { listSmbShares } from "@/lib/smb-shares";
import { HostdClient } from "@polaris/hostd-client";
import { getCapabilities, loadEnv } from "@polaris/config";
import { ContainerDriver } from "@/lib/deploy/container-driver";
import { linkedAccountToken } from "@/lib/connections/storage-token";
import { fetchUnasMetrics, type UnasMetrics } from "@/lib/unifi-unas";
import { deleteMetricsForSubject } from "@/lib/metrics-history-service";
import { grantedConnectionIds, grantedRootPath } from "@/lib/drive-acl-service";
import type { StorageConfig, StorageCredentials, StorageProviderKind } from "@polaris/core";
import { resolveContainerName, resolveLocalContainer } from "@/lib/container-files-service";
import {
    canHostMount,
    isPersonalKind,
    LOCAL_TARGET,
    PERSONAL_KIND,
    requiresHostd
} from "@polaris/core";
import {
    getHostConnection,
    getHostConnectionUnscoped,
    listHosts,
    type HostConnection
} from "@/lib/host-service";
import {
    borrowSftp,
    borrowSmb,
    dropStorageConnection,
    type SftpLease,
    type SmbLease
} from "@/lib/connection-pool";
import {
    createDriver,
    decryptCredentials,
    encryptCredentials,
    keyFingerprint,
    LocalDriver,
    ScopedDriver,
    SftpDriver,
    SmbDriver,
    type ConnectionRecord,
    type SftpSessionOptions,
    type SmbConnectOptions,
    type SmbSessionOptions,
    type StorageDriver
} from "@polaris/storage";

/** Connection-id prefix for a global Host browsed over SFTP in Drive. The Host is
 *  managed in the Servers app; Drive consumes it read/write over SFTP. */
export const HOST_CONNECTION_PREFIX = "host:";

/** Connection-id prefix for a deployed local container browsed as a Drive folder.
 *  The service is managed in the Deploy app; Drive lists it read-only over hostd. */
export const CONTAINER_CONNECTION_PREFIX = "container:";

/** The folder under POLARIS_DATA_DIR that holds personal drives kept on this
 *  server. Only meaningful for a drive whose target is `local`; one on a storage
 *  connection records its own folder on that storage. */
export const PERSONAL_LOCAL_FOLDER = "drive";

/** A StorageDriver over a deployed container's filesystem (owner-scoped resolve). */
async function buildContainerDriver(
    applicationId: string,
    ownerId: string
): Promise<StorageDriver> {
    const container = await resolveLocalContainer(applicationId, ownerId);
    const driver = new ContainerDriver({
        id: `${CONTAINER_CONNECTION_PREFIX}${applicationId}`,
        container
    });
    await driver.connect();
    return driver;
}

/** Same as above, without the owner check - for routes that have already
 *  authorized the container source via `authorizeDrive`. */
async function buildContainerDriverUnscoped(applicationId: string): Promise<StorageDriver> {
    const container = await resolveContainerName(applicationId);
    const driver = new ContainerDriver({
        id: `${CONTAINER_CONNECTION_PREFIX}${applicationId}`,
        container
    });
    await driver.connect();
    return driver;
}

/** SFTP driver for a global Host. Browses from the SSH root, host-key pinned. */
async function buildHostSftpDriver(hostId: string, ownerId: string): Promise<StorageDriver> {
    return sftpDriverFor(await getHostConnection(hostId, ownerId));
}

/** Same, without the owner check - for routes that have already authorized the
 *  server through `authorizeDrive`. */
async function buildHostSftpDriverUnscoped(hostId: string): Promise<StorageDriver> {
    return sftpDriverFor(await getHostConnectionUnscoped(hostId));
}

async function sftpDriverFor(conn: HostConnection): Promise<StorageDriver> {
    // The connection is borrowed, not opened: the handshake costs far more than the
    // listing that follows it, and a server is usually browsed several folders at a
    // time. `dispose` gives the lease back; the pool decides when to close.
    let lease: SftpLease | undefined;
    const driver = new SftpDriver({
        id: `${HOST_CONNECTION_PREFIX}${conn.id}`,
        root: "/",
        session: async () => {
            lease = await borrowSftp("drive", conn.id, {
                host: conn.address,
                port: conn.port,
                username: conn.username,
                auth: conn.auth,
                // As before: a server with a key on file is pinned to it, one
                // without (added by a path that captured none) is trusted on first
                // use. Tightening that is a separate change, not a side effect here.
                pinnedHostKey: conn.hostKey
            });
            return lease.sftp;
        },
        endSession: () => lease?.release()
    });
    await driver.connect();
    return driver;
}

/** Base path under which the host daemon mounts SMB/NFS shares. */
const HOSTD_MOUNT_ROOT = "/mnt/polaris";

/** How long a mount that answered is taken on trust before the daemon is asked to
 *  establish it again. Short enough that a mount removed behind Polaris's back is
 *  re-established within the minute, long enough that a burst of browsing costs one
 *  daemon call instead of one per request. */
const MOUNT_TRUSTED_MS = 60_000;

/** When each connection's mount was last seen readable from this process. */
const mountsSeenLive = new Map<string, number>();

/** When each personal drive's folder was last known to be there. */
const personalRootsSeen = new Map<string, number>();

/** Whether something was seen inside the trust window. In this process only:
 *  it is a latency shortcut, and a replica working it out again is correct. */
function seenRecently(seen: Map<string, number>, key: string): boolean {
    const at = seen.get(key);
    return at !== undefined && Date.now() - at < MOUNT_TRUSTED_MS;
}

/**
 * Raised when a UniFi UNAS connection is asked to browse files but has no SMB
 * share configured yet. The Drive UI catches this to prompt for the share name
 * (credentials are reused) rather than showing a generic failure.
 */
export class SmbShareRequiredError extends Error {
    public constructor() {
        super("SMB_SHARE_REQUIRED");
        this.name = "SmbShareRequiredError";
    }
}

/** Load a connection scoped to its owner, or throw. */
async function loadConnection(connectionId: string, ownerId: string) {
    const row = await prisma.storageConnection.findFirst({ where: { id: connectionId, ownerId } });
    if (!row) throw new Error("Connection not found");
    return row;
}

/** The minimal storage-connection row this module needs to build a driver. */
type ConnectionRow = {
    id: string;
    kind: string;
    config: string;
    encryptedCredential: Uint8Array | null;
    credentialNonce: Uint8Array | null;
    credentialKeyId: string | null;
};

/** Decrypt a row's credentials, whatever kind it is. */
function credentialsOf(row: ConnectionRow): StorageCredentials {
    if (!row.encryptedCredential || !row.credentialNonce)
        return { kind: row.kind } as StorageCredentials;
    return decryptCredentials(
        {
            ciphertext: Buffer.from(row.encryptedCredential),
            nonce: Buffer.from(row.credentialNonce),
            keyId: row.credentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/**
 * Put the kernel mount for a host-mountable connection in place and hand back a
 * local driver onto it, or null when that is not available here.
 *
 * Reading a share through the kernel mount instead of a userspace SMB session is
 * the difference between a local `stat` and a fresh TCP connect, SMB negotiate,
 * NTLM session setup and tree connect for every single call - and the userspace
 * client checks a connection by listing the whole share root, so the cost lands
 * on operations that never asked for a listing (creating one volume folder used
 * to pay for all of it, twice).
 *
 * The mount is established here rather than assumed, because assuming it is how
 * a share silently reads as an empty folder: the deploy pipeline and the boot
 * reconcile both mount it, but neither has necessarily run when Drive or the
 * volume form asks.
 *
 * Asking the daemon is a request over the wire, though, and browsing is not rare -
 * every listing, download and upload came through here. A mount this process has
 * already seen live is taken on trust for a minute, guarded by the local `stat` the
 * driver does anyway: if the mount has died in the meantime that stat fails, the
 * memory is dropped and the daemon is asked properly.
 */
async function hostMountedDriver(row: ConnectionRow): Promise<StorageDriver | null> {
    // Both of these used to return without a word, and between them they are the
    // whole difference between reading a share through the kernel and reading it
    // through a userspace client that falls over when two requests overlap. A
    // wall of thumbnails is exactly that overlap, so the fallback has to say it
    // happened.
    if (!getCapabilities().nativeMounts) {
        console.error(`storage: no host mounts available, reading ${row.id} over its own protocol`);
        return null;
    }
    const spec = mountSpecFor(row);
    if (!spec) {
        console.error(
            `storage: ${row.id} (${row.kind}) has nothing to mount, reading it over its own protocol`
        );
        return null;
    }
    const seenAt = mountsSeenLive.get(row.id);
    if (seenAt !== undefined && Date.now() - seenAt < MOUNT_TRUSTED_MS) {
        const driver = await mountedLocalDriver(row.id);
        if (driver) return driver;
        mountsSeenLive.delete(row.id);
    }
    try {
        await new HostdClient().createMount({
            id: spec.id,
            kind: spec.kind,
            source: spec.source,
            target: spec.id,
            options: spec.options,
            username: spec.username,
            password: spec.password
        });
    } catch (error) {
        // The daemon is the fast path, not the only one. A share it cannot mount
        // (no daemon, an NFS export that moved, a NAS that is briefly away) falls
        // back to whatever userspace path the kind has, so browsing keeps working.
        console.error(`storage: could not host-mount ${row.id}, falling back to userspace:`, error);
        return null;
    }
    // The daemon mounts into the HOST's namespace; this process only sees that
    // mount when `<mount_root>` is bound into its own container with slave
    // propagation. Where it is not - an older compose file, a deployment that
    // predates the bind, or a mount whose session has died and answers EHOSTDOWN -
    // the path is unreadable here even though the daemon reported success. Falling
    // back keeps Drive working instead of failing the whole connection, which is
    // the difference between "a bit slower" and "Could not connect to this
    // location".
    const driver = await mountedLocalDriver(row.id);
    if (driver) mountsSeenLive.set(row.id, Date.now());
    return driver;
}

/** Forget everything this process is holding for a connection: its pooled sessions
 *  and its mount. Called whenever the row behind them changes or goes away, since
 *  both outlive the request that opened them. */
function forgetConnection(connectionId: string): void {
    dropStorageConnection(connectionId);
    mountsSeenLive.delete(connectionId);
}

/** A local driver onto a mount, or null when the path is not readable from here. */
async function mountedLocalDriver(connectionId: string): Promise<StorageDriver | null> {
    const driver = new LocalDriver({
        id: connectionId,
        root: `${HOSTD_MOUNT_ROOT}/${connectionId}`
    });
    try {
        await driver.connect();
    } catch (error) {
        console.error(
            `storage: host mount for ${connectionId} is not readable here, falling back to userspace:`,
            error
        );
        return null;
    }
    return driver;
}

/**
 * Lend the registry a pooled SFTP session for a stored `sftp` connection, so a NAS
 * reached over SSH re-authenticates as rarely as a server does. Keyed by connection
 * id, which is what the pool needs to tell two connections to the same address (a
 * different account, a different root) apart.
 */
function pooledSftpSession(
    record: ConnectionRecord
): Pick<SftpSessionOptions, "session" | "endSession"> {
    const config = record.config as Extract<StorageConfig, { kind: "sftp" }>;
    const creds = record.credentials as Extract<StorageCredentials, { kind: "sftp" }>;
    let lease: SftpLease | undefined;
    return {
        session: async () => {
            lease = await borrowSftp("drive", record.id, {
                host: config.host,
                port: config.port ?? 22,
                username: config.username,
                auth: creds.privateKey
                    ? { method: "key", privateKey: creds.privateKey, passphrase: creds.passphrase }
                    : { method: "password", password: creds.password ?? "" }
            });
            return lease.sftp;
        },
        endSession: () => lease?.release()
    };
}

/**
 * The same for an SMB share. This is the userspace path - a share Polaris can
 * kernel-mount is read through the mount instead - and it is the one that pays most
 * for a session, since this client proves a new one by listing the whole share root.
 */
function pooledSmbSession(
    connectionId: string,
    options: Omit<SmbConnectOptions, "id">
): Pick<SmbSessionOptions, "session" | "endSession"> {
    let lease: SmbLease | undefined;
    return {
        session: async () => {
            lease = await borrowSmb(connectionId, options);
            return lease.session;
        },
        endSession: () => lease?.release()
    };
}

/** Decrypt a row's credentials and build a connected driver for it. */
async function buildDriver(row: ConnectionRow): Promise<StorageDriver> {
    const config = JSON.parse(row.config) as StorageConfig;

    // Somebody's own drive is a folder on a storage that is already connected,
    // so it has no credentials of its own and never reaches the registry: the
    // storage it sits on is opened and then confined to that folder.
    if (isPersonalKind(row.kind)) {
        const cfg = config as Extract<StorageConfig, { kind: "personal" }>;
        const inner =
            cfg.targetId === LOCAL_TARGET
                ? await localDriveDisk()
                : await getDriverForConnection(cfg.targetId);
        const driver = new ScopedDriver({
            id: row.id,
            inner,
            prefix: cfg.root,
            // Make the folder if it is not there: it is Polaris's to keep, a
            // drive that has never been written to has nothing on disk yet, and
            // one whose folder was removed behind Polaris's back repairs itself
            // rather than becoming a location that will not open.
            //
            // Not on every request, though. On a share that is four levels of
            // mkdir against a NAS before the listing that was actually asked
            // for, and browsing is many requests - so a folder seen recently is
            // taken on trust, exactly as a mount is above.
            createRoot: !seenRecently(personalRootsSeen, row.id),
            // Both branches above hand back an open driver, and opening one twice
            // over a pooled protocol borrows a second session that nothing ever
            // gives back.
            innerConnected: true
        });
        await driver.connect();
        // Only once it opened: a connect that failed proves nothing about the
        // folder, and remembering it as seen would spend the next minute not
        // making the one thing that was missing.
        personalRootsSeen.set(row.id, Date.now());
        return driver;
    }

    const credentials = credentialsOf(row);

    // A UniFi UNAS is a metrics connection, but its files are reachable over the
    // SMB share on the same device - and the UNAS accepts the same UniFi account,
    // so we reuse the stored username/password and only need the share name. When
    // the share is set, browse over SMB; otherwise signal the UI to ask for it.
    if (row.kind === "unifi-unas") {
        const cfg = config as Extract<StorageConfig, { kind: "unifi-unas" }>;
        if (!cfg.smbShare) throw new SmbShareRequiredError();
        const mounted = await hostMountedDriver(row);
        if (mounted) return mounted;
        const creds = credentials as Extract<StorageCredentials, { kind: "unifi-unas" }>;
        const driver = new SmbDriver({
            id: row.id,
            ...pooledSmbSession(row.id, {
                host: cfg.host,
                port: 445,
                share: cfg.smbShare,
                username: cfg.username,
                password: creds.password
            })
        });
        await driver.connect();
        return driver;
    }

    const record: ConnectionRecord = {
        id: row.id,
        kind: row.kind as StorageProviderKind,
        config,
        credentials
    };

    // A share Polaris can kernel-mount is read through that mount when the daemon
    // is here, and over its own protocol when it is not.
    if (canHostMount(record.kind)) {
        const mounted = await hostMountedDriver(row);
        if (mounted) return mounted;
    }

    // Without the mount, `nativeMounts` would still route a preferring kind at the
    // daemon and land on an empty directory, so the registry is asked for the
    // userspace driver explicitly. A kind that REQUIRES the daemon has none, and
    // is left to fail with the registry's own reason.
    const capabilities = getCapabilities();
    const driver = createDriver(record, {
        capabilities: requiresHostd(record.kind)
            ? capabilities
            : { ...capabilities, nativeMounts: false },
        hostdFactory: (rec) =>
            new LocalDriver({ id: rec.id, root: `${HOSTD_MOUNT_ROOT}/${rec.id}` }),
        sftpSessionFactory: (rec) => pooledSftpSession(rec),
        // The consumer drives authorize through somebody's linked account rather
        // than a credential of their own; this is what turns one into a token.
        oauthTokenFactory: (rec) => linkedAccountToken(rec),
        // Google Drive has no paths, so the folder everything lives under has to
        // be created and then remembered. Without this it would be created again
        // on every operation and the copies would scatter across duplicates.
        onRootFolderResolved: async (rec, folderId) => {
            const current = rec.config as Extract<StorageConfig, { kind: "gdrive" | "onedrive" }>;
            await prisma.storageConnection
                .update({
                    where: { id: rec.id },
                    data: { config: JSON.stringify({ ...current, rootFolderId: folderId }) }
                })
                .catch(() => undefined);
        },
        smbSessionFactory: (rec) => {
            const cfg = rec.config as Extract<StorageConfig, { kind: "smb" }>;
            const creds = rec.credentials as Extract<StorageCredentials, { kind: "smb" }>;
            return pooledSmbSession(rec.id, {
                host: cfg.host,
                port: cfg.port ?? 445,
                share: cfg.share,
                domain: cfg.domain,
                username: cfg.username,
                password: creds.password
            });
        }
    });
    await driver.connect();
    return driver;
}

/** What a kernel mount of a connection needs, or null for a kind Polaris does not
 *  mount. Callers that already hold the row use this; `resolveMountTarget` is the
 *  owner-scoped entry point for callers that only have an id. */
export interface MountSpec {
    id: string;
    kind: "smb" | "nfs";
    source: string;
    options?: string;
    username?: string;
    password?: string;
}

/** Permissive modes so a container (root or not) reads/writes the share like a
 *  normal docker volume; nobrl avoids byte-range-lock errors some apps trigger. */
const SMB_OPTS = "vers=3.0,uid=0,gid=0,file_mode=0666,dir_mode=0777,nobrl";

function mountSpecFor(row: ConnectionRow): MountSpec | null {
    const config = JSON.parse(row.config) as StorageConfig;
    const credentials = credentialsOf(row);
    if (row.kind === "unifi-unas") {
        const cfg = config as Extract<StorageConfig, { kind: "unifi-unas" }>;
        if (!cfg.smbShare) return null;
        const creds = credentials as Extract<StorageCredentials, { kind: "unifi-unas" }>;
        return {
            id: row.id,
            kind: "smb",
            source: `//${cfg.host}/${cfg.smbShare}`,
            options: SMB_OPTS,
            username: cfg.username,
            password: creds.password
        };
    }
    if (row.kind === "smb") {
        const cfg = config as Extract<StorageConfig, { kind: "smb" }>;
        const creds = credentials as Extract<StorageCredentials, { kind: "smb" }>;
        return {
            id: row.id,
            kind: "smb",
            source: `//${cfg.host}/${cfg.share}`,
            options: SMB_OPTS,
            username: cfg.username,
            password: creds.password
        };
    }
    if (row.kind === "nfs") {
        const cfg = config as Extract<StorageConfig, { kind: "nfs" }>;
        return {
            id: row.id,
            kind: "nfs",
            source: `${cfg.host}:${cfg.exportPath}`,
            options: "nfsvers=4"
        };
    }
    return null;
}

/** Build the NAS mount spec for a host-mountable connection (smb/unifi-unas/nfs),
 *  so the deploy pipeline can kernel-mount it at `<mount_root>/<id>` and a bind
 *  volume under it resolves onto the NAS. Returns null for kinds Polaris does not
 *  kernel-mount. Owner-scoped via loadConnection; decrypts SMB credentials. */
export async function resolveMountTarget(
    connectionId: string,
    ownerId: string
): Promise<MountSpec | null> {
    return mountSpecFor(await loadConnection(connectionId, ownerId));
}

/** Build a connected driver for a connection owned by the given user. A `host:`
 *  id resolves to a global Host browsed over SFTP; everything else is a stored
 *  storage connection. */
export async function getDriver(connectionId: string, ownerId: string): Promise<StorageDriver> {
    if (connectionId.startsWith(HOST_CONNECTION_PREFIX)) {
        return buildHostSftpDriver(connectionId.slice(HOST_CONNECTION_PREFIX.length), ownerId);
    }
    if (connectionId.startsWith(CONTAINER_CONNECTION_PREFIX)) {
        return buildContainerDriver(
            connectionId.slice(CONTAINER_CONNECTION_PREFIX.length),
            ownerId
        );
    }
    return buildDriver(await loadConnection(connectionId, ownerId));
}

/**
 * Build a driver for a connection WITHOUT an owner check. Only for server-trusted
 * public paths (share/file-request access) where a validated token row is the
 * authorization; never call this from a user-facing action, which must scope to
 * the caller with getDriver().
 */
export async function getDriverForConnection(connectionId: string): Promise<StorageDriver> {
    if (connectionId.startsWith(HOST_CONNECTION_PREFIX)) {
        return buildHostSftpDriverUnscoped(connectionId.slice(HOST_CONNECTION_PREFIX.length));
    }
    if (connectionId.startsWith(CONTAINER_CONNECTION_PREFIX)) {
        return buildContainerDriverUnscoped(connectionId.slice(CONTAINER_CONNECTION_PREFIX.length));
    }
    const row = await prisma.storageConnection.findUnique({ where: { id: connectionId } });
    if (!row) throw new Error("Connection not found");
    return buildDriver(row);
}

/** The disk this server keeps personal drives on, opened at the folder they
 *  share. Made on first use: on a fresh install nothing has written there yet,
 *  and the local driver refuses a root that is not there. */
async function localDriveDisk(): Promise<StorageDriver> {
    const root = `${loadEnv().POLARIS_DATA_DIR}/${PERSONAL_LOCAL_FOLDER}`;
    await mkdir(root, { recursive: true });
    const driver = new LocalDriver({ id: LOCAL_TARGET, root });
    await driver.connect();
    return driver;
}

/** Native UniFi UNAS metrics for a connection (via the UniFi OS console API). */
export async function getUnasMetrics(connectionId: string, ownerId: string): Promise<UnasMetrics> {
    const row = await loadConnection(connectionId, ownerId);
    if (row.kind !== "unifi-unas") throw new Error("Not a UniFi UNAS connection");
    const env = loadEnv();
    const config = JSON.parse(row.config) as Extract<StorageConfig, { kind: "unifi-unas" }>;
    const credentials =
        row.encryptedCredential && row.credentialNonce
            ? decryptCredentials<{ password?: string }>(
                  {
                      ciphertext: Buffer.from(row.encryptedCredential),
                      nonce: Buffer.from(row.credentialNonce),
                      keyId: row.credentialKeyId ?? ""
                  },
                  env.POLARIS_MASTER_KEY
              )
            : {};
    return fetchUnasMetrics({
        host: config.host,
        port: config.port,
        username: config.username,
        password: credentials.password ?? "",
        secure: config.secure
    });
}

/** The non-secret columns of a connection the Drive UI needs. `credentialKeyId`
 *  is the master-key fingerprint (never the key), used only to flag rows whose
 *  credentials predate the current master key; it is not sent to the client. */
const CONNECTION_SUMMARY_SELECT = {
    id: true,
    name: true,
    ownerId: true,
    kind: true,
    status: true,
    requiresHostd: true,
    config: true,
    createdAt: true,
    credentialKeyId: true
} as const;

/**
 * True when a stored credential was encrypted under a master key other than the
 * current one: it can no longer be decrypted, so the connection needs its secret
 * re-entered (which re-encrypts under the current key, keeping everything else).
 * A row with no stored credential (null keyId) is never flagged.
 */
function isRekeyNeeded(credentialKeyId: string | null, currentFingerprint: string): boolean {
    return credentialKeyId !== null && credentialKeyId !== currentFingerprint;
}

/** Drop the raw key fingerprint from a summary row, replacing it with the derived
 *  `needsRekey` flag the UI actually consumes. */
function annotateRekey<T extends { credentialKeyId: string | null }>(
    row: T,
    currentFingerprint: string
): Omit<T, "credentialKeyId"> & { needsRekey: boolean } {
    const { credentialKeyId, ...rest } = row;
    return { ...rest, needsRekey: isRekeyNeeded(credentialKeyId, currentFingerprint) };
}

/** All connections owned by a user, without secret material. Each carries a
 *  `needsRekey` flag when its credentials no longer match the master key. */
export async function listConnections(ownerId: string, options?: { readonly personal?: boolean }) {
    const rows = await prisma.storageConnection.findMany({
        // A personal drive is a storage somebody owns and nothing else may use,
        // so it is absent unless the caller is Drive and asks for it. Left in by
        // default it would turn up as a volume for a deployed service, a place to
        // install an app, a destination for a backup - all of which would be one
        // person's own room being handed to the instance.
        where: options?.personal ? { ownerId } : { ownerId, kind: { not: PERSONAL_KIND } },
        select: CONNECTION_SUMMARY_SELECT,
        orderBy: { createdAt: "asc" }
    });
    const fingerprint = keyFingerprint(loadEnv().POLARIS_MASTER_KEY);
    // Your own files come first wherever they appear, the way they do in every
    // file manager: it is the location you open, and the connected storages are
    // the ones you go looking for.
    const ordered = [
        ...rows.filter((row) => isPersonalKind(row.kind)),
        ...rows.filter((row) => !isPersonalKind(row.kind))
    ];
    return ordered.map((row) => annotateRekey(row, fingerprint));
}

/**
 * Connections a user may browse: the ones they own plus any another user has
 * shared with them through an allow ACL (on the whole connection or a subtree).
 * Shared connections are flagged so the UI can distinguish them; the actual
 * per-path enforcement still happens in the Drive routes and actions.
 */
/**
 * The Drive of every organization this account is on the roster of.
 *
 * Listed rather than looked up one at a time, and made on the way: an
 * organization's shelf should be there the first time somebody opens Drive
 * inside it, not the first time an administrator remembers to create something.
 *
 * A drive that cannot be made - a storage that is away, a name collision - is
 * left out rather than allowed to take the whole listing down with it. Somebody
 * whose NAS is unplugged still gets to see their own files.
 *
 * Whether this account may run the shelf's own rules comes back with it, because
 * it is the organization's question rather than the row's: nobody owns a company
 * drive, so ownership answers no for everybody including the owner, and a screen
 * that reads the row alone offers Manage access to a whole roster and then
 * refuses every one of them.
 */
async function organizationDrivesFor(userId: string) {
    const { memberOrgIds, resolveOrgAccess, orgCan } = await import("@/lib/orgs/org-service");
    const { ensureOrganizationDrive } = await import("@/lib/organization-drive");
    const orgIds = await memberOrgIds(userId);
    const drives = await Promise.all(
        orgIds.map(async (orgId) => {
            try {
                const [drive, access] = await Promise.all([
                    ensureOrganizationDrive(orgId),
                    resolveOrgAccess({ id: userId, isAdmin: false }, orgId)
                ]);
                return {
                    id: drive.id,
                    name: drive.name,
                    kind: PERSONAL_KIND,
                    status: "active",
                    requiresHostd: false,
                    config: JSON.stringify({
                        kind: PERSONAL_KIND,
                        targetId: drive.targetId,
                        root: drive.root
                    }),
                    createdAt: new Date(),
                    shared: false,
                    manageable: orgCan(access, "drive.manage"),
                    needsRekey: false
                };
            } catch {
                return null;
            }
        })
    );
    return drives.filter((drive) => drive !== null);
}

export async function listAccessibleConnections(userId: string) {
    const [owned, grantedIds, hosts, orgDrives] = await Promise.all([
        listConnections(userId, { personal: true }),
        grantedConnectionIds(userId),
        listHosts(userId),
        organizationDrivesFor(userId)
    ]);
    const ownedIds = new Set(owned.map((row) => row.id));
    const sharedIds = grantedIds.filter((id) => !ownedIds.has(id));
    const fingerprint = keyFingerprint(loadEnv().POLARIS_MASTER_KEY);
    const shared =
        sharedIds.length === 0
            ? []
            : await prisma.storageConnection.findMany({
                  where: { id: { in: sharedIds } },
                  select: CONNECTION_SUMMARY_SELECT,
                  orderBy: { createdAt: "asc" }
              });
    // Global Hosts appear as SFTP sources so a server registered once is
    // browsable in Drive. Managed in the Servers app, so not editable (or
    // re-keyed) here - hence needsRekey is always false for them.
    const hostSummaries = hosts.map((host) => ({
        id: `${HOST_CONNECTION_PREFIX}${host.id}`,
        name: host.name,
        kind: "sftp",
        status: host.status,
        requiresHostd: false,
        config: JSON.stringify({
            kind: "sftp",
            host: host.address,
            port: host.port,
            root: "/",
            username: host.username
        }),
        createdAt: host.createdAt,
        shared: false,
        manageable: false,
        needsRekey: false
    }));
    return [
        // `manageable` is who runs the location's own rules - its grants, its
        // locks, what is shared out of it. Ownership answers it everywhere
        // except a company's shelf, which is why it is carried rather than
        // worked out again from `shared` on the screen.
        ...owned.map((row) => ({ ...row, shared: false, manageable: true })),
        // The shelves of the organizations this account belongs to. Not "shared"
        // - nobody handed them over, they are the company's and being on the
        // roster is what reaches them - so they sit beside your own rather than
        // under what somebody gave you.
        ...orgDrives,
        // Somebody else's own drive is never a location in your sidebar, even
        // when they have shared a folder out of it: what you were given is that
        // folder, and listing the drive would open at a root you may not read
        // and refuse you there. Shared items are reached from the Shared screen,
        // which knows the path, and the browser resolves the storage from that.
        ...shared
            .filter((row) => !isPersonalKind(row.kind))
            .map((row) => ({
                ...annotateRekey(row, fingerprint),
                shared: true,
                manageable: false
            })),
        ...hostSummaries
    ];
}

/**
 * One storage the viewer reaches only through a grant, resolved on demand.
 *
 * For opening a shared item: the Shared screen links straight at a path, and the
 * browser needs the storage it is on even though that storage is deliberately
 * not in the sidebar. Answers null unless there is a live grant, so a hand-typed
 * connection id gets nothing - the per-path check still runs afterwards, this is
 * only what decides whether the location is drawn at all.
 */
export async function getSharedConnection(userId: string, connectionId: string) {
    if (!isUuid(connectionId)) return null;
    const granted = await grantedConnectionIds(userId);
    if (!granted.includes(connectionId)) return null;

    const [row, rootPath] = await Promise.all([
        prisma.storageConnection.findUnique({
            where: { id: connectionId },
            select: { ...CONNECTION_SUMMARY_SELECT, owner: { select: { name: true } } }
        }),
        grantedRootPath(userId, connectionId)
    ]);
    if (!row || row.ownerId === userId) return null;
    const { owner, ...rest } = row;
    return {
        ...annotateRekey(rest, keyFingerprint(loadEnv().POLARIS_MASTER_KEY)),
        // Where it opens: the folder they were given, not the storage's root.
        rootPath: rootPath ?? "",
        // A personal drive is called "My files" by its owner; to anybody else it
        // is that person's, and saying "My files" would be a lie on their screen.
        // An organization's Drive belongs to no account, and already carries the
        // organization's name, so it keeps it.
        name: isPersonalKind(row.kind) && owner ? `${owner.name}'s files` : row.name,
        shared: true
    };
}

/**
 * A single deployed local container the user owns, surfaced as a read-only Drive
 * source. Not part of the connections list (a running service is browsed on
 * demand from Deploy's "View in Drive", not shown as a saved connection), so this
 * resolves just the one the browser asked for. Returns null when the app is not a
 * local, currently-deployed app the user owns.
 */
export async function getContainerConnection(userId: string, appId: string) {
    const app = await prisma.application.findFirst({
        where: {
            id: appId,
            currentDeploymentId: { not: null },
            target: { kind: "local" },
            environment: { project: { ownerId: userId } }
        },
        select: { id: true, name: true, createdAt: true }
    });
    if (!app) return null;
    return {
        id: `${CONTAINER_CONNECTION_PREFIX}${app.id}`,
        name: `${app.name} (container)`,
        kind: "local",
        status: "connected",
        requiresHostd: true,
        config: JSON.stringify({ kind: "local", root: "/" }),
        createdAt: app.createdAt,
        shared: false,
        needsRekey: false
    };
}

/**
 * The device's own local web console URL, when the connection points at one that
 * serves a UI (a UniFi UNAS console). Used to offer a "open the device dashboard"
 * shortcut next to the cloud (unifi.ui.com) option. Best-effort: returns
 * undefined for kinds without a console or when the host is not parseable.
 */
export function connectionWebUrl(kind: string, configJson: string): string | undefined {
    if (kind !== "unifi-unas") return undefined;
    try {
        const config = JSON.parse(configJson) as { host?: string; port?: number; secure?: boolean };
        if (!config.host) return undefined;
        const scheme = config.secure === false ? "http" : "https";
        const port =
            config.port && config.port !== 443 && config.port !== 80 ? `:${config.port}` : "";
        return `${scheme}://${config.host}${port}`;
    } catch {
        return undefined;
    }
}

/** Persist a new connection, encrypting its credentials at rest. */
export async function createConnection(
    ownerId: string,
    name: string,
    kind: StorageProviderKind,
    config: StorageConfig,
    credentials: StorageCredentials
) {
    const env = loadEnv();
    const hasSecret = Object.keys(credentials).some((key) => key !== "kind");
    const blob = hasSecret ? encryptCredentials(credentials, env.POLARIS_MASTER_KEY) : null;
    return prisma.storageConnection.create({
        data: {
            ownerId,
            name,
            kind,
            config: JSON.stringify(config),
            requiresHostd: requiresHostd(kind),
            encryptedCredential: blob?.ciphertext ?? null,
            credentialNonce: blob?.nonce ?? null,
            credentialKeyId: blob?.keyId ?? null
        },
        select: { id: true }
    });
}

/**
 * Update an existing connection's name and non-secret config, and optionally its
 * credentials. Scoped to the owner. Credentials are only re-encrypted when new
 * secret material is supplied; a blank credentials payload keeps the stored one,
 * so editing a host or port never forces the user to re-enter a password. The
 * provider kind cannot change - that would be a different connection entirely.
 */
export async function updateConnection(
    ownerId: string,
    connectionId: string,
    input: { name: string; config: StorageConfig; credentials?: StorageCredentials }
) {
    const row = await loadConnection(connectionId, ownerId);
    // A personal drive has no form and must not acquire one. Its config says
    // which storage somebody's files are on and which folder they are in, so
    // editing it would repoint a drive at somebody else's data and strand the
    // files that are already in it.
    if (isPersonalKind(row.kind) || isPersonalKind(input.config.kind)) {
        throw new Error("Your own drive cannot be edited");
    }
    if (row.kind !== input.config.kind) throw new Error("Cannot change the connection type");
    const env = loadEnv();
    const hasSecret = input.credentials
        ? Object.keys(input.credentials).some((key) => key !== "kind")
        : false;
    const blob = hasSecret
        ? encryptCredentials(input.credentials as StorageCredentials, env.POLARIS_MASTER_KEY)
        : null;
    await prisma.storageConnection.update({
        where: { id: connectionId },
        data: {
            name: input.name,
            config: JSON.stringify(input.config),
            ...(blob
                ? {
                      encryptedCredential: blob.ciphertext,
                      credentialNonce: blob.nonce,
                      credentialKeyId: blob.keyId
                  }
                : {})
        }
    });
    // Sessions outlive a request, so an edited address, share or credential would
    // otherwise keep being browsed through the session opened with the old one.
    forgetConnection(connectionId);
}

/** Delete a connection owned by the user, and drop its metrics history. */
export async function deleteConnection(ownerId: string, connectionId: string) {
    // Never a personal drive. Removing one would drop every share, note, star
    // and bin entry pointing into somebody's files and leave the files behind
    // with nothing that knows where they are. A drive goes when its account does.
    await prisma.storageConnection.deleteMany({
        where: { id: connectionId, ownerId, kind: { not: PERSONAL_KIND } }
    });
    await deleteMetricsForSubject("storage", connectionId);
    forgetConnection(connectionId);
}

/** Discover the SMB shares a UNAS exposes, reusing its stored UniFi account. */
export async function discoverUnasShares(ownerId: string, connectionId: string): Promise<string[]> {
    const row = await loadConnection(connectionId, ownerId);
    if (row.kind !== "unifi-unas") throw new Error("Not a UniFi UNAS connection");
    const env = loadEnv();
    const config = JSON.parse(row.config) as Extract<StorageConfig, { kind: "unifi-unas" }>;
    const creds =
        row.encryptedCredential && row.credentialNonce
            ? decryptCredentials<{ password?: string }>(
                  {
                      ciphertext: Buffer.from(row.encryptedCredential),
                      nonce: Buffer.from(row.credentialNonce),
                      keyId: row.credentialKeyId ?? ""
                  },
                  env.POLARIS_MASTER_KEY
              )
            : {};
    return listSmbShares(config.host, config.username, creds.password ?? "");
}

/** Set the SMB share used to browse a UniFi UNAS connection's files. */
export async function setUnasSmbShare(
    ownerId: string,
    connectionId: string,
    share: string
): Promise<void> {
    const row = await loadConnection(connectionId, ownerId);
    if (row.kind !== "unifi-unas") throw new Error("Not a UniFi UNAS connection");
    const config = JSON.parse(row.config) as Record<string, unknown>;
    config.smbShare = share.trim();
    await prisma.storageConnection.update({
        where: { id: connectionId },
        data: { config: JSON.stringify(config) }
    });
    // The share is half of what an SMB session is bound to (the other half is the
    // account), so a session opened against the previous one is no longer the answer.
    forgetConnection(connectionId);
}
