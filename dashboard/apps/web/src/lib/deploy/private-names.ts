/**
 * Private names: `<name>.polaris.internal` and the bare `<name>` for every
 * service, inside its project's environment - the half that knows where the
 * answers are stored. The networks and the spec fields are pure and live in
 * `@polaris/deploy` (`networks.ts`, `private-names.ts`).
 *
 * What is stored, per application and per database, in `privateNetwork`:
 *
 * - `name`: the name its owner chose. Absent means its slug, so every service has
 *   a name from the moment it exists and nothing has to be backfilled.
 * - `aliases`: extra names it answers to - an SDK that insists on `dymoapi`.
 * - `former`: names it was renamed from, each until a date. They keep answering
 *   so a service deployed with the old name in its variables goes on reaching it
 *   until it is deployed again and picks up the new one.
 * - `live`: the names its container was given, recorded once a deploy carries
 *   them: for an application against that deployment, which only counts once it
 *   is the one serving; for a database once its deploy came up. A reference only
 *   resolves to the private name once the service behind it answers to it - a
 *   dependant deployed first would otherwise be handed a name nothing answers yet.
 *
 * Two services of an environment can come to answer to one name without anybody
 * choosing it twice - an application and a database both called `postgres`. The
 * name then stays with one of them (see `keepsLabel`) and the other is deployed
 * without it, so a lookup never lands on either at random.
 *
 * A target makes names where its daemon says it does (this machine) or always
 * (another server: the deploy script makes the networks over SSH). Where it does
 * not, every service there keeps being reached by its container name, as before.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getCapabilities } from "@polaris/config";
import {
    crossLinkNetwork,
    crossProjectDomain,
    defaultDbPort,
    linksOfLayout,
    namesFor,
    ownNamesNetwork,
    privateDomain,
    slugify
} from "@polaris/deploy";
import { keepsReleases } from "./releases";
import { decryptedValue } from "./env-values";
import { networkModeOf } from "./service-networks";

export type PrivateKind = "application" | "database";

export interface FormerName {
    readonly name: string;
    /** ISO date it stops answering. */
    readonly until: string;
}

export interface StoredPrivateNetwork {
    readonly name?: string;
    readonly aliases: readonly string[];
    readonly former: readonly FormerName[];
    readonly live?: { readonly deploymentId?: string; readonly names: readonly string[] };
    /** The names a deployment in flight will carry, waiting for it to serve. */
    readonly pending?: { readonly deploymentId: string; readonly names: readonly string[] };
}

/** What is stored, read back whole however old the row is; anything malformed is
 *  read as nothing chosen, which is the service's slug and no extra names. */
export function parsePrivateNetwork(raw: string | null | undefined): StoredPrivateNetwork {
    let parsed: Record<string, unknown> = {};
    try {
        const value = JSON.parse(raw ?? "{}") as unknown;
        if (value && typeof value === "object" && !Array.isArray(value))
            parsed = value as Record<string, unknown>;
    } catch {
        // Nothing chosen.
    }
    const label = (value: unknown): value is string =>
        typeof value === "string" && core.privateNameProblem(value) === null;
    const name = label(parsed.name) ? parsed.name : undefined;
    const aliases = Array.isArray(parsed.aliases) ? [...new Set(parsed.aliases.filter(label))] : [];
    const former = Array.isArray(parsed.former)
        ? parsed.former.flatMap((entry: unknown) => {
              const one = entry as { name?: unknown; until?: unknown } | null;
              return one &&
                  label(one.name) &&
                  typeof one.until === "string" &&
                  !Number.isNaN(Date.parse(one.until))
                  ? [{ name: one.name, until: one.until }]
                  : [];
          })
        : [];
    const liveRaw = parsed.live as { deploymentId?: unknown; names?: unknown } | undefined;
    const live =
        liveRaw && Array.isArray(liveRaw.names)
            ? {
                  ...(typeof liveRaw.deploymentId === "string"
                      ? { deploymentId: liveRaw.deploymentId }
                      : {}),
                  names: liveRaw.names.filter((one): one is string => typeof one === "string")
              }
            : undefined;
    const pendingRaw = parsed.pending as { deploymentId?: unknown; names?: unknown } | undefined;
    const pending =
        pendingRaw && typeof pendingRaw.deploymentId === "string" && Array.isArray(pendingRaw.names)
            ? {
                  deploymentId: pendingRaw.deploymentId,
                  names: pendingRaw.names.filter((one): one is string => typeof one === "string")
              }
            : undefined;
    return {
        ...(name ? { name } : {}),
        aliases,
        former,
        ...(live ? { live } : {}),
        ...(pending ? { pending } : {})
    };
}

function serialize(stored: StoredPrivateNetwork): string {
    return JSON.stringify(stored);
}

/** The service's name: the one chosen, else the one its slug makes. */
export function privateNameOf(service: { slug: string; privateNetwork: string }): string {
    return (
        parsePrivateNetwork(service.privateNetwork).name ?? core.defaultPrivateName(service.slug)
    );
}

/** `<name>.polaris.internal` for a service. */
export function privateDomainOf(service: { slug: string; privateNetwork: string }): string {
    return privateDomain(privateNameOf(service));
}

