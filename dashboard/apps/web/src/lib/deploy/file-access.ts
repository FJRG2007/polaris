/**
 * SFTP accounts for one deployed service, and the server that answers them.
 *
 * The server is a small container of the service's own (`polaris-sftp-<hash>`)
 * that mounts the service's volumes under `/srv` and nothing else. It is
 * started when the first account is added and taken down when the last one is
 * removed: a service with no accounts costs nothing, and the image is pulled
 * only the first time somebody asks for one.
 *
 * Every change to the accounts starts the server again with the full list,
 * which is how an account removed is an account that can no longer sign in -
 * there is no state inside the container worth keeping besides its host keys,
 * which live on a volume of its own.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { sha512Crypt } from "@/lib/deploy/sha512-crypt";
import { shortHash, type ComposeSpec } from "@polaris/deploy";
import { appVolumeName } from "@/lib/deploy/host-resources";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { reachableAddresses } from "@/lib/deployment-addresses";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { isReservedBindSource, volumeMountSource } from "@/lib/deploy-volume-service";

/**
 * Raised for a refusal meant for the screen. The message is a key of the
 * `deployServer` catalog, translated by the action.
 */
export class FileAccessError extends Error {
    public constructor(
        message: string,
        public readonly params?: core.MessageParams
    ) {
        super(message);
        this.name = "FileAccessError";
    }
}

/** What `lastError` holds when the server did not start: a key, read with the port. */
export const FILE_ACCESS_START_FAILED = "fileAccess.startFailed";

/** Refusals that leave no server serving the accounts. */
const UNSERVABLE = new Set(["fileAccess.noVolumes", "fileAccess.reservedFolder"]);

export interface FileAccessAccountView {
    readonly id: string;
    readonly username: string;
    readonly readOnly: boolean;
    readonly hasPassword: boolean;
    readonly hasKey: boolean;
    readonly createdAt: string;
}

export interface FileAccessView {
    readonly accounts: FileAccessAccountView[];
    /** The volumes an account sees, as the folders it sees them under. */
    readonly folders: string[];
    /** Null while no server runs. */
    readonly server: {
        readonly host: string | null;
        readonly port: number;
        readonly lastError: string | null;
        readonly startedAt: string | null;
    } | null;
}

interface ServiceRow {
    readonly id: string;
    readonly target: TargetRow & { readonly host: { readonly address: string } | null };
    readonly volumes: {
        readonly name: string;
        readonly kind: string;
        readonly source: string | null;
        readonly connectionId: string | null;
    }[];
}

async function serviceOf(applicationId: string, ownerId: string): Promise<ServiceRow> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            id: true,
            target: {
                select: {
                    id: true,
                    kind: true,
                    hostId: true,
                    runtime: true,
                    proxyNetwork: true,
                    host: { select: { address: true } }
                }
            },
            volumes: {
                select: { name: true, kind: true, source: true, connectionId: true },
                orderBy: { createdAt: "asc" }
            }
        }
    });
    if (!app) throw new FileAccessError("fileAccess.serviceGone");
    return {
        id: app.id,
        target: app.target,
        volumes: app.volumes
    };
}

/** The volumes as compose mounts under `/srv`, each at its folder name. */
export function fileAccessMounts(service: Pick<ServiceRow, "id" | "volumes">) {
    const folders = core.fileAccessFolders(service.volumes.map((volume) => volume.name));
    const mounts = service.volumes.map((volume, index) => {
        const { kind, source } = volumeMountSource(volume);
        return {
            source: kind === "volume" ? appVolumeName(service.id, source) : source,
            target: `${core.FILE_ACCESS_ROOT}/${folders[index]}`,
            kind
        } as const;
    });
    return { folders, mounts };
}

/** Why the service's volumes cannot be served, as a `FileAccessError` key, or null. */
function unservable(service: Pick<ServiceRow, "volumes">): string | null {
    if (service.volumes.length === 0) return "fileAccess.noVolumes";
    const reserved = service.volumes.some(
        (volume) => volume.kind === "bind" && isReservedBindSource(volume.source ?? volume.name)
    );
    return reserved ? "fileAccess.reservedFolder" : null;
}

