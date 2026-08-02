/**
 * The structured deploy spec sent to polaris-hostd (which validates and renders
 * it into a compose file itself), and the equivalent compose YAML rendered here
 * for the remote SSH path. Both come from one `AppDeployPlan`, so a local and a
 * remote deploy describe the same service. The spec shape must match the daemon's
 * `DeploySpec` (serde, deny_unknown_fields) field-for-field.
 */

import { traefikLabels } from "./traefik.js";
import type { AppDeployPlan, DbDeployPlan } from "./runtime/driver.js";

export interface ComposeSpecPort {
    readonly host: number;
    readonly container: number;
}

export interface ComposeSpecVolume {
    readonly source: string;
    readonly target: string;
    // volume: named docker volume. bind: path confined under the volume root.
    // nas: path confined under the mount root (`<connectionId>/<subpath>`), where
    // storage connections are mounted. Never an arbitrary host path.
    readonly kind: "volume" | "bind" | "nas";
}

export interface ComposeSpecHealth {
    readonly test: string[];
    readonly interval?: number;
    readonly retries?: number;
    readonly startPeriod?: number;
}

/**
 * What compose is allowed to do about the image at `up` time.
 *
 * Compose's own default is "missing": a tag already on the host is reused, so a
 * mutable tag (`:latest`, `:stable`, a branch tag) that moved in the registry is
 * never noticed and the deploy silently reruns the old build. Every image that
 * comes from a registry is therefore pinned to "always".
 *
 * "never" is the other half of that: an image built on this host exists nowhere
 * else, so compose must not try to fetch it - with "always" the deploy would fail
 * on a tag no registry has.
 */
export type ComposePullPolicy = "always" | "never";

export interface ComposeSpecService {
    readonly name: string;
    readonly image: string;
    readonly pullPolicy?: ComposePullPolicy;
    readonly env: Record<string, string>;
    readonly ports: ComposeSpecPort[];
    readonly volumes: ComposeSpecVolume[];
    readonly labels: Record<string, string>;
    readonly command?: string[];
    readonly networks: string[];
    readonly dependsOn?: string[];
    readonly restart?: string;
    readonly healthcheck?: ComposeSpecHealth;
    /** Replica count for swarm deploys; ignored by plain compose. */
    readonly replicas?: number;
}

export interface ComposeSpec {
    readonly project: string;
    readonly services: ComposeSpecService[];
    readonly volumes: string[];
    readonly networks: string[];
}

/** Build the structured spec for an application deployment. */
export function appComposeSpec(plan: AppDeployPlan, imageTag: string, network: string): ComposeSpec {
    const labels = traefikLabels({ serviceName: plan.ref.name, network, domains: plan.domains, waf: plan.waf });
    const namedVolumes = plan.volumes.filter((volume) => volume.kind === "volume").map((volume) => volume.source);
    // The proxy network plus any extra networks the plan requests (deduped, proxy
    // first so edge routing is unchanged). Both the daemon and the remote YAML
    // renderer emit every top-level network as external, so each must already exist
    // on the target. Traefik still routes via the proxy network (labels reference it).
    const networks = [network, ...(plan.extraNetworks ?? []).filter((net) => net && net !== network)];
    return {
        project: plan.ref.project,
        services: [
            {
                name: plan.ref.name,
                image: imageTag,
                pullPolicy: plan.build.method === "image" ? "always" : "never",
                env: { ...plan.env },
                // Publish a host port so the app is reachable over the host's IP
                // (LAN/intranet) with no reverse proxy - bound on all interfaces,
                // so it is only internet-facing if the operator forwards the port.
                ports: plan.expose ? [{ host: plan.expose.host, container: plan.expose.container }] : [],
                volumes: plan.volumes.map((volume) => ({
                    source: volume.source,
                    target: volume.mountPath,
                    kind: volume.kind
                })),
                labels,
                networks,
                restart: "unless-stopped",
                replicas: plan.replicas > 1 ? plan.replicas : undefined,
                healthcheck: plan.healthcheck
                    ? {
                          test: [...plan.healthcheck.test],
                          interval: plan.healthcheck.intervalSeconds,
                          retries: plan.healthcheck.retries,
                          startPeriod: plan.healthcheck.startPeriodSeconds
                      }
                    : undefined
            }
        ],
        volumes: namedVolumes,
        networks
    };
}

/**
 * The same spec with the pull policy dropped, for a swarm stack.
 *
 * `docker stack deploy` has no use for it - it resolves every tag to a digest on
 * the manager at deploy time, so a moved tag is picked up regardless - and warns
 * ("Ignoring unsupported options: pull_policy") on every deploy, which reads like
 * something went wrong in a log an operator is watching for exactly that.
 */
