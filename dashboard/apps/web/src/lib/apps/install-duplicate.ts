/**
 * Duplicating an install: a second service built the way the first one is, with
 * storage of its own and the first one's files copied into it.
 *
 * Generic on purpose. Which settings an app has to change so the two do not
 * fight - a password both would answer to, an id a plugin reports itself under,
 * a port - is the app's own knowledge, so the caller hands over the finished
 * environment and config and this only builds what it was told to. What is the
 * dashboard's is here: the service, its volumes, its crons, who may reach it,
 * which backup plan protects it, and moving the bytes.
 *
 * **The source's storage is never shared and never written.** The copy gets new
 * volumes - named after its own project, so its first deploy finds them already
 * filled - and the data is copied by a one-off container that mounts both sides,
 * run from the source's own image (present on the machine by definition, so a
 * machine with no network can still do this). Only the copy's mounts are ever
 * emptied, and only before the copy, so a retry starts clean.
 *
 * **The source has to be stopped**: a game writing its world while the files are
 * copied produces a world neither of them ever had. Stopping and starting it is
 * the caller's, because whether a stop needs a save first is the app's call too.
 */

import { prisma } from "@polaris/db";
import { revealEnvVar, setEnvVars } from "@/lib/env-var-service";
import { publishAccessChange } from "@/lib/access-live";
import { createVolume, volumeMountSource } from "@/lib/deploy-volume-service";
import { holdWhileCopying } from "@/lib/apps/install-copy-hold";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import type { ComposeSpec, ComposeSpecVolume } from "@polaris/deploy";
import { currentReleaseRef, serviceRef } from "@/lib/deploy/releases";
import { invalidateInstallPresence } from "@/lib/apps/install-presence";
import { createApplication, deleteApplication } from "@/lib/deploy-service";
import * as quotas from "@/lib/orgs/quotas";
import * as quota from "@/lib/orgs/quota-service";
import { slugify, parseContainerState, shortHash, type RuntimePorts } from "@polaris/deploy";

/** Why a copy could not be made, as a code the caller turns into its own words. */
export type InstallCopyRefusalCode =
    | "not-found"
    | "never-deployed"
    | "still-running"
    | "name-taken"
    | "no-space"
    | "copy-failed"
    | "timed-out"
    | "wrong-volume"
    | "not-mounted";

/**
 * A refusal the caller is meant to show. Matched by `name` and `code` rather than
 * by class: an installable app reaches this through the app host and never
 * imports the class itself.
 */
export class InstallCopyRefusal extends Error {
    override readonly name = "InstallCopyRefusal";
    constructor(
        readonly code: InstallCopyRefusalCode,
        readonly detail: { needBytes?: number; freeBytes?: number; said?: string } = {}
    ) {
        super(`install copy refused: ${code}`);
    }
}

/** What an app needs to read off the source to plan its copy. */
export interface InstallCopySource {
    readonly installedAppId: string;
    readonly name: string;
    readonly catalogId: string;
    readonly ownerId: string;
    /** The install's config as stored - a JSON object, unparsed. */
    readonly config: string;
    readonly applicationId: string;
    /** The machine it runs on, as the port registry and machine picker name it. */
    readonly targetId: string;
    /** Parsed `Application.sourceConfig`: the image, its port, its published ports. */
    readonly sourceConfig: Record<string, unknown>;
    /** Every variable, secrets decrypted - this is server side only. */
    readonly env: readonly { key: string; value: string; isSecret: boolean }[];
    /** Whether it has ever been deployed, which is whether it has files at all. */
    readonly deployed: boolean;
}