/** The former names still inside their grace period. */
export function formerInGrace(stored: StoredPrivateNetwork, now = new Date()): string[] {
    return stored.former
        .filter((entry) => Date.parse(entry.until) > now.getTime())
        .map((entry) => entry.name);
}

/** Every label a service answers to on its own names network: its name, its
 *  extra names and the former names still answering. */
export function labelsOf(
    service: { slug: string; privateNetwork: string },
    now = new Date()
): string[] {
    const stored = parsePrivateNetwork(service.privateNetwork);
    const name = stored.name ?? core.defaultPrivateName(service.slug);
    return [
        ...new Set([name, ...stored.aliases, ...formerInGrace(stored, now).slice(-MAX_FORMER)])
    ];
}

/** How many former names answer at once: the latest renames. */
const MAX_FORMER = 5;

interface TargetFacts {
    readonly kind: string;
    readonly hostId: string | null;
}

/** Whether a target gives services their private names (see the module notes). */
export function namesOn(target: TargetFacts): boolean {
    return target.kind === "local" || !target.hostId ? getCapabilities().privateNames : true;
}

/**
 * Whether a target carries links between projects: plain compose only. A swarm
 * service keeps a link's network in its spec, so a task rescheduled after the
 * link is closed would join it again, and closing one could not take effect.
 */
export function crossLinksOn(target: TargetFacts & { readonly runtime: string }): boolean {
    return namesOn(target) && target.runtime !== "swarm";
}

/** The port an application listens on inside its container: the one set on it,
 *  else its first domain's, else its source's default. */
export function containerPortOf(application: {
    sourceType: string;
    sourceConfig: string;
    domains: readonly { targetPort: number; kind?: string }[];
}): number {
    try {
        const source = JSON.parse(application.sourceConfig) as Record<string, unknown>;
        if (typeof source.port === "number") return source.port;
    } catch {
        // A service whose stored config cannot be read falls back to its domain.
    }
    const domain = application.domains.find((one) => one.kind !== "lan") ?? application.domains[0];
    return domain?.targetPort ?? (application.sourceType === "image" ? 80 : 3000);
}

// ---------------------------------------------------------------------------
// Deploy time
// ---------------------------------------------------------------------------

export interface DeployNames {
    /** Whether the target carries names at all. Off leaves the deploy as before. */
    readonly enabled: boolean;
    /** The names this deploy gives the service, to record as live once it serves. */
    readonly live: string[];
    /** The networks of the links to other projects this service is on. */
    readonly crossLinks: string[];
    /** Its names on each names network, for `networkAliases`. */
    readonly networkAliases: Record<string, string[]>;
    /** `<name>.polaris.internal`, or null where names are off or it is not given. */
    readonly domain: string | null;
}

/**
 * What a deploy gives a service: the networks of its cross-project links, and
 * its names on its own names network and - where another project calls it - on
 * the link's network as `<name>.<project>.polaris.internal`.
 *
 * A release kept running beside the others (`kept`) still joins the networks,
 * to call the services beside it, but answers to none of the service's names:
 * every kept release would, and a lookup would land on any of them. Each is
 * reached by its own container name instead, as before names.
 *
 * Nothing is recorded here - the plan may still be refused or fail. The caller
 * records `live` (`recordLiveNames`) once the deploy is under way or has come up.
 */
export async function prepareDeployNames(input: {
    readonly kind: PrivateKind;
    readonly id: string;
    readonly slug: string;
    readonly privateNetwork: string;
    readonly environment: { readonly id: string; readonly networkMode: string };
    readonly projectSlug: string;
    readonly target: TargetFacts & { readonly runtime: string };
    readonly kept?: boolean;
}): Promise<DeployNames> {
    if (!namesOn(input.target))
        return { enabled: false, live: [], crossLinks: [], networkAliases: {}, domain: null };
    const labels = input.kept ? [] : await answeringLabels(input, input.environment.id);
    const own = ownNamesNetwork({
        mode: networkModeOf(input.environment.networkMode),
        environmentId: input.environment.id,
        serviceId: input.id
    });
    const links = crossLinksOn(input.target)
        ? await prisma.privateLink.findMany({
              where: linksOf(input.kind, input.id),
              select: { id: true, targetKind: true, targetId: true, sourceId: true },
              orderBy: { createdAt: "asc" },
              take: CROSS_LINKS_MAX
          })
        : [];
    const networkAliases: Record<string, string[]> =
        labels.length > 0 ? { [own]: namesFor(labels[0]!, labels.slice(1)) } : {};
    for (const link of links) {
        if (labels.length > 0 && link.targetKind === input.kind && link.targetId === input.id) {
            networkAliases[crossLinkNetwork(link.id)] = labels.map((label) =>
                crossProjectDomain(label, input.projectSlug)
            );
        }
    }
    const primary = privateNameOf(input);
    return {
        enabled: true,
        live: [...new Set(Object.values(networkAliases).flat())].sort(),
        crossLinks: links.map((link) => crossLinkNetwork(link.id)),
        networkAliases,
        domain: labels.includes(primary) ? privateDomain(primary) : null
    };
}

/**
 * Record the names a deploy gave a service as live: for an application against
 * its deployment, which only counts once that deployment is the one serving.
 * Read fresh, so a rename made while it deployed is kept; expired former names
 * are dropped as they stop being given out.
 */