export function forSwarm(spec: ComposeSpec): ComposeSpec {
    return {
        ...spec,
        services: spec.services.map(({ pullPolicy: _dropped, ...service }) => service)
    };
}

/** Build the structured spec for a managed-database deployment. */
export function dbComposeSpec(plan: DbDeployPlan, network: string): ComposeSpec {
    const ports: ComposeSpecPort[] =
        plan.exposePort !== undefined ? [{ host: plan.exposePort, container: defaultDbPort(plan.image) }] : [];
    return {
        project: plan.ref.project,
        services: [
            {
                name: plan.ref.name,
                image: plan.image,
                pullPolicy: "always",
                env: { ...plan.env },
                command: plan.command ? [...plan.command] : undefined,
                ports,
                volumes: [{ source: plan.volumeName, target: plan.dataPath, kind: "volume" }],
                labels: {},
                networks: [network],
                restart: "unless-stopped"
            }
        ],
        volumes: [plan.volumeName],
        networks: [network]
    };
}

/** The in-container port a database engine listens on, inferred from its image. */
export function defaultDbPort(image: string): number {
    if (image.includes("postgres")) return 5432;
    if (image.includes("mysql") || image.includes("mariadb")) return 3306;
    if (image.includes("mongo")) return 27017;
    if (image.includes("redis")) return 6379;
    return 0;
}

/**
 * Render a ComposeSpec to a compose file (used by the remote SSH path, where the
 * daemon is not present). Every string is double-quoted so a value can never
 * break its field. The local path never uses this - the daemon renders instead.
 * `bind` sources are confined under `volumeRoot`, `nas` sources under `mountRoot`
 * (where storage connections are mounted) - mirroring the daemon's confinement.
 */
export function renderComposeYaml(spec: ComposeSpec, volumeRoot: string, mountRoot: string): string {
    const lines: string[] = ["services:"];
    for (const service of spec.services) {
        lines.push(`  ${service.name}:`);
        lines.push(`    image: ${yamlQuote(service.image)}`);
        lines.push(`    container_name: ${yamlQuote(service.name)}`);
        if (service.pullPolicy) lines.push(`    pull_policy: ${yamlQuote(service.pullPolicy)}`);
        if (service.restart) lines.push(`    restart: ${yamlQuote(service.restart)}`);
        if (Object.keys(service.env).length > 0) {
            lines.push("    environment:");
            for (const [key, value] of Object.entries(service.env)) {
                lines.push(`      - ${yamlQuote(`${key}=${value}`)}`);
            }
        }
        if (service.ports.length > 0) {
            lines.push("    ports:");
            for (const port of service.ports) lines.push(`      - ${yamlQuote(`${port.host}:${port.container}`)}`);
        }
        if (service.volumes.length > 0) {
            lines.push("    volumes:");
            for (const volume of service.volumes) {
                const source =
                    volume.kind === "bind"
                        ? `${volumeRoot}/${volume.source}`
                        : volume.kind === "nas"
                          ? `${mountRoot}/${volume.source}`
                          : volume.source;
                lines.push(`      - ${yamlQuote(`${source}:${volume.target}`)}`);
            }
        }
        if (Object.keys(service.labels).length > 0) {
            lines.push("    labels:");
            for (const [key, value] of Object.entries(service.labels)) {
                lines.push(`      - ${yamlQuote(`${key}=${value}`)}`);
            }
        }
        if (service.networks.length > 0) {
            lines.push("    networks:");
            for (const net of service.networks) lines.push(`      - ${net}`);
        }
        if (service.command && service.command.length > 0) {
            lines.push(`    command: [${service.command.map(yamlQuote).join(", ")}]`);
        }
        if (service.healthcheck) {
            lines.push("    healthcheck:");
            lines.push(`      test: [${service.healthcheck.test.map(yamlQuote).join(", ")}]`);
            if (service.healthcheck.interval) lines.push(`      interval: ${service.healthcheck.interval}s`);
            if (service.healthcheck.retries) lines.push(`      retries: ${service.healthcheck.retries}`);
            if (service.healthcheck.startPeriod) lines.push(`      start_period: ${service.healthcheck.startPeriod}s`);
        }
        if (service.replicas && service.replicas > 1) {
            lines.push(`    deploy:\n      mode: replicated\n      replicas: ${service.replicas}`);
        }
    }
    if (spec.networks.length > 0) {
        lines.push("networks:");
        for (const net of spec.networks) lines.push(`  ${net}:\n    external: true`);
    }
    if (spec.volumes.length > 0) {
        lines.push("volumes:");
        for (const volume of spec.volumes) lines.push(`  ${volume}:`);
    }
    return `${lines.join("\n")}\n`;
}

function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
