/**
 * @polaris/deploy - the deploy engine. Pure, Docker-free building blocks (naming,
 * free subdomains, Traefik labels, builders) plus the interfaces the runtime
 * drivers and the local/remote execution seam are written against. Runtime
 * implementations (compose/swarm drivers, the deploy pipeline) build on these.
 */

export { slugify, shortHash, serviceName, imageTag } from "./naming.js";
export { magicDomain, isMagicBase, DEFAULT_SUBDOMAIN_BASE } from "./subdomain.js";
export { quoteArg, quoteArgv } from "./shell.js";
export { traefikLabels, configHash, type TraefikDomain, type CertResolver, type TraefikServiceInput } from "./traefik.js";
export {
    buildSpec,
    buildCommand,
    DEFAULT_BUILDPACKS_BUILDER,
    DEFAULT_DOCKERFILE,
    type BuildMethod,
    type BuildInput,
    type BuildSpec
} from "./builders/index.js";
export type {
    RuntimePorts,
    OutputSink,
    BuildRequest,
    ExecSpec,
    ExecStream,
    LogOptions
} from "./ports.js";
export type {
    RuntimeDriver,
    RuntimeEngine,
    RuntimeContext,
    DeployTargetInfo,
    ServiceRef,
    AppDeployPlan,
    DbDeployPlan,
    DeployResult,
    RuntimeStatus,
    HealthcheckSpec
} from "./runtime/driver.js";
export {
    appComposeSpec,
    dbComposeSpec,
    defaultDbPort,
    renderComposeYaml,
    type ComposeSpec,
    type ComposeSpecService,
    type ComposeSpecPort,
    type ComposeSpecVolume,
    type ComposeSpecHealth
} from "./compose-spec.js";
export { ComposeRuntime } from "./runtime/compose.js";
export { SwarmRuntime } from "./runtime/swarm.js";
export { parseContainerState, type ContainerState } from "./runtime/status.js";
export { onboardingScript, type OnboardingOptions } from "./onboarding.js";
export { parseHttpLogs, type HttpLogEntry } from "./http-logs.js";
