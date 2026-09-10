/**
 * The structured deploy spec sent to polaris-hostd (which validates and renders
 * it into a compose file itself), and the equivalent compose YAML rendered here
 * for the remote SSH path. Both come from one `AppDeployPlan`, so a local and a
 * remote deploy describe the same service. The spec shape must match the daemon's
 * `DeploySpec` (serde, deny_unknown_fields) field-for-field.
 */

import { traefikLabels } from "./traefik.js";
import type { AppDeployPlan, DbDeployPlan, ResourceLimits } from "./runtime/driver.js";

export interface ComposeSpecPort {
    readonly host: number;
    readonly container: number;
    /** Transport to publish. Defaults to TCP; a Bedrock game server is the case
     *  that is UDP, and publishing it as TCP means nothing can reach it. */
    readonly protocol?: "tcp" | "udp";
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

/**
 * The name a container calls the machine it is running on.
 *
 * Docker answers `host-gateway` with the host's address on the container's own
 * network, and without this entry the name resolves to nothing at all. Polaris'
 * own services are given it by the stack's compose file; anything Polaris
 * deploys was not, and the first thing that needed it failed in a way nobody
 * could see - the vision worker's ffmpeg exited immediately, on a loop, because
 * the relay it was told to read is published on the host. Its stderr was
 * discarded, so what the operator saw was a camera that noticed nothing, ever.
 *
 * Given to everything Polaris starts rather than to the one app that needed it:
 * a container talking to something the host publishes is the ordinary case here,
 * and an entry nothing looks up costs nothing.
 */
export const HOST_GATEWAY = "host.docker.internal:host-gateway";

export interface ComposeSpecService {
    readonly name: string;
    readonly image: string;
    readonly pullPolicy?: ComposePullPolicy;
    readonly env: Record<string, string>;
    readonly ports: ComposeSpecPort[];
    readonly volumes: ComposeSpecVolume[];
    readonly labels: Record<string, string>;
    readonly command?: string[];
    /** Replaces the image's own entrypoint - a maintenance container running a
     *  script beside the program its image is built around. */
    readonly entrypoint?: string[];
    readonly networks: string[];
    /** Other names the container answers to on every network it joins (see
     *  `AppDeployPlan.alias`). */
    readonly aliases?: string[];
    /** Names this container can reach that DNS cannot answer, as `name:address`.
     *  One of them is always here - see `HOST_GATEWAY`. */
    readonly extraHosts?: string[];
    readonly dependsOn?: string[];
    readonly restart?: string;
    readonly healthcheck?: ComposeSpecHealth;
    /** Replica count for swarm deploys; ignored by plain compose. */
    readonly replicas?: number;
    /**
     * Swarm only: replace a running service start-first - the new task comes up,
     * passes its healthcheck, and only then does the old one stop - and roll back
     * by itself when the new one fails within the monitor window. Never set for a
     * service with a volume, where two tasks at once would share its files.
     */
    readonly rollingUpdate?: boolean;
    /** The most CPU, in cores, and memory, in MB, the container may use. Absent is
     *  no limit. */
    readonly cpus?: number;
    readonly memoryMb?: number;
}

export interface ComposeSpec {
    readonly project: string;
    readonly services: ComposeSpecService[];
    readonly volumes: string[];
    readonly networks: string[];
    /** Volumes that already exist, by their exact names, mounted but never owned:
     *  a maintenance container reaching a stopped service's data. */
    readonly externalVolumes?: string[];
}

/**
 * A value as compose must be given it: every `$` doubled.
 *
 * Compose interpolates `$NAME` and `${NAME}` in everything it reads - environment,
 * labels, the command, a healthcheck - and a `$` it cannot resolve becomes nothing. So
 * a password with a dollar in it arrived in the container without the dollar and the
 * word after it, and a redirect replacement written `${1}` would have been swallowed
 * whole. `$$` is compose's own escape and reaches the container as one `$`.
 */
export function composeValue(value: string): string {
    return value.replace(/\$/g, "$$$$");
}

/** Every value in a map, escaped for compose. */
function composeValues(values: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, composeValue(value)]));
}

/**
 * A spec as it is handed to compose, with every interpolated value escaped.
 *
 * Applied at the one boundary every spec crosses on its way to a compose file - the
 * ports' `composeUp` and `stackUp`, local daemon and remote renderer alike - rather than
 * by each thing that builds a spec: an application, a tunnel connector, an agent
 * session and a runner all build their own, and escaping in some of them is the bug
 * this exists to end. Everything else about the spec is names and numbers compose does
 * not interpolate.
 */
export function forCompose(spec: ComposeSpec): ComposeSpec {
    return {
        ...spec,
        services: spec.services.map((service) => ({
            ...service,
            env: composeValues(service.env),
            labels: composeValues(service.labels),
            command: service.command?.map(composeValue),
            entrypoint: service.entrypoint?.map(composeValue),
            healthcheck: service.healthcheck
                ? { ...service.healthcheck, test: service.healthcheck.test.map(composeValue) }
                : undefined
        }))
    };
}

