/**
 * Syncing one environment of a project into another, the way Railway's "Sync"
 * does: the receiving environment is shown every service that was added,
 * edited or removed in the other one, the reader picks what to take, and the
 * picked changes are applied as one change - deployed at once, or parked in
 * the changeset to deploy later.
 *
 * Services are paired by slug, as a promotion pairs them. The diff is a pure
 * function of two snapshots the server reads, and it never sees a variable's
 * value: each side hands in a fingerprint the server computed, so nothing the
 * diff answers can carry a secret even by accident. Domains are not part of a
 * snapshot at all, and a volume is compared as a definition (its name and
 * where it is mounted) - its data is never read, copied or removed.
 */

import { z } from "zod";
import type { ProjectCapability } from "./schemas/project-access.js";

/** The settings of a service a sync compares and copies, in the order shown. */
export const SYNC_SETTING_FIELDS = [
    "source",
    "build",
    "healthcheck",
    "deployBranch",
    "autoDeploy",
    "waitForCi",
    "commitFilter",
    "watchPaths",
    "replicas",
    "resources",
    "restart",
    "privateNetwork",
    "variableGroups"
] as const;
export type SyncSettingField = (typeof SYNC_SETTING_FIELDS)[number];

/** One setting as a snapshot carries it: what is compared, and what may be shown. */
export interface SyncField {
    /** Compared as it is. Stays on the server: the diff only answers `display`. */
    readonly value: string | null;
    /** What the reader is shown, with anything sensitive already taken out. */
    readonly display: string | null;
}

export interface SyncVariable {
    readonly key: string;
    /** A digest of the value, or of the generator that draws it. Never the value. */
    readonly fingerprint: string;
    readonly secret: boolean;
}

export interface SyncVolume {
    readonly name: string;
    readonly mountPath: string;
}

export interface SyncService {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly settings: Readonly<Record<SyncSettingField, SyncField>>;
    readonly variables: readonly SyncVariable[];
    readonly volumes: readonly SyncVolume[];
}

export interface SyncSnapshot {
    readonly services: readonly SyncService[];
    /** The environment's own variables, which every service in it reads. */
    readonly sharedVariables: readonly SyncVariable[];
    readonly networkMode: string;
}

export type SyncItemKind =
    | "service.add"
    | "service.remove"
    | "service.setting"
    | "variable"
    | "volume"
    | "shared.variable"
    | "network";

export interface SyncItem {
    /** Stable across reads of the same two environments, so a selection made
     *  on one preview still names the same change when it is applied. */
    readonly id: string;
    readonly kind: SyncItemKind;
    readonly change: "added" | "changed" | "removed";
    /** The service's slug and name, or null for the environment itself. */
    readonly service: string | null;
    readonly serviceName: string | null;
    readonly field?: SyncSettingField;
    readonly key?: string;
    readonly secret?: boolean;
    readonly from?: string | null;
    readonly to?: string | null;
    /** On a service that is added: how many variables and volumes come with it. */
    readonly carries?: { readonly variables: number; readonly volumes: number };
    /** Ticked when the dialog opens. Removals are not: they are opt-in. */
    readonly recommended: boolean;
}

export interface SyncServiceSummary {
    readonly slug: string;
    readonly name: string;
    readonly status: "new" | "edited" | "removed";
}

export interface SyncDiff {
    readonly items: readonly SyncItem[];
    readonly services: readonly SyncServiceSummary[];
    /** Volumes only the receiving side has. A sync never removes one. */
    readonly keptVolumes: readonly { readonly service: string; readonly name: string }[];
}

