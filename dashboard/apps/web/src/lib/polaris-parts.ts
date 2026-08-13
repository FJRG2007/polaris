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

/**
 * The compose projects that are Polaris rather than something it runs.
 *
 * The stack itself, and the two tunnels the control plane opens for its own
 * address - a tunnel exists to publish Polaris, so what it costs is part of what
 * Polaris costs. A tunnel a deployed app was given belongs to that app.
 */
const OWN_PROJECTS = ["polaris", "polaris-tunnel", "polaris-ptunnel"];

/** What each part of the stack is called, and what it is for. Keyed by the compose
 *  service, which is the name in the file and survives the container being
 *  replaced. */
const PARTS: Record<string, { label: string; summary: string }> = {
    web: { label: "Dashboard", summary: "The control plane: every page, the API, and the background sweeps." },
    postgres: { label: "Database", summary: "Everything Polaris remembers." },
    traefik: { label: "Edge", summary: "Routes every domain and holds the certificates." },
    "edge-guard": { label: "Edge guard", summary: "Applies the firewall to requests as they arrive." },
    hostd: { label: "Host daemon", summary: "Mounts, host files and the Docker proxy." },
    mdns: { label: "Local discovery", summary: "Answers to polaris.local on the network." },
    "mc-router": { label: "Minecraft router", summary: "One port for every Java server." },
    caddy: { label: "Edge (legacy)", summary: "The previous edge, kept for rollback." },
    ptunnel: { label: "Public tunnel", summary: "Publishes Polaris without a port forward." },
    "polaris-tunnel": { label: "Public tunnel", summary: "Publishes Polaris without a port forward." }
};

/** What the classification needs of a container. A subset of the engine's summary
 *  so the rule can be exercised without one. */
export interface PartIdentity {
    readonly name: string;
    readonly composeProject: string | null;
    readonly composeService: string | null;
}

/** Whether a container is part of Polaris itself rather than something it runs. */
export function isPolarisPart(container: PartIdentity): boolean {
    return container.composeProject !== null && OWN_PROJECTS.includes(container.composeProject);
}

/** What to call a part. Anything the stack grows that this file has not been told
 *  about still gets a row and a figure, under whatever compose calls it. */
export function describePart(container: PartIdentity): { label: string; summary: string } {
    const known = container.composeService ? PARTS[container.composeService] : undefined;
    return known ?? { label: container.composeService ?? container.name, summary: "" };
}
