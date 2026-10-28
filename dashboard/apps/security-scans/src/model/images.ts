/**
 * Every image a server runs, from its container listing: grouped by image id
 * (the digest of the image's config), so one image behind several containers
 * is scanned once, and told apart by who put it there - Polaris itself, a
 * Deploy or installed app, an agent session, or something else.
 *
 * The listing is the engine's answer and is parsed as untrusted input. Pure.
 */

import { z } from "zod";

export type ImageSource = "polaris" | "app" | "agent" | "other";

/** One container as both listings (the daemon's API, the CLI over SSH) give it. */
export interface ListedContainer {
    readonly name: string;
    /** What the container was started from, as typed: `node:22-alpine`. */
    readonly ref: string;
    /** `sha256:<64 hex>`: the image it actually runs. */
    readonly imageId: string;
    readonly project: string | null;
    readonly labels: Readonly<Record<string, string>>;
}

export interface ServerImage {
    readonly imageId: string;
    readonly ref: string;
    readonly source: ImageSource;
    /** Who uses it, as the screen names them: an app, a Polaris part, a container. */
    readonly users: readonly string[];
    /** The Deploy apps among them, by id: where the findings are read. */
    readonly applicationIds: readonly string[];
}

export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const MAX_CONTAINERS = 500;
const MAX_USERS = 20;

/** Polaris's own compose projects - exactly these, never a prefix (every app
 *  is a `polaris-<hash>` project too). */
export const OWN_PROJECTS: ReadonlySet<string> = new Set([
    "polaris",
    "polaris-tunnel",
    "polaris-ptunnel"
]);
/** An application's project: `polaris-<eight hex>`, maybe with a release marker. */
const APP_PROJECT = /^(polaris-[0-9a-f]{8})(?:$|[-_])/;
const AGENT_LABELS = ["polaris.agent-session", "polaris.agent-run", "polaris.agent-signin"];
/** The scanner's own one-off containers are never scanned. */
const SCANNER_PREFIX = "polaris-secscan";

const text = z.string().max(512);
const daemonContainer = z.object({
    Names: z.array(text).max(8).optional(),
    Image: text,
    ImageID: z.string().regex(IMAGE_ID),
    Labels: z.record(text, z.string().max(4096)).nullable().optional()
});

/** The daemon's `GET /containers/json?all=1` answer, rows that do not match dropped. */
export function fromDaemonListing(value: unknown): ListedContainer[] {
    if (!Array.isArray(value)) return [];
    const out: ListedContainer[] = [];
    for (const row of value.slice(0, MAX_CONTAINERS)) {
        const parsed = daemonContainer.safeParse(row);
        if (!parsed.success) continue;
        const labels = parsed.data.Labels ?? {};
        out.push({
            name: (parsed.data.Names?.[0] ?? "").replace(/^\//, ""),
            ref: parsed.data.Image,
            imageId: parsed.data.ImageID,
            project: labels["com.docker.compose.project"] ?? null,
            labels
        });
    }
    return out;
}

/** The format the SSH listing asks `docker ps` for, one container a line. */
export const PS_FORMAT =
    '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Labels}}';
export const INSPECT_FORMAT = "{{.Id}}\t{{.Image}}";

/** `docker ps` lines plus `docker inspect` lines (container id -> image id). */
export function fromCliListing(ps: string, inspect: string): ListedContainer[] {
    const imageOf = new Map<string, string>();
    for (const line of inspect.split("\n")) {
        const [id, image] = line.trim().split("\t");
        if (id && image && IMAGE_ID.test(image)) imageOf.set(id, image);
    }
    const out: ListedContainer[] = [];
    for (const line of ps.split("\n").slice(0, MAX_CONTAINERS)) {
        const [id, ref, name, project, labelText] = line.trim().split("\t");
        const imageId = id ? imageOf.get(id) : undefined;
        if (!id || !ref || !imageId || ref.length > 512) continue;
        const labels: Record<string, string> = {};
        for (const pair of (labelText ?? "").split(",")) {
            const at = pair.indexOf("=");
            if (at > 0) labels[pair.slice(0, at)] = pair.slice(at + 1);
        }
        out.push({ name: name ?? "", ref, imageId, project: project || null, labels });
    }
    return out;
}

/** Who put a container there. */
export function sourceOf(container: ListedContainer): ImageSource {
    if (container.project && OWN_PROJECTS.has(container.project)) return "polaris";
    if (AGENT_LABELS.some((key) => key in container.labels)) return "agent";
    if (container.project && APP_PROJECT.test(container.project)) return "app";
    return "other";
}

/**
 * Group containers by the image they run. `appNames` maps an app's project
 * (`polaris-<hash>`) to its name, and `appIds` the same project to its id. An
 * image used by Polaris and by an app counts as Polaris's: that is the one an
 * update replaces. `ownApps` are the app projects that are parts of Polaris
 * rather than somebody's app - the camera relay, say - whose image is Polaris's
 * too, under the app's name.
 */
export function groupImages(
    containers: readonly ListedContainer[],
    appNames: ReadonlyMap<string, string>,
    appIds: ReadonlyMap<string, string> = new Map(),
    ownApps: ReadonlySet<string> = new Set()
): ServerImage[] {
    const rank: Record<ImageSource, number> = { polaris: 0, app: 1, agent: 2, other: 3 };
    const byId = new Map<
        string,
        { ref: string; source: ImageSource; users: Set<string>; apps: Set<string> }
    >();
    for (const container of containers) {
        if (container.name.startsWith(SCANNER_PREFIX)) continue;
        const listed = sourceOf(container);
        const project = container.project?.match(APP_PROJECT)?.[1];
        const part = listed === "app" && project !== undefined && ownApps.has(project);
        const source: ImageSource = part ? "polaris" : listed;
        const user =
            listed === "app" && project
                ? (appNames.get(project) ?? container.name)
                : source === "polaris"
                  ? (container.labels["com.docker.compose.service"] ?? container.name)
                  : container.name;
        const appId = listed === "app" && project ? appIds.get(project) : undefined;
        const entry = byId.get(container.imageId);
        if (!entry) {
            byId.set(container.imageId, {
                ref: container.ref,
                source,
                users: new Set([user]),
                apps: new Set(appId ? [appId] : [])
            });
            continue;
        }
        if (appId && entry.apps.size < MAX_USERS) entry.apps.add(appId);
        if (rank[source] < rank[entry.source]) entry.source = source;
        // A ref someone typed reads better than the bare id a container may show.
        if (entry.ref.startsWith("sha256:") && !container.ref.startsWith("sha256:"))
            entry.ref = container.ref;
        if (entry.users.size < MAX_USERS) entry.users.add(user);
    }
    return [...byId.entries()]
        .map(([imageId, entry]) => ({
            imageId,
            ref: entry.ref,
            source: entry.source,
            users: [...entry.users].filter(Boolean).sort(),
            applicationIds: [...entry.apps].sort()
        }))
        .sort((a, b) => rank[a.source] - rank[b.source] || a.ref.localeCompare(b.ref));
}
