/**
 * Which containers on the box are Polaris, and what each of them is called.
 *
 * Kept apart from the measuring in `polaris-footprint` because this is the half
 * that can be got wrong quietly. Polaris deploys everything else on the same
 * engine, and it deploys it with compose too - every app gets a project named
 * `polaris-<hash>`, which a prefix match would happily read as part of the control
 * plane and add a Minecraft world's memory to the dashboard's. So the projects are
 * matched exactly, and there is a test that says so.
 *
 * Names are not used for any of this. `polaris-web-154` becomes `polaris-web-181`
 * on the next self-update; the compose labels do not move.
 */

import { relayProject } from "@/lib/backup-access/relay";
import { findApp } from "@/lib/apps/catalog";
import { baseProject } from "@/lib/deploy/host-volumes";

/**
 * The compose projects of the two tunnels the control plane opens for its own
 * address, defined here and used by the services that start them.
 *
 * One definition rather than two, because the failure of two is silent: a project
 * renamed where it is created would go on being started under the new name and
 * simply stop counting as Polaris here, and the figures would still look
 * plausible.
 */
export const TUNNEL_PROJECT = "polaris-tunnel";
export const PUBLIC_TUNNEL_PROJECT = "polaris-ptunnel";
/** Remote access through Tailscale, started only while it is turned on. */
export const TAILSCALE_PROJECT = "polaris-tailscale";
/** A server's way into the VPN's private networks, started with the first one. */
export const GATEWAY_PROJECT = "polaris-network-gateway";
/** The backup way in, started while backup access is on. */
export const BACKUP_TUNNEL_PROJECT = "polaris-backup-tunnel";
/** What an agent session's container and compose project are named after: the
 *  session id follows. */
export const SESSION_CONTAINER_PREFIX = "polaris-session-";

/**
 * The compose projects that are Polaris rather than something it runs.
 *
 * The stack itself, and the two tunnels above - a tunnel exists to publish
 * Polaris, so what it costs is part of what Polaris costs. A tunnel a deployed app
 * was given belongs to that app.
 */
const OWN_PROJECTS = [
    "polaris",
    TUNNEL_PROJECT,
    PUBLIC_TUNNEL_PROJECT,
    TAILSCALE_PROJECT,
    GATEWAY_PROJECT,
    BACKUP_TUNNEL_PROJECT,
    relayProject("relay"),
    relayProject("home")
];

/** What each part of the stack is called, and what it is for. Keyed by the compose
 *  service, which is the name in the file and survives the container being
 *  replaced. */
const PARTS: Record<string, { label: string; summary: string }> = {
    web: {
        // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
        label: "Dashboard",
        summary: "The control plane: every page, the API, and the background sweeps."
    },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    postgres: { label: "Database", summary: "Everything Polaris remembers." },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    traefik: { label: "Edge", summary: "Routes every domain and holds the certificates." },
    "edge-guard": {
        // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
        label: "Edge guard",
        summary: "Applies the firewall to requests as they arrive."
    },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    hostd: { label: "Host daemon", summary: "Mounts, host files and the Docker proxy." },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    livekit: { label: "Call server", summary: "Carries the sound and the picture in a call." },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    mdns: { label: "Local discovery", summary: "Answers to polaris.local on the network." },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    "mc-router": { label: "Minecraft router", summary: "One port for every Java server." },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    caddy: { label: "Edge (legacy)", summary: "The previous edge, kept for rollback." },
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    ptunnel: { label: "Public tunnel", summary: "Publishes Polaris without a port forward." },
    "polaris-tailscale": {
        // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
        label: "Remote access",
        summary: "Reaches Polaris from your Tailscale devices."
    },
    [GATEWAY_PROJECT]: {
        // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
        label: "VPN gateway",
        summary: "Connects this server's private networks to the VPN."
    },
    "polaris-tunnel": {
        // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
        label: "Public tunnel",
        summary: "Publishes Polaris without a port forward."
    }
};

/** The relay's own parts, by what the container does rather than its service
 *  name, which carries the relay's id. */
const RELAY_PORTS = {
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    label: "Relay ports",
    summary: "Carries game, call and other side ports through the relay."
};
const RELAY_LINK = {
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    label: "Relay link",
    summary: "Keeps Polaris reachable through your relay server."
};
const BACKUP_TUNNEL = {
    // i18n-ignore said in the reader's words by the footprint panel (footprint.parts)
    label: "Backup access",
    summary: "A second way in while the main address is down."
};

/**
 * An official app's install, keyed by the compose project its container runs
 * under. Read from the database (`official-app-projects`), passed in here so the
 * rule stays pure.
 */
export interface OfficialApp {
    /** The Polaris app it belongs to, by catalog id ("vpn"). */
    readonly owner: string;
    /** The install itself, by catalog id ("vpn-engine"). */
    readonly install: string;
}

export type OfficialProjects = ReadonlyMap<string, OfficialApp>;

const NO_OFFICIAL: OfficialProjects = new Map();

/** What the classification needs of a container. A subset of the engine's summary
 *  so the rule can be exercised without one. */
export interface PartIdentity {
    readonly name: string;
    readonly composeProject: string | null;
    readonly composeService: string | null;
}

/** The official app a container runs for, or null. */
export function officialAppOf(
    container: PartIdentity,
    official: OfficialProjects = NO_OFFICIAL
): OfficialApp | null {
    return official.get(baseProject(container.composeProject) ?? "") ?? null;
}

/**
 * Whether a container is part of Polaris itself rather than something it runs:
 * the stack and its tunnels, and - given the installs - every official app's
 * containers, which Polaris deploys into its own Marketplace project but nobody
 * deployed by hand. Every screen that splits Polaris from the rest asks this.
 */
export function isPolarisPart(
    container: PartIdentity,
    official: OfficialProjects = NO_OFFICIAL
): boolean {
    if (container.composeProject !== null && OWN_PROJECTS.includes(container.composeProject))
        return true;
    return officialAppOf(container, official) !== null;
}

/** The agent session a container runs, by id, or null for anything else. */
export function codeSessionId(container: PartIdentity): string | null {
    const name = container.composeProject ?? container.name;
    if (!name.startsWith(SESSION_CONTAINER_PREFIX)) return null;
    const id = name.slice(SESSION_CONTAINER_PREFIX.length);
    return id || null;
}

/** What to call a part. Anything the stack grows that this file has not been told
 *  about still gets a row and a figure, under whatever compose calls it. */
export function describePart(
    container: PartIdentity,
    official: OfficialProjects = NO_OFFICIAL
): { label: string; summary: string } {
    const app = officialAppOf(container, official);
    if (app) {
        const install = findApp(app.install);
        return {
            label: findApp(app.owner)?.name ?? install?.name ?? container.name,
            summary: install?.summary ?? ""
        };
    }
    const project = container.composeProject;
    if (project === BACKUP_TUNNEL_PROJECT) return BACKUP_TUNNEL;
    if (project === relayProject("relay") || project === relayProject("home"))
        return container.name.endsWith("-frp") ? RELAY_PORTS : RELAY_LINK;
    const known = container.composeService ? PARTS[container.composeService] : undefined;
    return known ?? { label: container.composeService ?? container.name, summary: "" };
}