function byName<T extends { readonly name: string }>(list: readonly T[]): T[] {
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

function variableItems(
    source: readonly SyncVariable[],
    target: readonly SyncVariable[],
    scope: { readonly slug: string; readonly name: string } | null
): SyncItem[] {
    const items: SyncItem[] = [];
    const theirs = new Map(target.map((variable) => [variable.key, variable]));
    const ours = new Map(source.map((variable) => [variable.key, variable]));
    const kind = scope ? "variable" : "shared.variable";
    const id = (key: string) => (scope ? `var:${scope.slug}:${key}` : `shared:${key}`);
    const base = { kind, service: scope?.slug ?? null, serviceName: scope?.name ?? null } as const;
    for (const variable of [...source].sort((a, b) => a.key.localeCompare(b.key))) {
        const existing = theirs.get(variable.key);
        if (existing && existing.fingerprint === variable.fingerprint) continue;
        items.push({
            ...base,
            id: id(variable.key),
            change: existing ? "changed" : "added",
            key: variable.key,
            secret: variable.secret || Boolean(existing?.secret),
            recommended: true
        });
    }
    for (const variable of [...target].sort((a, b) => a.key.localeCompare(b.key))) {
        if (ours.has(variable.key)) continue;
        items.push({
            ...base,
            id: id(variable.key),
            change: "removed",
            key: variable.key,
            secret: variable.secret,
            recommended: false
        });
    }
    return items;
}

/**
 * What syncing `source` into `target` would change. Deterministic: the same two
 * snapshots always answer the same items in the same order, and two equal
 * snapshots answer none - which is what makes applying a sync twice a no-op.
 */
export function diffEnvironments(source: SyncSnapshot, target: SyncSnapshot): SyncDiff {
    const items: SyncItem[] = [];
    const services: SyncServiceSummary[] = [];
    const keptVolumes: { service: string; name: string }[] = [];
    const targets = new Map(target.services.map((service) => [service.slug, service]));
    const sources = new Map(source.services.map((service) => [service.slug, service]));

    for (const service of byName(source.services)) {
        const scope = { service: service.slug, serviceName: service.name };
        const into = targets.get(service.slug);
        if (!into) {
            services.push({ slug: service.slug, name: service.name, status: "new" });
            items.push({
                ...scope,
                id: `add:${service.slug}`,
                kind: "service.add",
                change: "added",
                carries: { variables: service.variables.length, volumes: service.volumes.length },
                recommended: true
            });
            continue;
        }
        const own: SyncItem[] = [];
        for (const field of SYNC_SETTING_FIELDS) {
            const from = into.settings[field];
            const to = service.settings[field];
            if ((from?.value ?? null) === (to?.value ?? null)) continue;
            own.push({
                ...scope,
                id: `setting:${service.slug}:${field}`,
                kind: "service.setting",
                change: "changed",
                field,
                from: from?.display ?? null,
                to: to?.display ?? null,
                recommended: true
            });
        }
        own.push(...variableItems(service.variables, into.variables, service));
        const mounted = new Map(into.volumes.map((volume) => [volume.name, volume]));
        for (const volume of byName(service.volumes)) {
            const existing = mounted.get(volume.name);
            if (existing && existing.mountPath === volume.mountPath) continue;
            own.push({
                ...scope,
                id: `volume:${service.slug}:${volume.name}`,
                kind: "volume",
                change: existing ? "changed" : "added",
                key: volume.name,
                from: existing?.mountPath ?? null,
                to: volume.mountPath,
                recommended: true
            });
        }
        const named = new Set(service.volumes.map((volume) => volume.name));
        for (const volume of byName(into.volumes))
            if (!named.has(volume.name)) keptVolumes.push({ service: into.name, name: volume.name });
        if (own.length > 0) {
            services.push({ slug: service.slug, name: into.name, status: "edited" });
            items.push(...own);
        }
    }

    for (const service of byName(target.services)) {
        if (sources.has(service.slug)) continue;
        services.push({ slug: service.slug, name: service.name, status: "removed" });
        items.push({
            id: `remove:${service.slug}`,
            kind: "service.remove",
            change: "removed",
            service: service.slug,
            serviceName: service.name,
            recommended: false
        });
    }

    items.push(...variableItems(source.sharedVariables, target.sharedVariables, null));
    if (source.networkMode !== target.networkMode)
        items.push({
            id: "network",
            kind: "network",
            change: "changed",
            service: null,
            serviceName: null,
            from: target.networkMode,
            to: source.networkMode,
            recommended: true
        });

    return { items, services, keptVolumes };
}

/** What the reader holds in each of the two environments. */
export interface SyncReach {
    readonly source: readonly ProjectCapability[];
    readonly target: readonly ProjectCapability[];
}

export type SyncRefusal =
    | "needsCreate"
    | "needsDelete"
    | "needsConfigure"
    | "needsVariables"
    | "needsSourceVariables"
    | "needsVolumes"
    | "needsSettings";

/**
 * Why the reader may not apply this item, or null when they may. The same
 * capabilities editing that thing by hand in the receiving environment takes,
 * plus - for anything that copies a variable's value - being allowed to read
 * the variables where it comes from, so a sync is never the way to see a secret.
 */
export function syncRefusal(item: SyncItem, reach: SyncReach): SyncRefusal | null {
    const target = new Set(reach.target);
    const readsSource = reach.source.includes("variables.read");
    switch (item.kind) {
        case "service.add":
            // A service comes with its variables, so adding one copies values.
            if (!target.has("service.create")) return "needsCreate";
            // And its volumes, which adding one by hand would take managing.
            if ((item.carries?.volumes ?? 0) > 0 && !target.has("volumes.manage"))
                return "needsVolumes";
            if ((item.carries?.variables ?? 0) === 0) return null;
            if (!target.has("variables.write")) return "needsVariables";
            return readsSource ? null : "needsSourceVariables";
        case "service.remove":
            return target.has("service.delete") ? null : "needsDelete";
        case "service.setting":
            return target.has("service.configure") ? null : "needsConfigure";
        case "variable":
        case "shared.variable":
            if (!target.has("variables.write")) return "needsVariables";
            return item.change === "removed" || readsSource ? null : "needsSourceVariables";
        case "volume":
            return target.has("volumes.manage") ? null : "needsVolumes";
        case "network":
            return target.has("project.settings") ? null : "needsSettings";
    }
}

export interface SyncSelection {
    readonly apply: readonly SyncItem[];
    readonly refused: readonly { readonly id: string; readonly reason: SyncRefusal }[];
}

/**
 * The picked items that still differ and that the reader may apply. An id the
 * current diff no longer has is a change already made - by an earlier run of
 * this same sync, or by hand - and is skipped rather than refused, so pressing
 * apply again after a partial failure finishes the rest and nothing twice.
 */
export function selectSyncItems(
    diff: SyncDiff,
    ids: readonly string[],
    reach: SyncReach
): SyncSelection {
    const wanted = new Set(ids);
    const apply: SyncItem[] = [];
    const refused: { id: string; reason: SyncRefusal }[] = [];
    for (const item of diff.items) {
        if (!wanted.has(item.id)) continue;
        const reason = syncRefusal(item, reach);
        if (reason) refused.push({ id: item.id, reason });
        else apply.push(item);
    }
    return { apply, refused };
}

/**
 * The receiving environment's services a deploy after the sync has to restart:
 * every one an item touched, and all of them when something they all read (the
 * shared variables, the network) changed. A removed service is not redeployed.
 */
export function syncAffectedServices(
    items: readonly SyncItem[],
    allSlugs: readonly string[]
): string[] {
    const removed = new Set(
        items.filter((item) => item.kind === "service.remove").map((item) => item.service)
    );
    const everyone = items.some((item) => item.kind === "shared.variable" || item.kind === "network");
    const touched = everyone
        ? allSlugs
        : items.flatMap((item) => (item.service && item.kind !== "service.remove" ? [item.service] : []));
    return [...new Set(touched)].filter((slug) => !removed.has(slug)).sort();
}

const pair = {
    sourceEnvironmentId: z.string().uuid(),
    targetEnvironmentId: z.string().uuid()
};
const different = (value: { sourceEnvironmentId: string; targetEnvironmentId: string }) =>
    value.sourceEnvironmentId !== value.targetEnvironmentId;
const differentIssue = { message: "Pick two different environments", path: ["targetEnvironmentId"] };

export const environmentSyncPreviewSchema = z.object(pair).refine(different, differentIssue);

export const environmentSyncSchema = z
    .object({
        ...pair,
        items: z.array(z.string().trim().min(1).max(400)).min(1).max(5000),
        /** Deploy the affected services now, or park the sync in the changeset. */
        mode: z.enum(["deploy", "stage"]).default("deploy")
    })
    .refine(different, differentIssue);

export type EnvironmentSyncInput = z.infer<typeof environmentSyncSchema>;