export async function recordLiveNames(
    kind: PrivateKind,
    id: string,
    names: readonly string[],
    deploymentId?: string
): Promise<void> {
    await changeStored(kind, id, (stored) => withLive(stored, names, deploymentId));
}

function withLive(
    stored: StoredPrivateNetwork,
    names: readonly string[],
    deploymentId?: string
): StoredPrivateNetwork {
    const now = Date.now();
    return {
        ...stored,
        former: stored.former.filter((entry) => Date.parse(entry.until) > now),
        live: { ...(deploymentId ? { deploymentId } : {}), names: [...names] }
    };
}

/**
 * Hold the names a deployment of an application will carry until it serves.
 * Nothing reads them as live yet: a reference keeps the container name and the
 * panel does not say "Ready" for a release that may still fail or never be
 * promoted. `promoteStagedNames` moves them over once it is the one serving.
 */
export async function stageNames(
    applicationId: string,
    names: readonly string[],
    deploymentId: string
): Promise<void> {
    await changeStored("application", applicationId, (stored) => ({
        ...stored,
        pending: { deploymentId, names: [...names] }
    }));
}

/**
 * A scale step in place adds copies to the release already serving, under a
 * deployment of its own that is promoted in turn: it carries the names that
 * release is live with, so they stay live once the step is the one serving.
 */
export async function carryLiveNames(
    applicationId: string,
    fromDeploymentId: string,
    deploymentId: string
): Promise<void> {
    await changeStored("application", applicationId, (stored) =>
        stored.live?.deploymentId === fromDeploymentId
            ? { ...stored, pending: { deploymentId, names: [...stored.live.names] } }
            : null
    );
}

/**
 * The deployment just promoted is the one serving: the names it was staged with
 * become live. Anything staged for another deployment - one superseded, or a
 * redeploy still on its way - is left as it is.
 */
export async function promoteStagedNames(
    applicationId: string,
    deploymentId: string
): Promise<void> {
    await changeStored("application", applicationId, (stored) => {
        if (stored.pending?.deploymentId !== deploymentId) return null;
        const { pending, ...rest } = stored;
        return withLive(rest, pending.names, deploymentId);
    });
}

/**
 * The labels a service is given on a deploy: every one it answers to, less the
 * ones another service of its environment keeps (see `keepsLabel`).
 */
export async function answeringLabels(
    service: { kind: PrivateKind; id: string; slug: string; privateNetwork: string },
    environmentId: string
): Promise<string[]> {
    const own = claimantOf(service);
    const clashes = contestedLabels(own, await environmentLabels(environmentId));
    for (const [label, holder] of clashes) {
        console.warn(
            `polaris: private name ${label} of ${service.kind} ${service.id} is kept by ${holder}; left out`
        );
    }
    return own.labels.filter((label) => !clashes.has(label));
}

/** A service as a claim on names: what it answers to, and the name its slug
 *  gave it when none was chosen. */
export interface Claimant {
    readonly kind: PrivateKind;
    readonly id: string;
    /** What the reader calls it. */
    readonly label: string;
    readonly labels: readonly string[];
    readonly defaulted: string | null;
}

function claimantOf(service: {
    kind: PrivateKind;
    id: string;
    slug: string;
    name?: string;
    privateNetwork: string;
}): Claimant {
    const stored = parsePrivateNetwork(service.privateNetwork);
    const slugName = core.defaultPrivateName(service.slug);
    const chosen = [stored.name, ...stored.aliases, ...stored.former.map((entry) => entry.name)];
    return {
        kind: service.kind,
        id: service.id,
        label: service.name ?? service.slug,
        labels: labelsOf(service),
        defaulted: chosen.includes(slugName) ? null : slugName
    };
}

/**
 * Whether `holder` keeps a label both it and `other` answer to: a name somebody
 * chose (a name, an extra one, a former one still answering) over one a slug
 * made, then the service made first - ids are time-ordered.
 */
export function keepsLabel(holder: Claimant, other: Claimant, label: string): boolean {
    const rank = (one: Claimant) => (one.defaulted === label ? 1 : 0);
    return rank(holder) !== rank(other) ? rank(holder) < rank(other) : holder.id < other.id;
}

/** The labels of `own` another service keeps, each with what the reader calls it. */
export function contestedLabels(own: Claimant, others: readonly Claimant[]): Map<string, string> {
    const contested = new Map<string, string>();
    for (const label of own.labels) {
        const holder = others.find(
            (one) =>
                !(one.kind === own.kind && one.id === own.id) &&
                one.labels.includes(label) &&
                keepsLabel(one, own, label)
        );
        if (holder) contested.set(label, holder.label);
    }
    return contested;
}

/**
 * Change what is stored from what is there now. A deploy and a screen can both
 * be saving it, so the write only lands on the value it was made from, and is
 * made again from a fresh read otherwise - neither undoes the other. A change
 * that answers null writes nothing.
 */