/** Read an install for copying. Owner-checked. */
export async function readInstallCopySource(
    ownerId: string,
    installedAppId: string
): Promise<InstallCopySource> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: {
            id: true,
            name: true,
            catalogId: true,
            ownerId: true,
            config: true,
            applicationId: true
        }
    });
    if (!install?.applicationId) throw new InstallCopyRefusal("not-found");
    const app = await prisma.application.findUnique({
        where: { id: install.applicationId },
        select: { id: true, targetId: true, sourceConfig: true, currentDeploymentId: true }
    });
    if (!app) throw new InstallCopyRefusal("not-found");
    const rows = await prisma.envVar.findMany({
        where: { scopeType: "application", scopeId: app.id },
        select: { id: true, key: true, value: true, isSecret: true },
        orderBy: { key: "asc" }
    });
    const env: { key: string; value: string; isSecret: boolean }[] = [];
    for (const row of rows) {
        const value = row.isSecret ? await revealEnvVar(row.id, ownerId) : row.value;
        // A secret that cannot be opened is dropped rather than copied empty: the
        // copy's own default (or a freshly minted one) is better than a blank.
        if (value !== null) env.push({ key: row.key, value, isSecret: row.isSecret });
    }
    return {
        installedAppId: install.id,
        name: install.name,
        catalogId: install.catalogId,
        ownerId: install.ownerId,
        config: install.config,
        applicationId: app.id,
        targetId: app.targetId,
        sourceConfig: parseObject(app.sourceConfig),
        env,
        deployed: app.currentDeploymentId !== null
    };
}

/** What the copy is made of, decided by the app that owns it. */
export interface InstallCopyInput {
    /** Chosen by the caller, so values that carry the id can be written first. */
    readonly installedAppId: string;
    readonly name: string;
    readonly env: readonly { key: string; value: string; isSecret: boolean }[];
    /** The published ports, replacing the source's. Container ports stay. */
    readonly ports: {
        readonly hostPort?: number;
        readonly hostProtocol?: "tcp" | "udp";
        readonly extraPorts?: readonly {
            host: number;
            container: number;
            protocol?: "tcp" | "udp";
        }[];
    };
    /** The new install's config, whole. */
    readonly config: Record<string, unknown>;
}

/**
 * Create the copy's records: service, variables, empty volumes, crons, install,
 * grants and backup protection. Nothing is deployed and no bytes move - the
 * install is left `installing` for the caller to fill and start.
 *
 * All or nothing: a failure part-way takes back what it had created, so a refused
 * copy never leaves a half-built server in the list.
 */
