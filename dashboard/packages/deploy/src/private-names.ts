/**
 * Private names: what a service is called by the services beside it.
 *
 * Every service answers to `<name>.polaris.internal` and to the bare `<name>`
 * inside its project's environment, the way Railway's `<service>.railway.internal`
 * does, plus any extra names its owner adds. The names ride on a names network
 * (see `networks.ts`) that only the environment's own services join, so nothing
 * outside the environment can resolve them and no name a person picks can stand
 * in for one Polaris's own containers look up.
 *
 * And it can be called without its port. `http://api.polaris.internal` reaches
 * a service listening on 3000 through a forwarder that shares the service's own
 * network namespace and answers port 80 there, so the name still resolves to the
 * service itself and `:3000` keeps working too. It runs on the target beside the
 * service, so nothing about it depends on Polaris being up.
 *
 * Pure: the specs are built here and validated again by the daemon.
 */

import { isNamesNetwork } from "./networks.js";
import type { ComposeSpec, ComposeSpecService } from "./compose-spec.js";

/** The domain every private name sits under. */
export const PRIVATE_DOMAIN_SUFFIX = "polaris.internal";

/**
 * The image the port-80 forwarder runs: socat on Alpine, pinned to the digest of
 * its 1.8.1.3 release so a moved tag can never change what runs beside a service.
 */
export const FORWARDER_IMAGE =
    "alpine/socat:1.8.1.3@sha256:5ffbd6ae916cbad86a58fabe0d6d5a6fd5c2b47ddf031e82996baac9300e732f";

/** The port the forwarder answers on. */
export const PORTLESS_PORT = 80;

/** `<name>.polaris.internal`. */
export function privateDomain(name: string): string {
    return `${name}.${PRIVATE_DOMAIN_SUFFIX}`;
}

/** The name a service is called by from another project it is linked to:
 *  `<name>.<project>.polaris.internal`. */
export function crossProjectDomain(name: string, projectSlug: string): string {
    return `${name}.${projectSlug}.${PRIVATE_DOMAIN_SUFFIX}`;
}

/** The names a service answers to on its own names network: the full one and
 *  the bare one for its name, then each extra name the same two ways. */
export function namesFor(name: string, extra: readonly string[] = []): string[] {
    return [...new Set([name, ...extra].flatMap((one) => [privateDomain(one), one]))];
}

/** Longest container name DNS (and docker) will take. */
const MAX_NAME = 63;

/** The forwarder's container name: the service's own, cut to fit, then `-p80`. */
export function forwarderName(serviceName: string): string {
    const suffix = `-p${PORTLESS_PORT}`;
    return `${serviceName.slice(0, MAX_NAME - suffix.length)}${suffix}`;
}

/**
 * The forwarder's script. One listener per address family - the IPv6 one is
 * best effort, since a container on an IPv4-only network has no IPv6 to bind -
 * both sending to the service on the loopback it shares with it.
 *
 * And it ends itself when the namespace it joined is gone. A service that
 * restarts gets a new namespace, while the forwarder would go on holding the old
 * one, which leads nowhere: so it exits once its listener dies or nothing but
 * loopback is left, and the restart policy brings it back inside the new one.
 */
export function forwarderScript(port: number): string {
    const target = `TCP4:127.0.0.1:${port}`;
    return [
        `socat TCP4-LISTEN:${PORTLESS_PORT},fork,reuseaddr ${target} & pid=$!`,
        `socat TCP6-LISTEN:${PORTLESS_PORT},fork,reuseaddr,ipv6only=1 ${target} 2>/dev/null &`,
        "while sleep 15; do kill -0 $pid 2>/dev/null || exit 1; ls /sys/class/net | grep -qv '^lo$' || exit 1; done"
    ].join(" ");
}

/** The forwarder service for one copy of a service. */
export function forwarderService(serviceName: string, port: number): ComposeSpecService {
    return {
        name: forwarderName(serviceName),
        image: FORWARDER_IMAGE,
        pullPolicy: "missing",
        env: {},
        ports: [],
        volumes: [],
        labels: {},
        networks: [],
        networkMode: `service:${serviceName}`,
        entrypoint: ["sh", "-c"],
        command: [forwarderScript(port)],
        dependsOn: [serviceName],
        restart: "unless-stopped",
        cpus: 0.25,
        memoryMb: 32
    };
}

/**
 * A compose spec with a forwarder beside every copy of the service that carries
 * private names, sending port 80 on to `port` - unless the service listens on 80
 * itself. Plain compose only: a swarm task cannot share another's namespace.
 */
export function withPortForwarders(spec: ComposeSpec, port: number | undefined): ComposeSpec {
    if (port === undefined || port === PORTLESS_PORT) return spec;
    const forwarded = spec.services.filter(
        (service) => !service.networkMode && Object.keys(service.networkAliases ?? {}).some(isNamesNetwork)
    );
    if (forwarded.length === 0) return spec;
    return { ...spec, services: [...spec.services, ...forwarded.map((service) => forwarderService(service.name, port))] };
}