async function changeStored(
    kind: PrivateKind,
    id: string,
    change: (stored: StoredPrivateNetwork) => StoredPrivateNetwork | null
): Promise<void> {
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt++) {
        const row =
            kind === "application"
                ? await prisma.application.findUnique({
                      where: { id },
                      select: { privateNetwork: true }
                  })
                : await prisma.managedDatabase.findUnique({
                      where: { id },
                      select: { privateNetwork: true }
                  });
        if (!row) return;
        const next = change(parsePrivateNetwork(row.privateNetwork));
        if (!next) return;
        const where = { id, privateNetwork: row.privateNetwork };
        const data = { privateNetwork: serialize(next) };
        const { count } =
            kind === "application"
                ? await prisma.application.updateMany({ where, data })
                : await prisma.managedDatabase.updateMany({ where, data });
        if (count > 0) return;
    }
    throw new Error("The private names kept changing while they were being saved");
}

const STORE_ATTEMPTS = 8;

/**
 * The value `POLARIS_PRIVATE_DOMAIN` takes for a service that is referenced:
 * its private name once the container serving it answers to that name, else
 * the container name every service has always been reached by. Only switched
 * once it is live, so a dependant deployed before it is never handed a name
 * nothing answers to yet.
 */
export function referencedDomain(
    service: {
        slug: string;
        privateNetwork: string;
        currentDeploymentId?: string | null;
        target?: TargetFacts | null;
    },
    containerName: string
): string {
    if (service.target && !namesOn(service.target)) return containerName;
    const stored = parsePrivateNetwork(service.privateNetwork);
    const domain = privateDomain(stored.name ?? core.defaultPrivateName(service.slug));
    const live = stored.live;
    if (!live || !live.names.includes(domain)) return containerName;
    // An application's names are live once the deployment that carried them serves.
    if (
        service.currentDeploymentId !== undefined &&
        live.deploymentId !== service.currentDeploymentId
    ) {
        return containerName;
    }
    return domain;
}

// ---------------------------------------------------------------------------
// Choosing names
// ---------------------------------------------------------------------------

export interface NameCheck {
    /** The name as it would be stored. */
    readonly name: string;
    readonly problem: core.PrivateNameProblem | null;
    /** The service already answering to it in this environment. */
    readonly takenBy: string | null;
}

/** Every label each service of an environment answers to, by service. */
async function environmentLabels(environmentId: string): Promise<Claimant[]> {
    const [applications, databases] = await Promise.all([
        prisma.application.findMany({
            where: { environmentId },
            select: { id: true, name: true, slug: true, privateNetwork: true }
        }),
        prisma.managedDatabase.findMany({
            where: { environmentId, parentId: null },
            select: { id: true, name: true, slug: true, privateNetwork: true }
        })
    ]);
    return [
        ...applications.map((one) => claimantOf({ ...one, kind: "application" })),
        ...databases.map((one) => claimantOf({ ...one, kind: "database" }))
    ];
}

/** Whether a name is free for one service in its environment. */
export async function checkPrivateName(
    kind: PrivateKind,
    id: string,
    environmentId: string,
    raw: string
): Promise<NameCheck> {
    const name = core.normalizePrivateName(raw);
    const problem = core.privateNameProblem(name);
    if (problem) return { name, problem, takenBy: null };
    const owner = (await environmentLabels(environmentId)).find(
        (service) => !(service.kind === kind && service.id === id) && service.labels.includes(name)
    );
    return { name, problem: null, takenBy: owner?.label ?? null };
}

async function loadService(kind: PrivateKind, id: string) {
    const select = {
        id: true,
        slug: true,
        name: true,
        environmentId: true,
        privateNetwork: true
    } as const;
    const found =
        kind === "application"
            ? await prisma.application.findUnique({ where: { id }, select })
            : await prisma.managedDatabase.findUnique({ where: { id }, select });
    if (!found) throw new Error("Service not found");
    return found;
}

/** Thrown with the problem, for the action to put in the reader's words. */
export class PrivateNameRefusal extends Error {
    constructor(
        readonly reason: core.PrivateNameProblem | "taken" | "tooMany" | "unchanged",
        readonly takenBy: string | null = null
    ) {
        super(reason);
    }
}

/**
 * Rename a service. The old name keeps answering for `FORMER_NAME_GRACE_DAYS`,
 * so what was deployed with it goes on working; references to the service
 * resolve to the new one from their next deploy. Answers whether anything
 * changed - the caller redeploys the service so its container takes the name.
 */
export async function renamePrivateName(
    kind: PrivateKind,
    id: string,
    raw: string
): Promise<{ name: string; previous: string }> {
    const service = await loadService(kind, id);
    const check = await checkPrivateName(kind, id, service.environmentId, raw);
    if (check.problem) throw new PrivateNameRefusal(check.problem);
    if (check.takenBy) throw new PrivateNameRefusal("taken", check.takenBy);
    const until = new Date(Date.now() + core.FORMER_NAME_GRACE_DAYS * 86_400_000).toISOString();
    let previous = "";
    await changeStored(kind, id, (stored) => {
        previous = stored.name ?? core.defaultPrivateName(service.slug);
        if (previous === check.name) throw new PrivateNameRefusal("unchanged");
        return {
            ...stored,
            name: check.name,
            // The new name stops being a former one or an extra one; the old one
            // becomes a former name, keeping the later of two dates if it already was.
            aliases: stored.aliases.filter((alias) => alias !== check.name),
            former: [
                ...stored.former.filter(
                    (entry) => entry.name !== check.name && entry.name !== previous
                ),
                { name: previous, until }
            ]
        };
    });
    return { name: check.name, previous };
}

