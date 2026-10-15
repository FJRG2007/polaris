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
import { serviceRef } from "@/lib/deploy/releases";
import { shortHash, type ComposeSpec } from "@polaris/deploy";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { reachableAddresses } from "@/lib/deployment-addresses";
import { passwordIsBreached } from "@/lib/pwned-passwords";

/** Raised for a refusal whose words are meant for the screen. */
export class FileAccessError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "FileAccessError";
    }
}

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
    readonly slug: string;
    readonly projectSlug: string;
    readonly target: TargetRow & { readonly host: { readonly address: string } | null };
    readonly volumes: { readonly name: string; readonly kind: string; readonly source: string | null; readonly connectionId: string | null }[];
}

async function serviceOf(applicationId: string, ownerId: string): Promise<ServiceRow> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            id: true,
            slug: true,
            environment: { select: { project: { select: { slug: true } } } },
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
    if (!app) throw new FileAccessError("That service is not there any more.");
    return {
        id: app.id,
        slug: app.slug,
        projectSlug: app.environment.project.slug,
        target: app.target,
        volumes: app.volumes
    };
}

/** The volumes as compose mounts under `/srv`, each at its folder name. */
export function fileAccessMounts(service: Pick<ServiceRow, "id" | "slug" | "projectSlug" | "volumes">) {
    const project = serviceRef(service.projectSlug, service.slug, service.id).project;
    const folders = core.fileAccessFolders(service.volumes.map((volume) => volume.name));
    const mounts = service.volumes.map((volume, index) => {
        const kind = volume.kind === "bind" ? "bind" : volume.kind === "nas" ? "nas" : "volume";
        const stored = volume.source ?? volume.name;
        const source =
            kind === "volume"
                ? `${project}_${stored}`
                : kind === "nas" && volume.connectionId
                  ? `${volume.connectionId}/${stored}`
                  : stored;
        return { source, target: `${core.FILE_ACCESS_ROOT}/${folders[index]}`, kind } as const;
    });
    return { folders, mounts };
}

/**
 * The server's compose project. Pure, so what it mounts and runs can be read in
 * a test: the service's volumes by their exact names, declared external so this
 * project never owns or removes them, and one volume of its own for host keys.
 */
export function fileAccessSpec(input: {
    readonly service: Pick<ServiceRow, "id" | "slug" | "projectSlug" | "volumes">;
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
                volumes: [...mounts, { source: "keys", target: "/etc/ssh/polaris-keys", kind: "volume" }],
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

function openPassword(row: { passwordCipher: Uint8Array | null; passwordNonce: Uint8Array | null; passwordKeyId: string | null }): string | undefined {
    if (!row.passwordCipher || !row.passwordNonce) return undefined;
    return decryptSecret(
        {
            ciphertext: Buffer.from(row.passwordCipher),
            nonce: Buffer.from(row.passwordNonce),
            keyId: row.passwordKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** An address the server is reached at: the remote server's, or this one's. */
async function hostFor(service: ServiceRow): Promise<string | null> {
    if (service.target.host) return service.target.host.address;
    const addresses = await reachableAddresses().catch(() => []);
    const pick = addresses.find((entry) => entry.kind === "local") ?? addresses.find((entry) => entry.kind === "domain");
    return pick ? pick.host.replace(/:\d+$/, "") : null;
}

export async function fileAccessView(applicationId: string, ownerId: string): Promise<FileAccessView> {
    const service = await serviceOf(applicationId, ownerId);
    const [accounts, server] = await Promise.all([
        prisma.fileAccessAccount.findMany({
            where: { applicationId },
            orderBy: { createdAt: "asc" },
            select: { id: true, username: true, readOnly: true, passwordCipher: true, publicKey: true, createdAt: true }
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
    for (let tries = 0; tries < span && taken.has(port); tries++) port = core.nextFileAccessPort(port);
    if (taken.has(port)) throw new FileAccessError("Every SFTP port on this server is in use.");
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

/**
 * Bring the server in line with the accounts: down and forgotten when there
 * are none, started with the full list when there are. A start that fails is
 * recorded on the server row and reported, and the accounts stay as saved.
 */
export async function syncFileAccess(applicationId: string, ownerId: string): Promise<void> {
    const service = await serviceOf(applicationId, ownerId);
    const accounts = await prisma.fileAccessAccount.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
    const project = core.fileAccessProject(shortHash(service.id, 8));
    const ports = await getPorts(service.target, ownerId);
    try {
        if (accounts.length === 0) {
            await ports.composeDown(project);
            await prisma.fileAccessServer.deleteMany({ where: { applicationId } });
            return;
        }
        if (service.volumes.length === 0)
            throw new FileAccessError("This service has no volumes, so there are no files to reach. Add a volume first.");
        const existing = await prisma.fileAccessServer.findUnique({ where: { applicationId } });
        const port = existing?.port ?? (await portFor(service));
        if (!existing) {
            await prisma.fileAccessServer.create({ data: { applicationId, targetId: service.target.id, port } });
        }
        const spec = fileAccessSpec({
            service,
            port,
            logins: accounts.map((account) => ({
                username: account.username,
                readOnly: account.readOnly,
                password: openPassword(account),
                publicKey: account.publicKey ?? undefined
            }))
        });
        try {
            await ports.composeUp(spec);
        } catch (error) {
            console.error("polaris: the SFTP server did not start:", error);
            const said = `The SFTP server did not start. Check that nothing else on this server uses port ${port}.`;
            await prisma.fileAccessServer.update({ where: { applicationId }, data: { lastError: said } });
            throw new FileAccessError(said);
        }
        await prisma.fileAccessServer.update({
            where: { applicationId },
            data: { lastError: null, startedAt: new Date() }
        });
    } finally {
        await ports.dispose().catch(() => undefined);
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
        if (service.volumes.length === 0)
            throw new FileAccessError("This service has no volumes, so there are no files to reach. Add a volume first.");
        const clash = await prisma.fileAccessAccount.findUnique({
            where: { applicationId_username: { applicationId, username: input.username } }
        });
        if (clash) throw new FileAccessError("This service already has an account with that name.");
        if (input.password && (await passwordIsBreached(input.password).catch(() => false)))
            throw new FileAccessError("That password appears in known data breaches. Pick another.");
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
            const others = await prisma.fileAccessAccount.count({ where: { applicationId, id: { not: created.id } } });
            if (others === 0) {
                await prisma.fileAccessAccount.delete({ where: { id: created.id } }).catch(() => undefined);
                await syncFileAccess(applicationId, ownerId).catch(() => undefined);
            }
            throw error;
        }
    });
}

export async function deleteFileAccessAccount(applicationId: string, ownerId: string, accountId: string): Promise<void> {
    await oneAtATime(applicationId, async () => {
        const removed = await prisma.fileAccessAccount.deleteMany({ where: { id: accountId, applicationId } });
        if (removed.count === 0) throw new FileAccessError("That account is not there any more.");
        await syncFileAccess(applicationId, ownerId);
    });
}
