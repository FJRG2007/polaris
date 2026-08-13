/**
 * What a permission can be scoped to.
 *
 * A permission key says what somebody may do; a resource string says which thing
 * they may do it to. The engine in ./authz.ts has always matched the pair, but
 * only Drive ever produced a resource - every other check is asked about the
 * sentinel "*", which is how "moderate a game server" ended up meaning "moderate
 * every game server on the instance".
 *
 * This is the vocabulary the rest of Polaris addresses its things with. Pure and
 * string-formed, like ./scope.ts, so the browser and the server read a grant the
 * same way, and a row that has rotted parses to nothing rather than to something
 * wider than it was.
 */

import { driveResourcePatterns } from "./authz.js";
import { expandPermissions, type Permission } from "./permissions.js";

/**
 * The kinds of thing a grant can name.
 *
 * `install` is a marketplace install, which is what a game server actually is -
 * the action namespace already carries "what" (`games.moderate`), so the resource
 * only has to carry "which". A service hostname is deliberately absent: it hangs
 * off an application, which hangs off a project, so a project grant already
 * reaches it. `domain` is the account-level zone, which nothing else covers.
 */
export const RESOURCE_KINDS = ["install", "project", "domain", "space", "drive"] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** One addressable thing. `id` is "*" on a grant that covers the whole kind. */
export interface ResourceRef {
    readonly kind: ResourceKind;
    readonly id: string;
}

/** Every resource of a kind, as a grant may name it. */
export const EVERY_RESOURCE = "*";

/** The string the engine matches against: `<kind>:<id>`. Drive's id already
 *  carries its connection and path, so this is byte-identical to what
 *  `driveResource` has always produced and no Drive code has to change. */
export function resourceString(ref: ResourceRef): string {
    return `${ref.kind}:${ref.id}`;
}

/** Shorthand for the form nearly every caller wants. */
export function resourceRef(kind: ResourceKind, id: string): ResourceRef {
    return { kind, id };
}

/**
 * Read a resource string back.
 *
 * Anything unrecognised is null rather than a guess. This value arrives from a
 * stored row and from an admin-authored policy, and a grant nobody can parse must
 * reach nothing at all - the same fail-closed rule every other grant parser in
 * Polaris follows.
 */
export function parseResource(value: string): ResourceRef | null {
    const separator = value.indexOf(":");
    if (separator <= 0) return null;
    const kind = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (!id) return null;
    return (RESOURCE_KINDS as readonly string[]).includes(kind)
        ? { kind: kind as ResourceKind, id }
        : null;
}

/**
 * The patterns a grant on this reference should match. A flat kind matches
 * itself and nothing else; Drive keeps inheriting down its subtree, which is the
 * one kind whose id is a path rather than a row.
 */
export function resourcePatterns(ref: ResourceRef): string[] {
    if (ref.kind !== "drive") return [resourceString(ref)];
    const separator = ref.id.indexOf(":");
    if (separator < 0) return [resourceString(ref)];
    return driveResourcePatterns(ref.id.slice(0, separator), ref.id.slice(separator + 1));
}

/** How a kind is named, and which permissions may be scoped to one of them.
 *  Granting `users.manage` on a game server is not a narrower grant, it is a
 *  meaningless one, so the editors are built from this rather than from the whole
 *  catalogue. */
export interface ResourceKindMeta {
    readonly label: string;
    readonly plural: string;
    readonly actions: readonly Permission[];
}

export const RESOURCE_KIND_META: Readonly<Record<ResourceKind, ResourceKindMeta>> = {
    install: {
        label: "Installed app",
        plural: "Installed apps",
        actions: ["games.read", "games.moderate", "games.console", "games.manage", "deploy.read", "deploy.manage"]
    },
    project: { label: "Project", plural: "Projects", actions: ["deploy.read", "deploy.manage"] },
    domain: { label: "Domain", plural: "Domains", actions: ["deploy.manage"] },
    space: { label: "Space", plural: "Spaces", actions: ["tasks.read", "tasks.manage"] },
    drive: {
        label: "Drive folder",
        plural: "Drive folders",
        actions: ["drive.read", "drive.write", "drive.delete"]
    }
};

/** Whether a permission may be scoped to this kind of thing. */
export function grantableOn(kind: ResourceKind, permission: Permission): boolean {
    return RESOURCE_KIND_META[kind].actions.includes(permission);
}

/** Drop anything that cannot be scoped to the kind, keeping catalogue order. */
export function grantableActions(kind: ResourceKind, actions: Iterable<Permission>): Permission[] {
    const wanted = new Set(actions);
    return RESOURCE_KIND_META[kind].actions.filter((action) => wanted.has(action));
}

/**
 * The few grants worth a name.
 *
 * Somebody sharing their server is answering "what should this person be able to
 * do", not assembling a permission set, so the picker leads with the three
 * answers that come up and keeps the checkboxes for the fourth. Ordered least to
 * most, like PROJECT_ROLES.
 */
export interface ResourcePreset {
    readonly slug: string;
    readonly label: string;
    readonly hint: string;
    readonly actions: readonly Permission[];
}

export const RESOURCE_PRESETS: Readonly<Record<ResourceKind, readonly ResourcePreset[]>> = {
    install: [
        {
            slug: "watch",
            label: "Watch",
            hint: "See the server and who is playing.",
            actions: ["games.read"]
        },
        {
            slug: "moderate",
            label: "Moderate",
            hint: "Op, kick, ban and whitelist players.",
            actions: ["games.moderate"]
        },
        {
            slug: "manage",
            label: "Manage",
            hint: "Everything a moderator can do, plus the console, worlds and settings.",
            actions: ["games.manage"]
        }
    ],
    project: [
        { slug: "read", label: "Read", hint: "See the project and its logs.", actions: ["deploy.read"] },
        {
            slug: "manage",
            label: "Manage",
            hint: "Deploy and configure its services.",
            actions: ["deploy.manage"]
        }
    ],
    domain: [
        { slug: "manage", label: "Manage", hint: "Point hostnames at services.", actions: ["deploy.manage"] }
    ],
    space: [
        { slug: "read", label: "Read", hint: "See the space and its tasks.", actions: ["tasks.read"] },
        { slug: "manage", label: "Manage", hint: "Create and change tasks.", actions: ["tasks.manage"] }
    ],
    drive: [
        { slug: "read", label: "Read", hint: "See and download files.", actions: ["drive.read"] },
        { slug: "write", label: "Write", hint: "Upload, rename and move files.", actions: ["drive.write"] }
    ]
};

/**
 * The preset a stored action set was picked from, or null when it was assembled
 * by hand - so an editor reopens on the choice somebody made rather than on a row
 * of ticks they never set one by one.
 *
 * Compared against the expanded preset, because a grant is stored expanded: what
 * "Moderate" holds is `games.read` and `games.moderate`, and the preset only
 * names the wider of the two.
 */
export function presetFor(kind: ResourceKind, actions: readonly Permission[]): ResourcePreset | null {
    const held = new Set(actions);
    for (const preset of RESOURCE_PRESETS[kind]) {
        const expanded = expandPermissions(preset.actions);
        if (expanded.length === held.size && expanded.every((action) => held.has(action))) return preset;
    }
    return null;
}