/** Replace a service's extra names, each checked like a name. */
export async function setPrivateAliases(
    kind: PrivateKind,
    id: string,
    raw: readonly string[]
): Promise<string[]> {
    if (raw.length > core.PRIVATE_ALIASES_MAX) throw new PrivateNameRefusal("tooMany");
    const service = await loadService(kind, id);
    const others = (await environmentLabels(service.environmentId)).filter(
        (one) => !(one.kind === kind && one.id === id)
    );
    const wanted: string[] = [];
    for (const entry of raw) {
        const name = core.normalizePrivateName(entry);
        const problem = core.privateNameProblem(name);
        if (problem) throw new PrivateNameRefusal(problem);
        const owner = others.find((one) => one.labels.includes(name));
        if (owner) throw new PrivateNameRefusal("taken", owner.label);
        if (!wanted.includes(name)) wanted.push(name);
    }
    let aliases: string[] = [];
    await changeStored(kind, id, (stored) => {
        const own = stored.name ?? core.defaultPrivateName(service.slug);
        aliases = wanted.filter((name) => name !== own);
        return { ...stored, aliases };
    });
    return aliases;
}

// ---------------------------------------------------------------------------
// Links between projects
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

export interface ReferenceEdge {
    /** The service whose variables hold the reference. */
    readonly source: string;
    /** The service or database it names. */
    readonly target: string;
}

/**
 * Which services of each environment reference which, from the
 * `${{name.KEY}}` references in their variables - the lines the canvas draws.
 * A secret is opened to look, and only the edge leaves this function.
 */