/** Build the structured spec for an application deployment. */
export function appComposeSpec(plan: AppDeployPlan, imageTag: string, network: string): ComposeSpec {
    const joined = joinedNetworks(plan.networks, network);
    const labels = traefikLabels({
        serviceName: plan.ref.name,
        // The network the edge finds the container on: the proxy network whenever
        // the service is on it, else the private one the edge was attached to.
        network: joined[0] ?? network,
        domains: plan.domains,
        waf: plan.waf,
        edge: plan.edge,
        replicas: plan.replicas
    });
    const namedVolumes = plan.volumes.filter((volume) => volume.kind === "volume").map((volume) => volume.source);
    // The planned networks plus any extra networks the plan requests (deduped, in
    // order, so the proxy network stays first where the service is on it). Both the
    // daemon and the remote YAML renderer emit every top-level network as external,
    // so each must already exist on the target: the shared ones are made when the
    // target is set up, the private ones just before compose runs.
    const networks = [...new Set([...joined, ...(plan.extraNetworks ?? [])].filter(Boolean))];
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
                // A private service publishes nothing: the edge reaches it by name.
                ports: [
                    ...(plan.expose && !plan.private
                        ? [
                              {
                                  host: plan.expose.host,
                                  container: plan.expose.container,
                                  ...(plan.expose.protocol ? { protocol: plan.expose.protocol } : {})
                              }
                          ]
                        : []),
                    ...(plan.extraPorts ?? []).map((port) => ({
                        host: port.host,
                        container: port.container,
                        ...(port.protocol ? { protocol: port.protocol } : {})
                    }))
                ],
                volumes: plan.volumes.map((volume) => ({
                    source: volume.source,
                    target: volume.mountPath,
                    kind: volume.kind
                })),
                labels,
                ...(plan.command && plan.command.length > 0 ? { command: [...plan.command] } : {}),
                networks,
                ...(plan.alias && plan.alias !== plan.ref.name ? { aliases: [plan.alias] } : {}),
                extraHosts: [HOST_GATEWAY],
                restart: "unless-stopped",
                replicas: plan.replicas > 1 ? plan.replicas : undefined,
                ...limitFields(plan.limits),
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
 *
 * And with the replacement made start-first wherever it is safe: a stateless
 * service is updated with no gap and rolled back by the engine if the new version
 * does not come up. A service with a volume keeps swarm's stop-first default,
 * because two tasks writing one volume is how data gets corrupted.
 */
export function forSwarm(spec: ComposeSpec): ComposeSpec {
    return {
        ...spec,
        services: spec.services.map(({ pullPolicy: _dropped, ...service }) =>
            service.volumes.length === 0 ? { ...service, rollingUpdate: true } : service
        )
    };
}

/** Longest container name DNS (and docker) will take. */
const MAX_NAME = 63;

/**
 * The names a service's copies run under: its own first, then `-r2`, `-r3`... each
 * cut to fit a DNS label. The first keeps the service's own name, so the terminal,
 * the logs and the status - which all ask for that name - keep answering.
 */
export function replicaNames(name: string, count: number): string[] {
    return Array.from({ length: Math.max(1, count) }, (_, index) => {
        if (index === 0) return name;
        const suffix = `-r${index + 1}`;
        return `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    });
}

/**
 * The spec plain compose runs for a replicated service: one service per copy.
 *
 * Compose cannot scale a service that has a container name, and every service
 * Polaris runs has one - it is what everything reaching into the container asks
 * for. So each copy is a service of its own: the first unchanged, the others under
 * `replicaNames`, publishing nothing on the host (the port is the first one's) and
 * answering to the service's own name as well, so anything that reaches the service
 * by name is spread over all of them. They carry the same labels, which the edge
 * merges into one service it balances over. Swarm scales natively and never comes
 * through here.
 */
export function expandReplicas(spec: ComposeSpec): ComposeSpec {
    return {
        ...spec,
        services: spec.services.flatMap(({ replicas, ...service }) => {
            if (!replicas || replicas <= 1) return [service];
            const [, ...copies] = replicaNames(service.name, replicas);
            const aliases = [...(service.aliases ?? []), service.name];
            return [service, ...copies.map((name) => ({ ...service, name, ports: [], aliases }))];
        })
    };
}

/** A CPU limit as compose writes it: a quoted decimal, never an exponent. */
function cpusValue(cpus: number): string {
    return String(Math.round(cpus * 100) / 100);
}

/**
 * A service's `deploy:` block, or none when it needs nothing there: swarm's
 * replicas and start-first update, and the resource limits - which plain compose
 * reads from the same place, so one block serves both engines.
 */
export function deployBlockLines(
    service: Pick<ComposeSpecService, "replicas" | "rollingUpdate" | "cpus" | "memoryMb">
): string[] {
    const replicated = service.replicas !== undefined && service.replicas > 1;
    const limited = service.cpus !== undefined || service.memoryMb !== undefined;
    if (!replicated && !service.rollingUpdate && !limited) return [];
    const lines = ["    deploy:"];
    if (replicated || service.rollingUpdate) {
        lines.push("      mode: replicated", `      replicas: ${replicated ? service.replicas : 1}`);
    }
    if (limited) {
        lines.push("      resources:", "        limits:");
        if (service.cpus !== undefined) lines.push(`          cpus: "${cpusValue(service.cpus)}"`);
        if (service.memoryMb !== undefined) lines.push(`          memory: ${service.memoryMb}M`);
    }
    if (service.rollingUpdate) {
        lines.push(
            "      update_config:",
            "        order: start-first",
            "        failure_action: rollback",
            "        monitor: 30s",
            "      rollback_config:",
            "        order: start-first"
        );
    }
    return lines;
}

/**
 * A service's `networks:` block: a plain list, or - when it carries aliases - the
 * mapping form, with the aliases on every network it joins. Every one, because
 * whoever reaches the service by name may be on any of them: the edge on the proxy
 * network, the services beside it on their environment's own. The daemon renders
 * the same.
 */
export function serviceNetworkLines(service: Pick<ComposeSpecService, "networks" | "aliases">): string[] {
    if (service.networks.length === 0) return [];
    const aliases = service.aliases ?? [];
    if (aliases.length === 0) return ["    networks:", ...service.networks.map((net) => `      - ${net}`)];
    return [
        "    networks:",
        ...service.networks.flatMap((net) => [
            `      ${net}:`,
            "        aliases:",
            ...aliases.map((alias) => `          - ${yamlQuote(alias)}`)
        ])
    ];
}

/** Build the structured spec for a managed-database deployment. */
export function dbComposeSpec(plan: DbDeployPlan, network: string): ComposeSpec {
    const ports: ComposeSpecPort[] =
        plan.exposePort !== undefined ? [{ host: plan.exposePort, container: defaultDbPort(plan.image) }] : [];
    const networks = joinedNetworks(plan.networks, network);
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
                volumes: [
                    { source: plan.volumeName, target: plan.dataPath, kind: "volume" },
                    ...(plan.extraVolumes ?? []).map((volume) => ({ ...volume }))
                ],
                labels: {},
                networks,
                extraHosts: [HOST_GATEWAY],
                restart: "unless-stopped",
                ...limitFields(plan.limits)
            }
        ],
        volumes: [
            plan.volumeName,
            ...(plan.extraVolumes ?? []).filter((volume) => volume.kind === "volume").map((volume) => volume.source)
        ],
        networks
    };
}

/** A plan's limits as spec fields, leaving out the ones it does not set. */
function limitFields(limits: ResourceLimits | undefined): Pick<ComposeSpecService, "cpus" | "memoryMb"> {
    return {
        ...(limits?.cpus !== undefined ? { cpus: limits.cpus } : {}),
        ...(limits?.memoryMb !== undefined ? { memoryMb: limits.memoryMb } : {})
    };
}

/** The networks a plan names, or the proxy network when it names none. */
function joinedNetworks(planned: readonly string[] | undefined, proxy: string): string[] {
    const named = [...new Set((planned ?? []).filter(Boolean))];
    return named.length > 0 ? named : [proxy];
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
            for (const port of service.ports) {
                const suffix = port.protocol === "udp" ? "/udp" : "";
                lines.push(`      - ${yamlQuote(`${port.host}:${port.container}${suffix}`)}`);
            }
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
        lines.push(...serviceNetworkLines(service));
        if (service.extraHosts && service.extraHosts.length > 0) {
            lines.push("    extra_hosts:");
            for (const entry of service.extraHosts) lines.push(`      - ${yamlQuote(entry)}`);
        }
        if (service.entrypoint && service.entrypoint.length > 0) {
            lines.push(`    entrypoint: [${service.entrypoint.map(yamlQuote).join(", ")}]`);
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
        lines.push(...deployBlockLines(service));
    }
    if (spec.networks.length > 0) {
        lines.push("networks:");
        for (const net of spec.networks) lines.push(`  ${net}:\n    external: true`);
    }
    const external = spec.externalVolumes ?? [];
    if (spec.volumes.length > 0 || external.length > 0) {
        lines.push("volumes:");
        for (const volume of spec.volumes) lines.push(`  ${volume}:`);
        for (const volume of external) lines.push(`  ${volume}:\n    external: true`);
    }
    return `${lines.join("\n")}\n`;
}

function yamlQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