export async function createInstallCopy(
    ownerId: string,
    actorId: string,
    sourceInstalledAppId: string,
    input: InstallCopyInput
): Promise<{ installedAppId: string; applicationId: string }> {
    const install = await prisma.installedApp.findFirst({
        where: { id: sourceInstalledAppId, ownerId, status: { not: "removed" } },
        select: { id: true, catalogId: true, targetId: true, applicationId: true }
    });
    if (!install?.applicationId) throw new InstallCopyRefusal("not-found");
    const source = await prisma.application.findUnique({
        where: { id: install.applicationId },
        include: { volumes: true, crons: true }
    });
    if (!source) throw new InstallCopyRefusal("not-found");

    // The database holds a service's slug unique within its environment, so a name
    // that slugs to one already there is refused in words rather than numbered:
    // the person typed this name, and quietly changing it is not what they asked.
    const slug = slugify(input.name);
    const taken = await prisma.application.findFirst({
        where: { environmentId: source.environmentId, slug },
        select: { id: true }
    });
    if (!slug || taken) throw new InstallCopyRefusal("name-taken");

    // The copy reserves what its original does, so it is held to the
    // organization's caps before anything is made; the service count is checked
    // by `createApplication` itself.
    await quota.assertOrgReservation(
        () => quota.orgIdOfEnvironment(source.environmentId),
        { cpus: 0, memoryMb: 0 },
        {
            cpus: quotas.reservationOf(source.cpuLimit, source.replicas),
            memoryMb: quotas.reservationOf(source.memoryLimitMb, source.replicas)
        }
    );

    const sourceConfig = parseObject(source.sourceConfig);
    const application = await createApplication(ownerId, {
        environmentId: source.environmentId,
        targetId: source.targetId,
        name: input.name,
        sourceType: source.sourceType,
        sourceConfig: copiedSourceConfig(sourceConfig, input.ports),
        publishPort: source.publishPort,
        keepReleases: false,
        ...(source.buildConfig !== "{}" ? { buildConfig: parseObject(source.buildConfig) } : {})
    });

    try {
        await prisma.application.update({
            where: { id: application.id },
            data: {
                healthcheck: source.healthcheck,
                replicas: source.replicas,
                cpuLimit: source.cpuLimit,
                memoryLimitMb: source.memoryLimitMb,
                sleepAfterMinutes: source.sleepAfterMinutes,
                updateCheck: source.updateCheck,
                privateNetwork: source.privateNetwork,
                externalNetworks: source.externalNetworks,
                edgeConfig: source.edgeConfig,
                overlapVolumes: source.overlapVolumes
            }
        });
        if (input.env.length > 0)
            await setEnvVars("application", application.id, ownerId, [...input.env]);
        for (const volume of source.volumes) {
            const kind = volume.kind === "nas" ? "nas" : volume.kind === "bind" ? "bind" : "volume";
            await createVolume(ownerId, {
                applicationId: application.id,
                name: volume.name,
                mountPath: volume.mountPath,
                kind,
                // A bind or a share gets a folder of its own, generated from the
                // copy's name; the source's path would be the same files.
                ...(kind === "nas" && volume.connectionId
                    ? { connectionId: volume.connectionId }
                    : {}),
                ...(volume.sizeLimit ? { sizeLimit: volume.sizeLimit } : {})
            });
        }
        if (source.crons.length > 0) {
            await prisma.serviceCron.createMany({
                data: source.crons.map((cron) => ({
                    applicationId: application.id,
                    name: cron.name,
                    schedule: cron.schedule,
                    timezone: cron.timezone,
                    command: cron.command,
                    timeoutSeconds: cron.timeoutSeconds,
                    maxAttempts: cron.maxAttempts,
                    retryDelaySeconds: cron.retryDelaySeconds,
                    enabled: cron.enabled,
                    nextRunAt: cron.nextRunAt,
                    createdById: actorId
                }))
            });
        }
        await prisma.installedApp.create({
            data: {
                id: input.installedAppId,
                catalogId: install.catalogId,
                ownerId,
                name: input.name,
                targetId: install.targetId,
                applicationId: application.id,
                status: "installing",
                installedById: actorId,
                config: JSON.stringify(input.config)
            }
        });
        await copyGrants(install.id, input.installedAppId, actorId);
        await copyProtection(ownerId, install.id, input.installedAppId, input.name);
    } catch (error) {
        await discardCopy(ownerId, input.installedAppId, application.id);
        throw error;
    }

    invalidateInstallPresence(install.catalogId);
    publishAccessChange();
    return { installedAppId: input.installedAppId, applicationId: application.id };
}

/**
 * Take back a copy that was created but never filled - its records, grants,
 * backup protection and service - for a caller whose own part of making it
 * failed after `createInstallCopy` answered. Owner-checked; anything else is
 * left alone.
 */
export async function discardInstallCopy(ownerId: string, installedAppId: string): Promise<void> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { catalogId: true, applicationId: true }
    });
    if (!install) return;
    await discardCopy(ownerId, installedAppId, install.applicationId);
    invalidateInstallPresence(install.catalogId);
    publishAccessChange();
}

async function discardCopy(
    ownerId: string,
    installedAppId: string,
    applicationId: string | null
): Promise<void> {
    await prisma.installedApp.deleteMany({ where: { id: installedAppId } }).catch(() => undefined);
    await prisma.resourceGrant
        .deleteMany({ where: { resourceKind: "install", resourceId: installedAppId } })
        .catch(() => undefined);
    await prisma.protectedResource
        .deleteMany({ where: { ownerId, selector: { endsWith: `:${installedAppId}` } } })
        .catch(() => undefined);
    if (applicationId) await deleteApplication(applicationId, ownerId).catch(() => undefined);
}

/** The source's image and settings, published on the copy's own ports. */
export function copiedSourceConfig(
    source: Record<string, unknown>,
    ports: InstallCopyInput["ports"]
): Record<string, unknown> {
    const copied: Record<string, unknown> = { ...source };
    delete copied.hostPort;
    delete copied.hostProtocol;
    delete copied.extraPorts;
    if (ports.hostPort !== undefined) {
        copied.hostPort = ports.hostPort;
        copied.hostProtocol = ports.hostProtocol ?? (source.hostProtocol === "udp" ? "udp" : "tcp");
    }
    if (ports.extraPorts && ports.extraPorts.length > 0) copied.extraPorts = [...ports.extraPorts];
    return copied;
}