export async function referenceEdges(
    environmentIds: readonly string[]
): Promise<Map<string, ReferenceEdge[]>> {
    const edges = new Map<string, ReferenceEdge[]>();
    if (environmentIds.length === 0) return edges;
    const [applications, databases] = await Promise.all([
        prisma.application.findMany({
            where: { environmentId: { in: [...environmentIds] } },
            select: { id: true, slug: true, name: true, environmentId: true }
        }),
        prisma.managedDatabase.findMany({
            where: { environmentId: { in: [...environmentIds] } },
            select: { id: true, slug: true, name: true, environmentId: true }
        })
    ]);
    if (applications.length === 0) return edges;
    const rows = await prisma.envVar.findMany({
        where: { scopeType: "application", scopeId: { in: applications.map((app) => app.id) } }
    });
    const services = [...applications, ...databases];
    const environmentOf = new Map(applications.map((app) => [app.id, app.environmentId]));
    const seen = new Set<string>();
    for (const row of rows) {
        let value: string | null = null;
        try {
            value = decryptedValue(row);
        } catch {
            // A secret that will not open draws no line.
        }
        if (!value || !core.hasReferences(value)) continue;
        const environmentId = environmentOf.get(row.scopeId);
        if (!environmentId) continue;
        for (const reference of core.referencesIn(value)) {
            const target = services.find(
                (one) =>
                    one.environmentId === environmentId &&
                    (one.slug === reference.name || slugify(one.name) === reference.name)
            );
            if (!target || target.id === row.scopeId) continue;
            const key = `${row.scopeId}>${target.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = edges.get(environmentId) ?? [];
            list.push({ source: row.scopeId, target: target.id });
            edges.set(environmentId, list);
        }
    }
    return edges;
}
// ---------------------------------------------------------------------------
// The service's Private network panel
// ---------------------------------------------------------------------------

/** How the panel words where a service stands. */
export type PrivateNetworkStatus =
    /** Running and answering to its names. */
    | "ready"
    /** Being deployed, or never deployed yet. */
    | "starting"
    /** Running, but deployed before its current names: the next deploy gives them. */
    | "pending"
    /** Stopped or failed. */
    | "offline"
    /** Another service of its environment keeps its name (see `keepsLabel`). */
    | "taken"
    /** It keeps its releases running side by side, each on its own address. */
    | "kept"
    /** Its server's daemon predates names: an update gives them. */
    | "unsupported";

export interface PrivateNetworkPeer {
    readonly id: string;
    readonly kind: PrivateKind;
    readonly name: string;
    readonly serverName: string;
}

export interface CrossLinkView {
    readonly id: string;
    /** "in": the other project's service calls this one. "out": this one calls it. */
    readonly direction: "in" | "out";
    readonly serviceName: string;
    readonly projectName: string;
    /** The name the caller uses: `<name>.<project>.polaris.internal`. */
    readonly domain: string;
    readonly sameServer: boolean;
}

export interface PrivateNetworkView {
    readonly kind: PrivateKind;
    readonly projectId: string;
    readonly name: string;
    readonly domain: string;
    readonly aliases: string[];
    readonly former: FormerName[];
    /** "dual" for IPv4 and IPv6, "ipv4", or null when not known. */
    readonly family: "dual" | "ipv4" | null;
    readonly status: PrivateNetworkStatus;
    /** For "taken": the service that keeps the name. */
    readonly takenBy: string | null;
    readonly serverName: string;
    /** The port it listens on, or null for one it does not say. */
    readonly port: number | null;
    /** Whether `http://<name>.polaris.internal` reaches it with no port. */
    readonly portless: boolean;
    /** The environment shares the proxy network with every other project. */
    readonly sharedEnvironment: boolean;
    /** Only the services linked to it on the canvas can reach it. */
    readonly linksMode: boolean;
    /** Services that can call it by name: same environment, same server. */
    readonly reach: PrivateNetworkPeer[];
    /** Services of its environment on other servers, which cannot. */
    readonly unreachable: PrivateNetworkPeer[];
    readonly crossLinks: CrossLinkView[];
    /** Whether its server carries links between projects at all. */
    readonly crossLinksOffered: boolean;
}

const STARTING = new Set(["queued", "provisioning", "building", "deploying", "pending"]);
const UP = new Set(["running", "deployed", "sleeping", "active", "healthy", "ready"]);

/** What the Private network panel shows for one service. Callers authorize it. */
export async function privateNetworkView(
    kind: PrivateKind,
    id: string
): Promise<PrivateNetworkView> {
    const environmentSelect = {
        id: true,
        projectId: true,
        networkMode: true,
        layout: true
    } as const;
    const targetSelect = { id: true, kind: true, hostId: true, runtime: true, name: true } as const;
    const service =
        kind === "application"
            ? await prisma.application.findUnique({
                  where: { id },
                  select: {
                      id: true,
                      slug: true,
                      name: true,
                      privateNetwork: true,
                      currentDeploymentId: true,
                      sourceType: true,
                      sourceConfig: true,
                      keepReleases: true,
                      volumes: { select: { id: true } },
                      environment: { select: environmentSelect },
                      target: { select: targetSelect },
                      domains: {
                          where: { enabled: true, deploymentId: null },
                          select: { targetPort: true, kind: true }
                      }
                  }
              })
            : await prisma.managedDatabase.findUnique({
                  where: { id },
                  select: {
                      id: true,
                      slug: true,
                      name: true,
                      privateNetwork: true,
                      status: true,
                      image: true,
                      environment: { select: environmentSelect },
                      target: { select: targetSelect }
                  }
              });
    if (!service) throw new Error("Service not found");

    const stored = parsePrivateNetwork(service.privateNetwork);
    const name = stored.name ?? core.defaultPrivateName(service.slug);
    const mode = networkModeOf(service.environment.networkMode);
    const enabled = namesOn(service.target);
    const local = service.target.kind === "local" || !service.target.hostId;

    // Where it stands: the deploy in flight or the release serving it, then
    // whether that release was given the names it has now.
    let state: string;
    let liveNow: boolean;
    if ("currentDeploymentId" in service) {
        const { getApplicationDeployStatuses } = await import("@/lib/deploy-service");
        // Never deployed reads as not running: nothing answers to its names yet.
        state = (await getApplicationDeployStatuses([service]))[service.id] ?? "never";
        liveNow =
            stored.live?.deploymentId !== undefined &&
            stored.live.deploymentId === service.currentDeploymentId;
    } else {
        state = service.status;
        liveNow = true;
    }
    const kept = "keepReleases" in service && keepsReleases(service);
    const clashes = contestedLabels(
        claimantOf({ ...service, kind }),
        enabled && !kept ? await environmentLabels(service.environment.id) : []
    );
    const links = await crossLinksOf(kind, service.id);
    const wanted = [
        ...[name, ...stored.aliases].filter((one) => !clashes.has(one)).map(privateDomain),
        // And the name each linked project calls it by, on that link's network.
        ...(clashes.has(name)
            ? []
            : links.filter((link) => link.direction === "in").map((link) => link.domain))
    ];
    const carries = liveNow && wanted.every((one) => stored.live?.names.includes(one));
    const status: PrivateNetworkStatus = !enabled
        ? "unsupported"
        : kept
          ? "kept"
          : clashes.has(name)
            ? "taken"
            : STARTING.has(state)
              ? "starting"
              : !UP.has(state)
                ? "offline"
                : carries
                  ? "ready"
                  : "pending";

    const [family, peers] = await Promise.all([
        (async () => {
            if (!local) return null;
            const { dualStackNetworks } = await import("./service-networks");
            const dual = await dualStackNetworks();
            if (!dual) return null;
            const own = ownNamesNetwork({
                mode,
                environmentId: service.environment.id,
                serviceId: service.id
            });
            return dual.has(own) ? ("dual" as const) : ("ipv4" as const);
        })(),
        prisma.application.findMany({
            where: { environmentId: service.environment.id, id: { not: service.id } },
            select: { id: true, name: true, target: { select: { id: true, name: true } } },
            orderBy: { name: "asc" },
            take: 200
        })
    ]);

    // Who can call it by name: in `links` mode the services linking to it, else
    // every service of the environment - on the same server only, since names are
    // a property of one machine's networks.
    const linking = new Set(
        linksOfLayout(service.environment.layout)
            .filter((link) => link.target === service.id)
            .map((link) => link.source)
    );
    const callers = peers.filter((peer) => mode !== "links" || linking.has(peer.id));
    const asPeer = (peer: (typeof peers)[number]): PrivateNetworkPeer => ({
        id: peer.id,
        kind: "application",
        name: peer.name,
        serverName: peer.target.name
    });

    const port =
        "sourceType" in service ? containerPortOf(service) : defaultDbPort(service.image) || null;
    return {
        kind,
        projectId: service.environment.projectId,
        name,
        domain: privateDomain(name),
        aliases: [...stored.aliases],
        former: stored.former.filter((entry) => Date.parse(entry.until) > Date.now()),
        family,
        status,
        takenBy: clashes.get(name) ?? null,
        serverName: service.target.name,
        port,
        portless:
            enabled &&
            kind === "application" &&
            service.target.runtime === "compose" &&
            port !== null,
        sharedEnvironment: mode === "shared",
        linksMode: mode === "links",
        reach: callers.filter((peer) => peer.target.id === service.target.id).map(asPeer),
        unreachable: callers.filter((peer) => peer.target.id !== service.target.id).map(asPeer),
        crossLinks: links.map(({ serverId, ...link }) => ({
            ...link,
            sameServer: serverId === service.target.id
        })),
        crossLinksOffered: crossLinksOn(service.target)
    };
}

/** The most links between projects one service can be on. */
const CROSS_LINKS_MAX = 64;

/** The links between projects a service is on, from either side. */
function linksOf(kind: PrivateKind, id: string) {
    return kind === "application"
        ? { OR: [{ sourceId: id }, { targetKind: "application", targetId: id }] }
        : { targetKind: "database", targetId: id };
}

/** The links between projects one service is on, with what the other side is. */
async function crossLinksOf(
    kind: PrivateKind,
    id: string
): Promise<(Omit<CrossLinkView, "sameServer"> & { serverId: string })[]> {
    const links = await prisma.privateLink.findMany({
        where: linksOf(kind, id),
        orderBy: { createdAt: "asc" },
        take: CROSS_LINKS_MAX
    });
    if (links.length === 0) return [];
    const appIds = [
        ...links.map((link) => link.sourceId),
        ...links.filter((link) => link.targetKind === "application").map((link) => link.targetId)
    ];
    const dbIds = links
        .filter((link) => link.targetKind === "database")
        .map((link) => link.targetId);
    const select = {
        id: true,
        name: true,
        slug: true,
        privateNetwork: true,
        targetId: true,
        environment: { select: { project: { select: { name: true, slug: true } } } }
    } as const;
    const [apps, dbs] = await Promise.all([
        prisma.application.findMany({ where: { id: { in: appIds } }, select }),
        prisma.managedDatabase.findMany({ where: { id: { in: dbIds } }, select })
    ]);
    const find = (kindOf: string, one: string) =>
        (kindOf === "database" ? dbs : apps).find((service) => service.id === one);
    return links.flatMap((link) => {
        const target = find(link.targetKind, link.targetId);
        const source = find("application", link.sourceId);
        // A link whose other side is gone is left for the reconcile to prune.
        if (!target || !source) return [];
        const incoming = link.targetKind === kind && link.targetId === id;
        const other = incoming ? source : target;
        return [
            {
                id: link.id,
                direction: incoming ? ("in" as const) : ("out" as const),
                serviceName: other.name,
                projectName: other.environment.project.name,
                domain: crossProjectDomain(privateNameOf(target), target.environment.project.slug),
                serverId: other.targetId
            }
        ];
    });
}

/** A service of another project that may be linked to call this one. */
export interface CrossLinkCandidate {
    readonly id: string;
    readonly name: string;
    readonly projectName: string;
    readonly environmentName: string;
}

/**
 * The applications of the owner's other projects, on the same server, that the
 * user may configure - the ones that can be given a way through to this service.
 * A service on another server is left out: names do not cross machines.
 */
export async function crossLinkCandidates(
    kind: PrivateKind,
    id: string,
    userId: string
): Promise<CrossLinkCandidate[]> {
    const select = {
        targetId: true,
        environment: { select: { projectId: true, project: { select: { ownerId: true } } } }
    } as const;
    const service =
        kind === "application"
            ? await prisma.application.findUnique({ where: { id }, select })
            : await prisma.managedDatabase.findUnique({ where: { id }, select });
    if (!service) return [];
    const [apps, linked] = await Promise.all([
        prisma.application.findMany({
            where: {
                targetId: service.targetId,
                environment: {
                    projectId: { not: service.environment.projectId },
                    project: { ownerId: service.environment.project.ownerId }
                }
            },
            select: {
                id: true,
                name: true,
                environmentId: true,
                environment: {
                    select: { name: true, projectId: true, project: { select: { name: true } } }
                }
            },
            orderBy: { name: "asc" },
            take: 200
        }),
        prisma.privateLink.findMany({
            where: { targetKind: kind, targetId: id },
            select: { sourceId: true }
        })
    ]);
    const { accessCan, accessInEnvironment, projectAccess } = await import(
        "@/lib/deploy-project-access"
    );
    const projectIds = [...new Set(apps.map((app) => app.environment.projectId))];
    const accesses = new Map(
        await Promise.all(
            projectIds.map(
                async (projectId) => [projectId, await projectAccess(projectId, userId)] as const
            )
        )
    );
    const taken = new Set(linked.map((link) => link.sourceId));
    return apps
        .filter((app) => {
            const access = accesses.get(app.environment.projectId);
            return (
                !taken.has(app.id) &&
                access &&
                accessCan(access, "service.configure") &&
                accessInEnvironment(access, app.environmentId)
            );
        })
        .map((app) => ({
            id: app.id,
            name: app.name,
            projectName: app.environment.project.name,
            environmentName: app.environment.name
        }));
}

/** Give an application of another project a way through to this service. The
 *  caller has checked the user may configure both. */
export async function addCrossLink(
    kind: PrivateKind,
    id: string,
    sourceId: string,
    userId: string
): Promise<void> {
    const select = {
        targetId: true,
        target: { select: { kind: true, hostId: true, runtime: true } },
        environment: { select: { projectId: true } }
    } as const;
    const [target, source] = await Promise.all([
        kind === "application"
            ? prisma.application.findUnique({ where: { id }, select })
            : prisma.managedDatabase.findUnique({ where: { id }, select }),
        prisma.application.findUnique({ where: { id: sourceId }, select })
    ]);
    if (!target || !source) throw new PrivateLinkRefusal("missing");
    if (target.environment.projectId === source.environment.projectId)
        throw new PrivateLinkRefusal("sameProject");
    if (target.targetId !== source.targetId) throw new PrivateLinkRefusal("otherServer");
    if (!crossLinksOn(target.target)) throw new PrivateLinkRefusal("unsupported");
    const key = { targetKind: kind, targetId: id, sourceId };
    if (!(await prisma.privateLink.findUnique({ where: { targetKind_targetId_sourceId: key } }))) {
        const counts = await Promise.all([
            prisma.privateLink.count({ where: linksOf(kind, id) }),
            prisma.privateLink.count({ where: linksOf("application", sourceId) })
        ]);
        if (counts.some((count) => count >= CROSS_LINKS_MAX))
            throw new PrivateLinkRefusal("tooMany");
    }
    await prisma.privateLink.upsert({
        where: { targetKind_targetId_sourceId: { targetKind: kind, targetId: id, sourceId } },
        create: { targetKind: kind, targetId: id, sourceId, createdById: userId },
        update: {}
    });
}

/** The link, for the caller to authorize against either side before removing it. */
export async function crossLinkOf(linkId: string) {
    return prisma.privateLink.findUnique({ where: { id: linkId } });
}

/**
 * Close a link between two projects, taking effect at once from either side.
 *
 * Every container is taken off the link's network on the server both services
 * run on before the row goes, and the row only goes once that worked. Waiting
 * for a redeploy would leave access open - a database is never restarted for a
 * name - and deleting the row first would say it is closed while it is not. If
 * the server cannot be reached the link stays, and the refusal says so.
 */
export async function revokeCrossLink(link: {
    readonly id: string;
    readonly targetKind: string;
    readonly targetId: string;
}): Promise<void> {
    const select = {
        target: {
            select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
        },
        environment: { select: { project: { select: { ownerId: true } } } }
    } as const;
    const service =
        link.targetKind === "database"
            ? await prisma.managedDatabase.findUnique({ where: { id: link.targetId }, select })
            : await prisma.application.findUnique({ where: { id: link.targetId }, select });
    // A target that is gone has no container left on the link to take off.
    if (service && crossLinksOn(service.target)) {
        const { getPorts } = await import("./runtime");
        const ports = await getPorts(service.target, service.environment.project.ownerId);
        try {
            await ports.cutNetwork(crossLinkNetwork(link.id));
        } catch (error) {
            console.error("polaris: a link between projects could not be closed:", error);
            throw new PrivateLinkRefusal("unreachable");
        } finally {
            await ports.dispose().catch(() => undefined);
        }
    }
    await prisma.privateLink.deleteMany({ where: { id: link.id } });
}

/** Why a link was refused, for the action to word. */
export class PrivateLinkRefusal extends Error {
    constructor(
        readonly reason:
            | "missing"
            | "sameProject"
            | "otherServer"
            | "unreachable"
            | "tooMany"
            | "unsupported"
    ) {
        super(reason);
    }
}

/** When a service's container takes the names it has now: redeployed "now",
 *  on its "next" deploy, or on its "first" one. */
export type NamesApplied = "now" | "next" | "first";

/**
 * Redeploy an application so its container takes the names it has now, when it
 * is running at all - one never deployed takes them on its first deploy. A
 * running database is left as it is: recreating it cuts every connection to it,
 * which nobody asked for by renaming it, so it takes them on its next deploy.
 */
export async function redeployForNames(
    kind: PrivateKind,
    id: string,
    actorId: string
): Promise<NamesApplied> {
    if (kind === "application") {
        const app = await prisma.application.findUnique({
            where: { id },
            select: {
                currentDeploymentId: true,
                environment: { select: { project: { select: { ownerId: true } } } }
            }
        });
        if (!app?.currentDeploymentId) return "first";
        const { redeployForEnvScope } = await import("@/lib/deploy-service");
        await redeployForEnvScope("application", id, app.environment.project.ownerId, actorId, {
            reason: "private-names"
        });
        return "now";
    }
    const db = await prisma.managedDatabase.findUnique({
        where: { id },
        select: { status: true, parentId: true }
    });
    return db && !db.parentId && db.status === "running" ? "next" : "first";
}
