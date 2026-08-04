/**
 * @polaris/deploy - the deploy engine. Pure, Docker-free building blocks (naming,
 * free subdomains, Traefik labels, builders) plus the interfaces the runtime
 * drivers and the local/remote execution seam are written against. Runtime
 * implementations (compose/swarm drivers, the deploy pipeline) build on these.
 */

export { slugify, shortHash, serviceName, imageTag } from "./naming.js";
export { magicDomain, releaseDomain, isMagicBase, DEFAULT_SUBDOMAIN_BASE } from "./subdomain.js";
export {
    defaultZones,
    isBaseDomain,
    isZoneLabel,
    namedZoneHostname,
    normalizeBaseDomain,
    normalizeZoneName,
    pickZone,
    randomLabel,
    randomZoneHostname,
    zoneHost,
    zoneHostname,
    zoneWildcard,
    DEPLOY_ZONE_LABEL,
    POLARIS_ZONE_LABEL,
    type DomainZone,
    type ZoneScope
} from "./zones.js";
export { quoteArg, quoteArgv } from "./shell.js";
export { traefikLabels, configHash, type TraefikDomain, type CertResolver, type TraefikServiceInput, type TraefikWaf } from "./traefik.js";
export {
    buildSpec,
    buildCommand,
    normalizeRoot,
    resolveDockerfilePath,
    DEFAULT_BUILDPACKS_BUILDER,
    DEFAULT_DOCKERFILE,
    type BuildMethod,
    type BuildInput,
    type BuildSpec
} from "./builders/index.js";
export { parseWatchPaths, shouldDeployForPaths } from "./watch-paths.js";
export type {
    RuntimePorts,
    OutputSink,
    BuildRequest,
    ExecResult,
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
    HealthcheckSpec,
    MountTarget
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
export { parseHttpLogs, bucketHttpMetrics, type HttpLogEntry, type HttpMetricPoint } from "./http-logs.js";
export { detectBuild, type DetectedBuild, type PackageManifest, type RepoSnapshot } from "./detect.js";
export { nixpacksConfig, type NixpacksConfig } from "./nixpacks.js";
export { INSTALL_ENV } from "./install-env.js";
export { generateDockerfile, GENERATED_DOCKERFILE, type DockerfilePlan } from "./dockerfile.js";
export type { BuildContext } from "./build-context.js";
