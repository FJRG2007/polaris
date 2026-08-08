/**
 * RuntimeDriver is the engine abstraction: one interface, two implementations
 * (ComposeRuntime and SwarmRuntime, in later phases), selected per target. Both
 * are written against RuntimePorts, so the same driver code drives the local host
 * (via the host daemon) and remote servers (via SSH). This file is the contract;
 * the implementations and the deploy pipeline that calls them come in P3/P5.
 */

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
}

export interface DeployResult {
    readonly ok: boolean;
    readonly imageTag?: string;
    readonly error?: string;
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