/** Who may reach the source in Polaris may reach the copy, on the same terms. */
async function copyGrants(fromId: string, toId: string, actorId: string): Promise<void> {
    const grants = await prisma.resourceGrant.findMany({
        where: { resourceKind: "install", resourceId: fromId },
        take: 500
    });
    if (grants.length === 0) return;
    await prisma.resourceGrant.createMany({
        data: grants.map((grant) => ({
            principalType: grant.principalType,
            principalId: grant.principalId,
            resourceKind: "install",
            resourceId: toId,
            actions: grant.actions,
            effect: grant.effect,
            canShare: grant.canShare,
            note: grant.note,
            grantedById: actorId,
            expiresAt: grant.expiresAt
        }))
    });
}

/**
 * A source that a backup plan protects puts the copy under the same plan: the
 * person who decided this server's files are worth keeping decided it for the
 * copy of them too. Its copies are the source's and stay there - the new one
 * starts with none, and is due on the plan's next turn.
 */
async function copyProtection(
    ownerId: string,
    fromId: string,
    toId: string,
    name: string
): Promise<void> {
    const rows = await prisma.protectedResource.findMany({
        where: { ownerId, selector: { endsWith: `:${fromId}` } },
        take: 20
    });
    for (const row of rows) {
        await prisma.protectedResource.create({
            data: {
                ownerId,
                kind: row.kind,
                selector: row.selector.split(fromId).join(toId),
                name,
                config: row.config.split(fromId).join(toId),
                encryptedCredential: row.encryptedCredential,
                credentialNonce: row.credentialNonce,
                credentialKeyId: row.credentialKeyId,
                planId: row.planId,
                status: row.status,
                nextDueAt: row.planId ? new Date() : null
            }
        });
    }
}

/** Bytes a volume holds and bytes free where its copy will go. */
export interface InstallDataFigures {
    readonly usedBytes: number;
    readonly freeBytes: number;
    /** Whether a copy of that much fits in that much room, by the same margin the
     *  copying container holds itself to. */
    readonly fits: boolean;
}

/** How long a measure stands, so opening the dialog and pressing Duplicate walk
 *  the world once rather than twice. */
const MEASURE_KEEP_MS = 2 * 60_000;
/** How long the walk may take inside a server that is being played on. */
const MEASURE_LIMIT_S = 30;

const measured = new Map<string, { at: number; figures: Promise<InstallDataFigures | null> }>();

/**
 * How much the install's files take, and how much room its machine has left -
 * asked through the running container, before anything is created, so a copy
 * that cannot fit is refused while nothing has happened yet. Null where it cannot
 * be asked (stopped, an image with no `du`, or a world too large to walk in the
 * time allowed); the copy itself checks again, and that check is the one that
 * holds.
 */
export async function measureInstallData(
    ownerId: string,
    installedAppId: string
): Promise<InstallDataFigures | null> {
    const key = `${ownerId}:${installedAppId}`;
    const now = Date.now();
    for (const [entry, kept] of measured)
        if (now - kept.at > MEASURE_KEEP_MS) measured.delete(entry);
    const kept = measured.get(key);
    if (kept) return kept.figures;
    const figures = measureNow(ownerId, installedAppId);
    measured.set(key, { at: now, figures });
    const settled = await figures;
    if (!settled) measured.delete(key);
    return settled;
}