/**
 * The server's compose project. Pure, so what it mounts and runs can be read in
 * a test: the service's volumes by their exact names, declared external so this
 * project never owns or removes them, and one volume of its own for host keys.
 */
export function fileAccessSpec(input: {
    readonly service: Pick<ServiceRow, "id" | "volumes">;
    readonly port: number;
    readonly logins: readonly core.FileAccessLogin[];
}): ComposeSpec {
    const { folders, mounts } = fileAccessMounts(input.service);
    const named = mounts.filter((mount) => mount.kind === "volume").map((mount) => mount.source);
    return {
        project: core.fileAccessProject(shortHash(input.service.id, 8)),
        services: [
            {
                name: "sftp",
                image: core.FILE_ACCESS_IMAGE,
                pullPolicy: "missing",
                env: {
                    POLARIS_SFTP_ACCOUNTS: core.fileAccessAccountsEnv(input.logins),
                    POLARIS_FIRST_FOLDER: folders[0] ?? ""
                },
                ports: [{ host: input.port, container: 22, protocol: "tcp" }],
                volumes: [
                    ...mounts,
                    { source: "keys", target: "/etc/ssh/polaris-keys", kind: "volume" }
                ],
                labels: { "polaris.role": "file-access", "polaris.application": input.service.id },
                entrypoint: ["/bin/sh", "-c", core.FILE_ACCESS_BOOT_SCRIPT],
                networks: [],
                restart: "unless-stopped"
            }
        ],
        volumes: ["keys"],
        networks: [],
        ...(named.length > 0 ? { externalVolumes: named } : {})
    };
}

function sealPassword(password: string) {
    return encryptSecret(password, loadEnv().POLARIS_MASTER_KEY);
}

