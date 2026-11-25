/**
 * Syncing one environment into another (Railway's "Sync"): reading both sides
 * into the snapshots the pure diff in @polaris/core compares, and carrying out
 * the changes the reader picked.
 *
 * Callers authorize first and pass what the reader holds in each environment;
 * every item is checked against it again here, through the same
 * `selectSyncItems` the preview used, so the screen and the work agree.
 *
 * Applying recomputes the diff from what is stored now, so an item already
 * carried out - by an earlier run, or by hand - no longer appears and is not
 * done twice. Removing a service is never done here: it is parked in the
 * changeset as an ordinary service removal, which goes through the recycle bin
 * and leaves its volumes' data where it is.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { slugify } from "@polaris/deploy";
import * as quotas from "@/lib/orgs/quotas";
import { decryptedValue } from "./env-values";
import { redactSource } from "./redact-source";
import { encryptSecret } from "@polaris/storage";
import * as quota from "@/lib/orgs/quota-service";
import { generateValue, parseGenerator } from "./variable-generator";

/** Longest a setting is shown in the diff; the rest is in the service's own settings. */
const DISPLAY_LIMIT = 160;

type StoredVariable = Awaited<ReturnType<typeof prisma.envVar.findMany>>[number];

async function readEnvironment(environmentId: string, ownerId: string) {
    const environment = await prisma.environment.findFirst({
        where: { id: environmentId, project: { ownerId } },
        include: {
            project: { select: { id: true, slug: true } },
            applications: {
                where: { binnedAt: null },
                include: {
                    volumes: true,
                    variableGroupLinks: {
                        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                        include: { group: { select: { name: true } } }
                    }
                }
            }
        }
    });
    if (!environment) throw new Error("Environment not found");
    const variables = await prisma.envVar.findMany({
        where: {
            OR: [
                { scopeType: "environment", scopeId: environment.id },
                {
                    scopeType: "application",
                    scopeId: { in: environment.applications.map((one) => one.id) }
                }
            ]
        }
    });
    return { environment, variables };
}

type ReadEnvironment = Awaited<ReturnType<typeof readEnvironment>>;
type SyncedApplication = ReadEnvironment["environment"]["applications"][number];

/** A digest to compare by, so the diff never holds a value. A generated
 *  variable compares by its recipe: two draws of it are meant to differ. */
function fingerprint(row: StoredVariable): string {
    if (row.generator) return `generated:${row.generator}`;
    if (row.sealed) return "sealed";
    return createHash("sha256")
        .update(`${row.isSecret ? 1 : 0}:${decryptedValue(row) ?? ""}`)
        .digest("hex");
}

function variablesOf(rows: readonly StoredVariable[]): core.SyncVariable[] {
    return rows.map((row) => ({
        key: row.key,
        fingerprint: fingerprint(row),
        secret: row.isSecret || row.sealed
    }));
}

function canonical(raw: string | null): string | null {
    if (raw === null) return null;
    try {
        return JSON.stringify(sortKeys(JSON.parse(raw)));
    } catch {
        return raw;
    }
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, inner]) => [key, sortKeys(inner)])
    );
}