async function measureNow(
    ownerId: string,
    installedAppId: string
): Promise<InstallDataFigures | null> {
    const app = await installApplication(ownerId, installedAppId).catch(() => null);
    if (!app?.currentDeploymentId || app.volumes.length === 0) return null;
    const ports = await getPorts(app.target as TargetRow, ownerId);
    try {
        const container = (await currentReleaseRef(app)).name;
        if (
            parseContainerState(await ports.inspect(container).catch(() => null)).status !==
            "running"
        )
            return null;
        let used = 0;
        let free = Number.POSITIVE_INFINITY;
        for (const volume of app.volumes) {
            const path = shellPath(volume.mountPath);
            const said = await ports.runIn(container, [
                "sh",
                "-c",
                `if command -v timeout >/dev/null 2>&1; then limit="timeout ${MEASURE_LIMIT_S}"; else limit=""; fi; u=$($limit du -sk ${path} | awk '{print $1}'); f=$(df -Pk ${path} | awk 'NR==2 {print $4}'); [ -n "$u" ] && [ -n "$f" ] && echo "$u $f"`
            ]);
            const [usedKb, freeKb] = said.output.trim().split(/\s+/).map(Number);
            if (said.code !== 0 || !Number.isFinite(usedKb) || !Number.isFinite(freeKb))
                return null;
            used += (usedKb ?? 0) * 1024;
            free = Math.min(free, (freeKb ?? 0) * 1024);
        }
        return { usedBytes: used, freeBytes: free, fits: copyFits(used, free) };
    } catch {
        return null;
    } finally {
        await ports.dispose();
    }
}

/** How far a copy has got. `totalBytes` is unknown until the copy has measured. */
export interface InstallCopyProgress {
    readonly copiedBytes: number;
    readonly totalBytes: number | null;
}

/** How long a copy may run. A world of hundreds of gigabytes on a slow share is
 *  hours; one that has not finished in a day has stopped. */
const COPY_LIMIT_MS = 24 * 60 * 60_000;
const POLL_MS = 3_000;

/** Where the two sides are mounted in the copying container. */
const FROM_ROOT = "/polaris-from";
const TO_ROOT = "/polaris-to";

/** What the copying container is told to keep free beyond the data: 256 MiB and
 *  a twentieth, so a world that grows while it is copied - it cannot, it is
 *  stopped, but a log can - does not fill the disk to the last byte. */
export function copyFits(needBytes: number, freeBytes: number): boolean {
    return needBytes + Math.ceil(needBytes / 20) + 256 * 1024 * 1024 <= freeBytes;
}

/**
 * The script the copying container runs, as one line (the host daemon refuses a
 * control character anywhere in a command). Per volume: empty the copy's side,
 * measure, refuse with the figures when it would not fit, copy preserving owners
 * and modes. Only `/polaris-to` is ever emptied.
 */
export function copyScript(count: number): string {
    const indexes = Array.from({ length: count }, (_, index) => String(index)).join(" ");
    return [
        "set -eu",
        `for i in ${indexes}; do find "${TO_ROOT}/$i" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; done`,
        `for i in ${indexes}; do need=$(du -sk "${FROM_ROOT}/$i" | awk '{print $1}'); free=$(df -Pk "${TO_ROOT}/$i" | awk 'NR==2 {print $4}'); echo "polaris-need $i $need $free"; if [ $((need + need / 20 + 262144)) -gt "$free" ]; then echo "polaris-no-space $need $free"; exit 3; fi; done`,
        `for i in ${indexes}; do cp -a "${FROM_ROOT}/$i/." "${TO_ROOT}/$i/"; done`,
        "sync",
        "echo polaris-copied"
    ].join("; ");
}

/** The figures a script line reported, in bytes. */
export function readCopyReport(said: string): {
    needBytes: number | null;
    noSpace: { needBytes: number; freeBytes: number } | null;
} {
    let need = 0;
    let seen = false;
    for (const match of said.matchAll(/polaris-need \d+ (\d+) (\d+)/g)) {
        need += Number(match[1]) * 1024;
        seen = true;
    }
    const refused = /polaris-no-space (\d+) (\d+)/.exec(said);
    return {
        needBytes: seen ? need : null,
        noSpace: refused
            ? { needBytes: Number(refused[1]) * 1024, freeBytes: Number(refused[2]) * 1024 }
            : null
    };
}

/**
 * Copy every volume of the source into the matching volume of the copy.
 *
 * The source must be stopped (refused otherwise) and must have been deployed. The
 * copy's named volumes are created here, by a project named exactly as the
 * copy's own deploy will be, so that deploy mounts the volume this filled rather
 * than a fresh empty one of the same name. `verifyInstallCopy` checks that after
 * the deploy, rather than trusting it.
 */