/** The sealed password, opened only to be hashed for the server's `/etc/shadow`. */
function passwordHash(row: {
    passwordCipher: Uint8Array | null;
    passwordNonce: Uint8Array | null;
    passwordKeyId: string | null;
}): string | undefined {
    if (!row.passwordCipher || !row.passwordNonce) return undefined;
    const password = decryptSecret(
        {
            ciphertext: Buffer.from(row.passwordCipher),
            nonce: Buffer.from(row.passwordNonce),
            keyId: row.passwordKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return sha512Crypt(password);
}

/** An address the server is reached at: the remote server's, or this one's. */
async function hostFor(service: ServiceRow): Promise<string | null> {
    if (service.target.host) return service.target.host.address;
    const addresses = await reachableAddresses().catch(() => []);
    const pick =
        addresses.find((entry) => entry.kind === "local") ??
        addresses.find((entry) => entry.kind === "domain");
    return pick ? pick.host.replace(/:\d+$/, "") : null;
}

export async function fileAccessView(
    applicationId: string,
    ownerId: string
): Promise<FileAccessView> {
    const service = await serviceOf(applicationId, ownerId);
    const [accounts, server] = await Promise.all([
        prisma.fileAccessAccount.findMany({
            where: { applicationId },
            orderBy: { createdAt: "asc" },
            select: {
                id: true,
                username: true,
                readOnly: true,
                passwordCipher: true,
                publicKey: true,
                createdAt: true
            }
        }),
        prisma.fileAccessServer.findUnique({ where: { applicationId } })
    ]);
    return {
        accounts: accounts.map((account) => ({
            id: account.id,
            username: account.username,
            readOnly: account.readOnly,
            hasPassword: account.passwordCipher !== null,
            hasKey: account.publicKey !== null,
            createdAt: account.createdAt.toISOString()
        })),
        folders: core.fileAccessFolders(service.volumes.map((volume) => volume.name)),
        server: server
            ? {
                  host: await hostFor(service),
                  port: server.port,
                  lastError: server.lastError,
                  startedAt: server.startedAt?.toISOString() ?? null
              }
            : null
    };
}

/** A free port on the service's server, stable for the service when it can be. */
async function portFor(service: ServiceRow): Promise<number> {
    const taken = new Set(
        (
            await prisma.fileAccessServer.findMany({
                where: { targetId: service.target.id, applicationId: { not: service.id } },
                select: { port: true }
            })
        ).map((row) => row.port)
    );
    let port = core.fileAccessPortFor(parseInt(shortHash(service.id, 4), 16));
    const span = core.FILE_ACCESS_PORTS.to - core.FILE_ACCESS_PORTS.from + 1;
    for (let tries = 0; tries < span && taken.has(port); tries++)
        port = core.nextFileAccessPort(port);
    if (taken.has(port)) throw new FileAccessError("fileAccess.portsFull");
    return port;
}

/** Changes per service, one at a time: two starts at once would race on the port. */
const changes = new Map<string, Promise<void>>();

function oneAtATime(applicationId: string, work: () => Promise<void>): Promise<void> {
    const turn = (changes.get(applicationId) ?? Promise.resolve()).then(work);
    const settled = turn.catch(() => undefined);
    changes.set(applicationId, settled);
    void settled.then(() => {
        if (changes.get(applicationId) === settled) changes.delete(applicationId);
    });
    return turn;
}

/** Take a service's server down on one target. */
async function composeDownOn(
    target: TargetRow,
    applicationId: string,
    ownerId: string
): Promise<void> {
    const ports = await getPorts(target, ownerId);
    try {
        await ports.composeDown(core.fileAccessProject(shortHash(applicationId, 8)));
    } finally {
        await ports.dispose().catch(() => undefined);
    }
}

/**
 * Bring the server in line with the accounts: down and forgotten when there
 * are none, started with the full list when there are. A start that fails is
 * recorded on the server row and reported, and the accounts stay as saved.
 *
 * `without` is an account about to be removed: the server is started without
 * it first, so its row goes only once it can no longer sign in.
 */
export async function syncFileAccess(
    applicationId: string,
    ownerId: string,
    without?: string
): Promise<void> {
    const service = await serviceOf(applicationId, ownerId);
    const accounts = await prisma.fileAccessAccount.findMany({
        where: { applicationId, ...(without ? { id: { not: without } } : {}) },
        orderBy: { createdAt: "asc" }
    });
    let existing = await prisma.fileAccessServer.findUnique({ where: { applicationId } });
    // The service moved to another server: the old one is taken down there, and
    // a port is found again on the new one.
    if (existing && existing.targetId !== service.target.id) {
        const previous = await prisma.deployTarget.findUnique({
            where: { id: existing.targetId },
            select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
        });
        if (previous) {
            await composeDownOn(previous, applicationId, ownerId).catch((error) =>
                console.error(
                    `polaris: the SFTP server of service ${applicationId} was not taken down on its old server:`,
                    error
                )
            );
        }
        await prisma.fileAccessServer.deleteMany({ where: { applicationId } });
        existing = null;
    }
    const project = core.fileAccessProject(shortHash(service.id, 8));
    const ports = await getPorts(service.target, ownerId);
    try {
        if (accounts.length === 0) {
            await ports.composeDown(project);
            await prisma.fileAccessServer.deleteMany({ where: { applicationId } });
            return;
        }
        // With nothing it may serve, it stops serving what it mounted before.
        const refusal = unservable(service);
        if (refusal) {
            if (existing) {
                await ports.composeDown(project);
                await prisma.fileAccessServer.update({
                    where: { applicationId },
                    data: { lastError: refusal, startedAt: null }
                });
            }
            throw new FileAccessError(refusal);
        }
        const port = existing?.port ?? (await portFor(service));
        if (!existing) {
            await prisma.fileAccessServer.create({
                data: { applicationId, targetId: service.target.id, port }
            });
        }
        const spec = fileAccessSpec({
            service,
            port,
            logins: accounts.map((account) => ({
                username: account.username,
                readOnly: account.readOnly,
                passwordHash: passwordHash(account),
                publicKey: account.publicKey ?? undefined
            }))
        });
        try {
            await ports.composeUp(spec);
        } catch (error) {
            console.error("polaris: the SFTP server did not start:", error);
            await prisma.fileAccessServer.update({
                where: { applicationId },
                data: { lastError: FILE_ACCESS_START_FAILED }
            });
            throw new FileAccessError(FILE_ACCESS_START_FAILED, { port });
        }
        await prisma.fileAccessServer.update({
            where: { applicationId },
            data: { lastError: null, startedAt: new Date() }
        });
    } finally {
        await ports.dispose().catch(() => undefined);
    }
}

/**
 * Start the server again on what the service is now - its volumes, its server -
 * after one of them changed. Only a server that runs is touched, and never in
 * the way of the change: a start that fails is logged and recorded on its row.
 */
export async function refreshFileAccess(applicationId: string, ownerId: string): Promise<void> {
    try {
        const running = await prisma.fileAccessServer.findUnique({
            where: { applicationId },
            select: { applicationId: true }
        });
        if (running) await oneAtATime(applicationId, () => syncFileAccess(applicationId, ownerId));
    } catch (error) {
        console.error(
            `polaris: the SFTP server of service ${applicationId} was not started again:`,
            error
        );
    }
}

/**
 * Take the server down for a service that is being deleted. Its rows cascade
 * with the service, but its container does not, and with the rows gone nothing
 * would ever take it down. Best-effort: a server that does not answer is
 * logged and never holds up the delete.
 */
export async function takeDownFileAccess(applicationId: string, ownerId: string): Promise<void> {
    const running = await prisma.fileAccessServer.findUnique({
        where: { applicationId },
        select: { applicationId: true }
    });
    if (!running) return;
    try {
        await oneAtATime(applicationId, async () => {
            const service = await serviceOf(applicationId, ownerId);
            await composeDownOn(service.target, service.id, ownerId);
            await prisma.fileAccessServer.deleteMany({ where: { applicationId } });
        });
    } catch (error) {
        console.error(
            `polaris: the SFTP server of service ${applicationId} was not taken down:`,
            error
        );
    }
}

export async function createFileAccessAccount(
    applicationId: string,
    ownerId: string,
    actorId: string,
    input: core.FileAccessAccount
): Promise<void> {
    await oneAtATime(applicationId, async () => {
        const service = await serviceOf(applicationId, ownerId);
        const refusal = unservable(service);
        if (refusal) throw new FileAccessError(refusal);
        const clash = await prisma.fileAccessAccount.findUnique({
            where: { applicationId_username: { applicationId, username: input.username } }
        });
        if (clash) throw new FileAccessError("fileAccess.nameTaken");
        if (input.password && (await passwordIsBreached(input.password).catch(() => false)))
            throw new FileAccessError("fileAccess.breached");
        const sealed = input.password ? sealPassword(input.password) : null;
        const created = await prisma.fileAccessAccount.create({
            data: {
                applicationId,
                username: input.username,
                readOnly: input.readOnly,
                passwordCipher: sealed?.ciphertext ?? null,
                passwordNonce: sealed?.nonce ?? null,
                passwordKeyId: sealed?.keyId ?? null,
                publicKey: input.publicKey ?? null,
                createdById: actorId
            }
        });
        try {
            await syncFileAccess(applicationId, ownerId);
        } catch (error) {
            // The first account of a server that never started is not kept: it
            // would read as access that does not exist.
            const others = await prisma.fileAccessAccount.count({
                where: { applicationId, id: { not: created.id } }
            });
            if (others === 0) {
                await prisma.fileAccessAccount
                    .delete({ where: { id: created.id } })
                    .catch(() => undefined);
                await syncFileAccess(applicationId, ownerId).catch(() => undefined);
            }
            throw error;
        }
    });
}

/**
 * Remove an account. The server is started without it first and the row goes
 * after, so an account the server could not be told about stays listed - it
 * can still sign in - and can be removed again.
 */
export async function deleteFileAccessAccount(
    applicationId: string,
    ownerId: string,
    accountId: string
): Promise<void> {
    await oneAtATime(applicationId, async () => {
        const account = await prisma.fileAccessAccount.findFirst({
            where: { id: accountId, applicationId },
            select: { id: true }
        });
        if (!account) throw new FileAccessError("fileAccess.accountGone");
        try {
            await syncFileAccess(applicationId, ownerId, account.id);
        } catch (error) {
            if (!(error instanceof FileAccessError && UNSERVABLE.has(error.message))) throw error;
        }
        await prisma.fileAccessAccount.deleteMany({ where: { id: account.id, applicationId } });
    });
}