function clip(text: string | null): string | null {
    if (text === null || text === "") return null;
    return text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT - 3)}...` : text;
}

function field(value: string | null, display: string | null = value): core.SyncField {
    return { value, display: clip(display) };
}

/** A service's source as the diff shows it: the image, or the repository and
 *  branch, with any credential in a repository address taken out. */
function sourceDisplay(application: SyncedApplication): string {
    const source = redactSource(application.sourceConfig);
    const pick = (key: string) => (typeof source[key] === "string" ? (source[key] as string) : null);
    const where = pick("image") ?? pick("repoUrl") ?? pick("repository") ?? pick("repo");
    const branch = pick("branch");
    if (!where) return `${application.sourceType} ${JSON.stringify(sortKeys(source))}`;
    return `${application.sourceType} ${where}${branch ? ` @ ${branch}` : ""}`;
}

function settingsOf(application: SyncedApplication): Record<core.SyncSettingField, core.SyncField> {
    const onOff = (value: boolean) => field(value ? "on" : "off");
    const groups = application.variableGroupLinks;
    return {
        source: field(
            `${application.sourceType}\n${canonical(application.sourceConfig)}`,
            sourceDisplay(application)
        ),
        build: field(canonical(application.buildConfig)),
        healthcheck: field(canonical(application.healthcheck)),
        deployBranch: field(application.deployBranch),
        autoDeploy: onOff(application.autoDeploy),
        waitForCi: onOff(application.waitForCi),
        commitFilter: field(application.commitFilter),
        watchPaths: field(application.watchPaths),
        replicas: field(
            `${application.replicas}\n${canonical(application.autoscale) ?? ""}`,
            application.autoscale ? `${application.replicas} (autoscale)` : `${application.replicas}`
        ),
        resources: field(
            `${application.cpuLimit ?? ""}\n${application.memoryLimitMb ?? ""}\n${application.useGpu}`,
            `${application.cpuLimit ?? "-"} CPU, ${application.memoryLimitMb ?? "-"} MB${application.useGpu ? ", GPU" : ""}`
        ),
        restart: field(
            `${application.restartPolicy}\n${application.restartMaxRetries}`,
            `${application.restartPolicy} (${application.restartMaxRetries})`
        ),
        privateNetwork: field(canonical(application.privateNetwork)),
        variableGroups: field(
            groups.map((link) => link.groupId).join(",") || null,
            groups.map((link) => link.group.name).join(", ") || null
        )
    };
}

function snapshotOf(read: ReadEnvironment): core.SyncSnapshot {
    const { environment, variables } = read;
    return {
        networkMode: environment.networkMode,
        sharedVariables: variablesOf(
            variables.filter(
                (row) => row.scopeType === "environment" && row.scopeId === environment.id
            )
        ),
        services: environment.applications.map((application) => ({
            id: application.id,
            slug: application.slug,
            name: application.name,
            settings: settingsOf(application),
            variables: variablesOf(
                variables.filter(
                    (row) => row.scopeType === "application" && row.scopeId === application.id
                )
            ),
            volumes: application.volumes.map((volume) => ({
                name: volume.name,
                mountPath: volume.mountPath
            }))
        }))
    };
}

async function readBoth(sourceId: string, targetId: string, ownerId: string) {
    const [source, target] = await Promise.all([
        readEnvironment(sourceId, ownerId),
        readEnvironment(targetId, ownerId)
    ]);
    if (source.environment.projectId !== target.environment.projectId)
        throw new Error("Environment not found");
    return { source, target, diff: core.diffEnvironments(snapshotOf(source), snapshotOf(target)) };
}

export interface SyncPreview {
    readonly sourceName: string;
    readonly targetName: string;
    readonly diff: core.SyncDiff;
    /** Why each item the reader may not apply is refused, by item id. */
    readonly refusals: Readonly<Record<string, core.SyncRefusal>>;
}

/** What syncing would change, and which of it the reader may apply. */
export async function previewSync(
    sourceId: string,
    targetId: string,
    ownerId: string,
    reach: core.SyncReach
): Promise<SyncPreview> {
    const { source, target, diff } = await readBoth(sourceId, targetId, ownerId);
    const refusals: Record<string, core.SyncRefusal> = {};
    for (const item of diff.items) {
        const reason = core.syncRefusal(item, reach);
        if (reason) refusals[item.id] = reason;
    }
    return {
        sourceName: source.environment.name,
        targetName: target.environment.name,
        diff,
        refusals
    };
}

export interface SyncOutcome {
    applied: string[];
    refused: { id: string; reason: core.SyncRefusal }[];
    failures: { id: string; error: string }[];
    /** Services removed in the source, parked in the changeset for review. */
    stagedRemovals: string[];
    /** Ids of the receiving environment's services a deploy should restart. */
    affected: string[];
}

/** Write one variable from the source onto the target scope, ciphertext as it is. */
async function copyVariable(
    row: StoredVariable,
    to: { scopeType: "application" | "environment"; scopeId: string }
): Promise<void> {
    let data: {
        isSecret: boolean;
        sealed: boolean;
        generator: string | null;
        value: string | null;
        encryptedValue: Uint8Array<ArrayBuffer> | null;
        valueNonce: Uint8Array<ArrayBuffer> | null;
        valueKeyId: string | null;
    };
    const spec = row.generator ? parseGenerator(row.generator) : null;
    if (spec) {
        // A generated value is drawn again rather than copied, as a copied
        // environment does: a fresh random value is nobody's secret.
        const fresh = generateValue(spec);
        const secret = row.isSecret || row.sealed;
        const blob = secret ? encryptSecret(fresh, loadEnv().POLARIS_MASTER_KEY) : null;
        data = {
            isSecret: secret,
            sealed: row.sealed,
            generator: row.generator,
            value: blob ? null : fresh,
            encryptedValue: blob ? new Uint8Array(blob.ciphertext) : null,
            valueNonce: blob ? new Uint8Array(blob.nonce) : null,
            valueKeyId: blob?.keyId ?? null
        };
    } else if (row.sealed) {
        // Sealed means nobody reads it back, so it arrives sealed and empty.
        data = {
            isSecret: true,
            sealed: true,
            generator: null,
            value: null,
            encryptedValue: null,
            valueNonce: null,
            valueKeyId: null
        };
    } else {
        data = {
            isSecret: row.isSecret,
            sealed: false,
            generator: null,
            value: row.value,
            encryptedValue: row.encryptedValue ? new Uint8Array(row.encryptedValue) : null,
            valueNonce: row.valueNonce ? new Uint8Array(row.valueNonce) : null,
            valueKeyId: row.valueKeyId
        };
    }
    await prisma.envVar.upsert({
        where: { scopeType_scopeId_key: { ...to, key: row.key } },
        create: { ...to, key: row.key, ...data },
        update: data
    });
}

async function applySetting(
    from: SyncedApplication,
    into: SyncedApplication,
    setting: core.SyncSettingField,
    environmentId: string
): Promise<void> {
    if (setting === "variableGroups") {
        const wanted = new Set(from.variableGroupLinks.map((link) => link.groupId));
        await prisma.variableGroupLink.deleteMany({
            where: { applicationId: into.id, groupId: { notIn: [...wanted] } }
        });
        await prisma.variableGroupLink.createMany({
            data: from.variableGroupLinks.map((link) => ({
                applicationId: into.id,
                groupId: link.groupId,
                position: link.position,
                createdById: link.createdById
            })),
            skipDuplicates: true
        });
        return;
    }
    if (setting === "replicas" || setting === "resources") {
        // The same organization caps the service's own settings answer to.
        const replicas = setting === "replicas" ? from.replicas : into.replicas;
        const cpu = setting === "resources" ? from.cpuLimit : into.cpuLimit;
        const memory = setting === "resources" ? from.memoryLimitMb : into.memoryLimitMb;
        await quota.assertOrgReservation(
            () => quota.orgIdOfEnvironment(environmentId),
            {
                cpus: quotas.reservationOf(into.cpuLimit, into.replicas),
                memoryMb: quotas.reservationOf(into.memoryLimitMb, into.replicas)
            },
            {
                cpus: quotas.reservationOf(cpu, replicas),
                memoryMb: quotas.reservationOf(memory, replicas)
            },
            { applicationId: into.id }
        );
    }
    const data = {
        source: { sourceType: from.sourceType, sourceConfig: from.sourceConfig },
        build: { buildConfig: from.buildConfig },
        healthcheck: { healthcheck: from.healthcheck },
        deployBranch: { deployBranch: from.deployBranch },
        autoDeploy: { autoDeploy: from.autoDeploy },
        waitForCi: { waitForCi: from.waitForCi },
        commitFilter: { commitFilter: from.commitFilter },
        watchPaths: { watchPaths: from.watchPaths },
        replicas: { replicas: from.replicas, autoscale: from.autoscale },
        resources: {
            cpuLimit: from.cpuLimit,
            memoryLimitMb: from.memoryLimitMb,
            useGpu: from.useGpu
        },
        restart: {
            restartPolicy: from.restartPolicy,
            restartMaxRetries: from.restartMaxRetries
        },
        privateNetwork: { privateNetwork: from.privateNetwork }
    }[setting];
    await prisma.application.update({ where: { id: into.id }, data });
}

/**
 * Remove a service a failed add left behind - one the receiving environment did
 * not have when the sync began - so retrying the sync adds it again cleanly
 * rather than finding a half-copied service and calling it in sync.
 */
async function discardHalfAdded(environmentId: string, slug: string, ownerId: string) {
    try {
        const half = await prisma.application.findFirst({
            where: { environmentId, slug },
            select: { id: true }
        });
        if (!half) return;
        await prisma.envVar.deleteMany({ where: { scopeType: "application", scopeId: half.id } });
        await prisma.wafRule.deleteMany({ where: { scopeType: "application", scopeId: half.id } });
        const { deleteApplication } = await import("@/lib/deploy-service");
        await deleteApplication(half.id, ownerId);
    } catch (error) {
        console.error("polaris: a half-added service from a sync could not be removed:", error);
    }
}

function describe(caught: unknown): string {
    return caught instanceof Error ? caught.message : "This change could not be applied";
}

/**
 * Carry out the picked items of a sync. Each item is applied on its own; one
 * that fails is reported and the rest go on, so a retry finishes exactly the
 * work that did not happen. Nothing is deployed here - the caller deploys
 * `affected` when the reader asked for it.
 */
export async function applySync(input: {
    sourceId: string;
    targetId: string;
    ownerId: string;
    actorId: string;
    items: readonly string[];
    reach: core.SyncReach;
}): Promise<SyncOutcome> {
    const { source, target, diff } = await readBoth(input.sourceId, input.targetId, input.ownerId);
    const selection = core.selectSyncItems(diff, input.items, input.reach);
    const outcome: SyncOutcome = {
        applied: [],
        refused: [...selection.refused],
        failures: [],
        stagedRemovals: [],
        affected: []
    };
    const sourceApps = new Map(source.environment.applications.map((app) => [app.slug, app]));
    const targetApps = new Map(target.environment.applications.map((app) => [app.slug, app]));
    const sourceVariables = (scopeType: string, scopeId: string, key: string) =>
        source.variables.find(
            (row) => row.scopeType === scopeType && row.scopeId === scopeId && row.key === key
        );
    const createdIds = new Map<string, string>();
    const { copyApplicationInto } = await import("./environments");
    const staged = await import("@/lib/deploy-staged-changes");
    const { createVolume } = await import("@/lib/deploy-volume-service");

    // Services first, so a later item on a service added in this run finds it.
    const ordered = [...selection.apply].sort(
        (a, b) => Number(b.kind === "service.add") - Number(a.kind === "service.add")
    );
    for (const item of ordered) {
        try {
            const from = item.service ? sourceApps.get(item.service) : undefined;
            const into = item.service ? targetApps.get(item.service) : undefined;
            switch (item.kind) {
                case "service.add": {
                    if (!from) throw new Error("Service not found");
                    const copied = await copyApplicationInto(
                        from,
                        {
                            environmentId: target.environment.id,
                            environmentSlug: target.environment.slug,
                            projectSlug: target.environment.project.slug,
                            branch: target.environment.branch
                        },
                        input.ownerId,
                        { secrets: true }
                    ).catch(async (caught: unknown) => {
                        await discardHalfAdded(target.environment.id, from.slug, input.ownerId);
                        throw caught;
                    });
                    createdIds.set(from.slug, copied.id);
                    // What a copy does not carry over by itself, so the two
                    // compare equal afterwards and a second sync finds nothing.
                    const fresh = { ...from, id: copied.id };
                    for (const setting of ["restart", "privateNetwork", "replicas", "resources"] as const)
                        await applySetting(from, fresh, setting, target.environment.id);
                    break;
                }
                case "service.remove": {
                    if (!into) throw new Error("Service not found");
                    await staged.stageChange({
                        environmentId: target.environment.id,
                        kind: "service.delete",
                        targetType: "application",
                        targetId: into.id,
                        targetName: into.name,
                        createdById: input.actorId
                    });
                    outcome.stagedRemovals.push(into.name);
                    break;
                }
                case "service.setting": {
                    if (!from || !into || !item.field) throw new Error("Service not found");
                    await applySetting(from, into, item.field, target.environment.id);
                    break;
                }
                case "variable":
                case "shared.variable": {
                    const key = item.key ?? "";
                    const scope =
                        item.kind === "variable"
                            ? { scopeType: "application" as const, from: from?.id, to: into?.id }
                            : {
                                  scopeType: "environment" as const,
                                  from: source.environment.id,
                                  to: target.environment.id
                              };
                    if (!scope.to || !scope.from) throw new Error("Service not found");
                    if (item.change === "removed") {
                        await prisma.envVar.deleteMany({
                            where: { scopeType: scope.scopeType, scopeId: scope.to, key }
                        });
                        break;
                    }
                    const row = sourceVariables(scope.scopeType, scope.from, key);
                    if (!row) throw new Error("Variable not found");
                    await copyVariable(row, { scopeType: scope.scopeType, scopeId: scope.to });
                    break;
                }
                case "volume": {
                    if (!from || !into) throw new Error("Service not found");
                    const volume = from.volumes.find((one) => one.name === item.key);
                    if (!volume) throw new Error("Volume not found");
                    const existing = into.volumes.find((one) => one.name === volume.name);
                    if (existing) {
                        // Only where it is mounted changes; the data in it stays.
                        await prisma.volume.update({
                            where: { id: existing.id },
                            data: { mountPath: volume.mountPath }
                        });
                        break;
                    }
                    await createVolume(input.ownerId, {
                        applicationId: into.id,
                        name: volume.name,
                        mountPath: volume.mountPath,
                        kind: volume.kind as "volume" | "bind" | "nas",
                        // A new, empty volume of its own - never the source's data.
                        ...(volume.kind === "volume"
                            ? {}
                            : {
                                  source: `polaris/deploy/${target.environment.project.slug}/${target.environment.slug}/${into.slug}/${slugify(volume.name)}`
                              }),
                        ...(volume.connectionId ? { connectionId: volume.connectionId } : {}),
                        ...(volume.sizeLimit ? { sizeLimit: volume.sizeLimit } : {})
                    });
                    break;
                }
                case "network": {
                    const { setEnvironmentNetworkMode } = await import("@/lib/deploy-service");
                    const mode = core.environmentNetworkModeSchema.shape.networkMode.parse(
                        source.environment.networkMode
                    );
                    await setEnvironmentNetworkMode(target.environment.id, input.ownerId, mode);
                    break;
                }
            }
            outcome.applied.push(item.id);
        } catch (caught) {
            outcome.failures.push({ id: item.id, error: describe(caught) });
        }
    }

    const done = selection.apply.filter((item) => outcome.applied.includes(item.id));
    const slugs = core.syncAffectedServices(done, [...targetApps.keys(), ...createdIds.keys()]);
    outcome.affected = slugs.flatMap((slug) => {
        const id = targetApps.get(slug)?.id ?? createdIds.get(slug);
        return id ? [id] : [];
    });
    return outcome;
}