export async function copyInstallData(
    ownerId: string,
    sourceInstalledAppId: string,
    copyInstalledAppId: string,
    onProgress: (progress: InstallCopyProgress) => Promise<void> | void
): Promise<void> {
    const source = await installApplication(ownerId, sourceInstalledAppId);
    const copy = await installApplication(ownerId, copyInstalledAppId);
    if (!source.currentDeploymentId) throw new InstallCopyRefusal("never-deployed");
    if (source.targetId !== copy.targetId) throw new InstallCopyRefusal("copy-failed");
    await holdWhileCopying([source.id, copy.id], () =>
        copyVolumes(ownerId, source, copy, onProgress)
    );
}

/** The copy itself, with both services held so nothing starts either meanwhile. */
async function copyVolumes(
    ownerId: string,
    source: InstallApplication,
    copy: InstallApplication,
    onProgress: (progress: InstallCopyProgress) => Promise<void> | void
): Promise<void> {
    const ports = await getPorts(source.target as TargetRow, ownerId);
    try {
        const container = (await currentReleaseRef(source)).name;
        const inspect = await ports.inspect(container);
        if (parseContainerState(inspect).status === "running")
            throw new InstallCopyRefusal("still-running");
        const image = (inspect as { Config?: { Image?: unknown } } | null)?.Config?.Image;
        if (typeof image !== "string") throw new InstallCopyRefusal("never-deployed");

        const project = copyProject(copy);
        const pairs = source.volumes.map((volume) => {
            const into = copy.volumes.find((candidate) => candidate.mountPath === volume.mountPath);
            if (!into) throw new InstallCopyRefusal("copy-failed");
            return { from: mountedSource(volume, inspect), into };
        });
        if (pairs.length === 0) return;
        const spec = copySpec(
            project,
            `polaris-copy-${shortHash(copy.id, 8)}`,
            image,
            pairs,
            copyScript(pairs.length)
        );
        const task = spec.services[0]!.name;

        await ports.composeDown(spec.project).catch(() => undefined);
        try {
            await ports.composeUp(spec);
            await waitForCopy(ports, task, onProgress);
        } finally {
            await ports.composeDown(spec.project).catch(() => undefined);
        }
    } finally {
        await ports.dispose();
    }
}

