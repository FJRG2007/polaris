/**
 * RuntimeDriver is the engine abstraction: one interface, two implementations
 * (ComposeRuntime and SwarmRuntime, in later phases), selected per target. Both
 * are written against RuntimePorts, so the same driver code drives the local host
 * (via the host daemon) and remote servers (via SSH). This file is the contract;
 * the implementations and the deploy pipeline that calls them come in P3/P5.
 */

import type { AppEdgeConfig } from "@polaris/core";
import type { BuildInput } from "../builders/types.js";
import type { BuildContext } from "../build-context.js";
import type { RuntimePorts, OutputSink } from "../ports.js";
import type { TraefikDomain, TraefikWaf } from "../traefik.js";

export type RuntimeEngine = "compose" | "swarm";

export interface DeployTargetInfo {
    readonly id: string;
    readonly kind: "local" | "host";
    readonly engine: RuntimeEngine;
    readonly proxyNetwork: string;
    /** Public IP of the target, for building free subdomains (remote only). */
    readonly ip?: string;
}

export interface RuntimeContext {
    readonly ports: RuntimePorts;
    readonly target: DeployTargetInfo;
    /** Append a line to the deployment's streamed log. */
    readonly log: OutputSink;
    /** Produce the build context for a build-from-source deploy. Injected by the
     *  pipeline (which clones the repo), so the runtime and this package stay free
     *  of git/filesystem concerns. Absent for image sources.
     *
     *  It answers with more than the tar because one question can only be settled
     *  once the source is on disk: a workspace has to be built from the repository
     *  root, whatever the service's own root directory says. */
    readonly buildContext?: () => Promise<BuildContext>;
    /**
     * The machine a source build runs on, when it is not the one that runs the
     * service. The image is built and kept there, then carried here (see `ship`).
     * Absent builds where it runs, as every deploy did before.
     */
    readonly builder?: {
        readonly ports: RuntimePorts;
        /** The build machine, as the log names it. */
        readonly name: string;
        /** The machine that runs the service, as the log names it. */
        readonly runsOn: string;
        /** Where the archive waits on its way between the two. */
        readonly stageDir: string;
    };
}

export interface ServiceRef {
    /** Container/service name (also the proxy-network DNS host). */
    readonly name: string;
    /** Compose project the service belongs to. */
    readonly project: string;
}

/** A network filesystem the target must mount before the deploy, so a bind volume
 *  under the mount root (`<mount_root>/<id>/...`) actually resolves onto the NAS.
 *  One mount per storage connection serves every volume/service that binds under it. */
export interface MountTarget {
    /** Storage connection id; also the subdir under the mount root it mounts at. */
    readonly id: string;
    readonly kind: "smb" | "nfs";
    /** `//host/share` for smb, `host:/export` for nfs. */
    readonly source: string;
    readonly options?: string;
    readonly username?: string;
    readonly password?: string;
}

export interface AppDeployPlan {
    readonly ref: ServiceRef;
    readonly build: BuildInput;
    /** NAS mounts to establish on the target before bringing the service up. */
    readonly mounts?: readonly MountTarget[];
    /** Runtime environment (already merged from EnvVars, secrets decrypted). */
    readonly env: Readonly<Record<string, string>>;
    readonly replicas: number;
    /** The networks this service joins in place of the proxy network alone, from
     *  `serviceNetworks`. Absent or empty means the proxy network, which is what
     *  every service joined before an environment could keep its own. */
    readonly networks?: readonly string[];
    /** External networks this service joins beyond the proxy network. The messaging
     *  hub uses it to join the control-plane's default network so it can reach the
     *  web's inbound ingest directly; empty for a normal app. Each must already
     *  exist on the target (compose declares them external). */
    readonly extraNetworks?: readonly string[];
    readonly domains: readonly TraefikDomain[];
    /** Resolved WAF rules to materialize into this service's edge labels (allowlist
     *  + denylist + require-login). Omitted when the service has no WAF rules. */
    readonly waf?: TraefikWaf;
    /** Host port to publish so the app is reachable directly over the host's IP
     *  (LAN/intranet), independent of any reverse proxy. `container` is the port
     *  the app listens on inside the container. */
    readonly expose?: { readonly host: number; readonly container: number; readonly protocol?: "tcp" | "udp" };
    /**
     * Keep the service off every interface of the host: its port is not published at
     * all, and the edge reaches it by name on the proxy network instead. `expose` still
     * says which port the app listens on inside the container - that is what the edge
     * dials - but nothing outside Docker can open it.
     */
    readonly private?: boolean;
    /**
     * A second name the container answers to on the proxy network: the service's
     * own, carried by a release that runs beside the one it replaces. Everything that
     * reaches the service by that name - the edge, a tunnel, another service - goes
     * on reaching it while the container behind it changes.
     */
    readonly alias?: string;
    /** Rate limits, concurrency, security headers, redirects and rewrites, written into
     *  the edge labels beside the WAF so a remote server's own edge applies them. */
    readonly edge?: AppEdgeConfig;
    /** Further ports to publish beside the main one. A Java Minecraft server that
     *  Bedrock clients can also join answers on a second, UDP port - one service,
     *  two doors, so it cannot be modelled as the single exposed port. */
    readonly extraPorts?: readonly { readonly host: number; readonly container: number; readonly protocol?: "tcp" | "udp" }[];
    /** True when `expose.container` is a fallback guess (the user did not pin a
     *  port), so the runtime may refine it from the image's own exposed port. */
    readonly autoContainerPort?: boolean;
    /** Named volumes / binds to attach: mountPath -> source. `nas` is a bind
     *  confined under the storage mount root (`<connectionId>/<subpath>`). */
    readonly volumes: readonly {
        readonly mountPath: string;
        readonly source: string;
        readonly kind: "volume" | "bind" | "nas";
    }[];
    /** JSON healthcheck spec (or null for none). */
    readonly healthcheck?: HealthcheckSpec;
    /** The most CPU (cores) and memory (MB) the container may use. Absent is no
     *  limit. */
    readonly limits?: ResourceLimits;
    /** Arguments that replace the image's own command, handed over as they are
     *  rather than through a shell. Absent runs what the image says. */
    readonly command?: readonly string[];
}

/** Resource ceilings for one container. */
export interface ResourceLimits {
    readonly cpus?: number;
    readonly memoryMb?: number;
}

export interface HealthcheckSpec {
    readonly test: readonly string[];
    readonly intervalSeconds?: number;
    readonly retries?: number;
    readonly startPeriodSeconds?: number;
}

export interface DbDeployPlan {
    readonly ref: ServiceRef;
    readonly image: string;
    readonly env: Readonly<Record<string, string>>;
    /** Entrypoint arguments, for an engine whose image takes its configuration
     *  there rather than from the environment. */
    readonly command?: readonly string[];
    readonly volumeName: string;
    readonly dataPath: string;
    readonly exposePort?: number;
    /** The networks the database joins in place of the proxy network, as for an
     *  application. Absent or empty means the proxy network. */
    readonly networks?: readonly string[];
    /** Further mounts beside the data volume. A PostgreSQL instance with
     *  point-in-time recovery mounts its archive folder here - a host folder
     *  confined under the volume root, which a recovered instance can mount too. */
    readonly extraVolumes?: readonly {
        readonly source: string;
        readonly target: string;
        readonly kind: "bind" | "volume";
    }[];
    /** The most CPU (cores) and memory (MB) the container may use. Absent is no
     *  limit. */
    readonly limits?: ResourceLimits;
    /**
     * A Redis Cluster: one container per node in place of the single one, each
     * with its own command and data volume, on the same networks, and none
     * published on the host. The first node carries `ref.name`, so everything
     * that asks for the database's container finds one. `command` and
     * `volumeName` above are then unused.
     */
    readonly nodes?: readonly DbNodePlan[];
}

/** One node of a clustered database. */
export interface DbNodePlan {
    readonly name: string;
    readonly command: readonly string[];
    readonly volumeName: string;
}

export interface DeployResult {
    readonly ok: boolean;
    readonly imageTag?: string;
    readonly error?: string;
    /**
     * The container port read from the image, when it differed from the one the plan
     * guessed. Handed back so the caller can store it: a service kept off the host's
     * interfaces is dialled by the edge on exactly this port, and a guess left in the
     * route is a 502 with a healthy container behind it.
     */
    readonly detectedPort?: { readonly from: number; readonly to: number };
}

export interface RuntimeStatus {
    readonly state: string;
    readonly health?: string;
    readonly replicas?: { readonly running: number; readonly desired: number };
}

export interface RuntimeDriver {
    readonly engine: RuntimeEngine;
    ensureNetwork(name: string, ctx: RuntimeContext): Promise<void>;
    deployApplication(plan: AppDeployPlan, ctx: RuntimeContext): Promise<DeployResult>;
    deployDatabase(plan: DbDeployPlan, ctx: RuntimeContext): Promise<DeployResult>;
    stop(ref: ServiceRef, ctx: RuntimeContext): Promise<void>;
    remove(ref: ServiceRef, ctx: RuntimeContext): Promise<void>;
    scale(ref: ServiceRef, replicas: number, ctx: RuntimeContext): Promise<void>;
    rollback(ref: ServiceRef, toImageTag: string, ctx: RuntimeContext): Promise<void>;
    status(ref: ServiceRef, ctx: RuntimeContext): Promise<RuntimeStatus>;
}