/** Poll the copying container until it exits, reporting what has landed. */
async function waitForCopy(
    ports: RuntimePorts,
    task: string,
    onProgress: (progress: InstallCopyProgress) => Promise<void> | void
): Promise<void> {
    const deadline = Date.now() + COPY_LIMIT_MS;
    let total: number | null = null;
    for (;;) {
        const state = parseContainerState(await ports.inspect(task).catch(() => null));
        const said = await lastWords(ports, task);
        const report = readCopyReport(said);
        total ??= report.needBytes;
        if (state.status === "exited" || state.status === "dead") {
            if (report.noSpace) throw new InstallCopyRefusal("no-space", report.noSpace);
            if (state.exitCode === 0 && said.includes("polaris-copied")) {
                await onProgress({ copiedBytes: total ?? 0, totalBytes: total });
                return;
            }
            throw new InstallCopyRefusal("copy-failed", { said: said.slice(-600) });
        }
        if (Date.now() > deadline) throw new InstallCopyRefusal("timed-out");
        const landed = await ports.runIn(task, ["du", "-sk", TO_ROOT]).catch(() => null);
        const copiedKb = landed?.code === 0 ? Number(landed.output.trim().split(/\s+/)[0]) : NaN;
        if (Number.isFinite(copiedKb))
            await onProgress({ copiedBytes: copiedKb * 1024, totalBytes: total });
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** The last lines a container printed. */
async function lastWords(ports: RuntimePorts, container: string): Promise<string> {
    const parts: Buffer[] = [];
    await ports
        .logs(container, (chunk) => void parts.push(Buffer.from(chunk)), { tail: 40 })
        .catch(() => undefined);
    return Buffer.concat(parts).toString("utf8").trim();
}

type VolumeRow = {
    kind: string;
    name: string;
    source: string | null;
    mountPath: string;
    connectionId: string | null;
};

/** The compose project the copy's own deploy runs under, which names its volumes. */
function copyProject(app: {
    id: string;
    slug: string;
    environment: { project: { slug: string } };
}): string {
    return serviceRef(app.environment.project.slug, app.slug, app.id).project;
}

/** Where a source volume's data actually is, as a mount for another container. */
function mountedSource(volume: VolumeRow, inspect: unknown): ComposeSpecVolume {
    if (volume.kind === "nas") return { kind: "nas", source: nasSource(volume), target: "" };
    if (volume.kind === "bind")
        return { kind: "bind", source: volume.source ?? volume.name, target: "" };
    // Read off the container rather than derived: a service that changed over
    // between releases mounts its volume under the project that first made it.
    const name = volumeAt(inspect, volume.mountPath);
    if (!name) throw new InstallCopyRefusal("not-mounted");
    return { kind: "volume", source: name, target: "" };
}

function nasSource(volume: VolumeRow): string {
    return volumeMountSource(volume).source;
}

/** The volume mounted at `path` in an inspected container, by its Docker name. */
export function volumeAt(inspect: unknown, path: string): string | null {
    const mounts = (inspect as { Mounts?: unknown } | null)?.Mounts;
    if (!Array.isArray(mounts)) return null;
    for (const mount of mounts) {
        const entry = mount as { Type?: unknown; Name?: unknown; Destination?: unknown };
        if (entry.Type === "volume" && entry.Destination === path && typeof entry.Name === "string")
            return entry.Name;
    }
    return null;
}

/** The one-off container that copies: the source's image, both sides mounted. */
export function copySpec(
    project: string,
    name: string,
    image: string,
    pairs: readonly { from: ComposeSpecVolume; into: VolumeRow }[],
    script: string
): ComposeSpec {
    const owned: string[] = [];
    const external: string[] = [];
    const volumes: ComposeSpecVolume[] = [];
    pairs.forEach((pair, index) => {
        volumes.push({ ...pair.from, target: `${FROM_ROOT}/${index}` });
        if (pair.from.kind === "volume") external.push(pair.from.source);
        const kind =
            pair.into.kind === "nas" ? "nas" : pair.into.kind === "bind" ? "bind" : "volume";
        const source = kind === "nas" ? nasSource(pair.into) : (pair.into.source ?? pair.into.name);
        if (kind === "volume") owned.push(source);
        volumes.push({ kind, source, target: `${TO_ROOT}/${index}` });
    });
    return {
        project,
        services: [
            {
                name,
                image,
                entrypoint: ["/bin/sh", "-c"],
                command: [script],
                env: {},
                ports: [],
                volumes,
                labels: {},
                networks: [],
                restart: "no"
            }
        ],
        volumes: owned,
        networks: [],
        externalVolumes: external
    };
}

/**
 * Whether the copy's running container mounts the volumes this filled. A deploy
 * that named them differently would come up on an empty volume of its own and
 * look like a fresh server, which is the one outcome worse than a failure.
 */
export async function verifyInstallCopy(
    ownerId: string,
    copyInstalledAppId: string
): Promise<void> {
    const copy = await installApplication(ownerId, copyInstalledAppId);
    if (!copy.currentDeploymentId) throw new InstallCopyRefusal("copy-failed");
    const ports = await getPorts(copy.target as TargetRow, ownerId);
    try {
        const inspect = await ports.inspect((await currentReleaseRef(copy)).name);
        const project = copyProject(copy);
        for (const volume of copy.volumes) {
            if (volume.kind !== "volume") continue;
            const expected = `${project}_${volume.source ?? volume.name}`;
            if (volumeAt(inspect, volume.mountPath) !== expected)
                throw new InstallCopyRefusal("wrong-volume");
        }
    } finally {
        await ports.dispose();
    }
}

type InstallApplication = Awaited<ReturnType<typeof installApplication>>;

/** An install's service, with what reaching its container takes. Owner-checked. */
async function installApplication(ownerId: string, installedAppId: string) {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true }
    });
    if (!install?.applicationId) throw new InstallCopyRefusal("not-found");
    const app = await prisma.application.findUnique({
        where: { id: install.applicationId },
        include: { environment: { include: { project: true } }, target: true, volumes: true }
    });
    if (!app) throw new InstallCopyRefusal("not-found");
    return app;
}

/** A path for a shell line. Mount paths are validated absolute paths already;
 *  this only quotes them. */
function shellPath(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
}

function parseObject(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}
