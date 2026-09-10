/**
 * @polaris/deploy - the deploy engine. Pure, Docker-free building blocks (naming,
 * free subdomains, Traefik labels, builders) plus the interfaces the runtime
 * drivers and the local/remote execution seam are written against. Runtime
 * implementations (compose/swarm drivers, the deploy pipeline) build on these.
 */

export { slugify, shortHash, serviceName, imageTag } from "./naming.js";
export {
    RELEASE_LABEL,
    RELEASE_REPOSITORY,
    isReleaseImage,
    pinDockerfile,
    releaseImage,
    singleFileTar
} from "./release-image.js";
export { RELEASE_IMAGE_GONE } from "./runtime/release.js";
export { MAX_SHIPPED_BYTES, shipImage } from "./runtime/ship.js";
export { archiveImageTags, manifestTags } from "./image-archive.js";
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
export { traefikLabels, configHash, STICKY_COOKIE, type TraefikDomain, type CertResolver, type TraefikServiceInput, type TraefikWaf } from "./traefik.js";
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
    expandReplicas,
    forCompose,
    replicaNames,
    composeValue,
    renderComposeYaml,
    type ComposeSpec,
    type ComposeSpecService,
    type ComposeSpecPort,
    type ComposeSpecVolume,
    type ComposeSpecHealth
} from "./compose-spec.js";
export {
    NETWORK_MODES,
    PRIVATE_NETWORK_LABEL,
    PRIVATE_NETWORK_PREFIX,
    REMOTE_EDGE_CONTAINERS,
    ensurePrivateNetworksScript,
    environmentNetwork,
    fallbackSubnet,
    isPrivateNetwork,
    joinsProxy,
    linksOfLayout,
    privateNetworksOf,
    serviceNetwork,
    serviceNetworks,
    type NetworkMode,
    type NetworkPlanInput,
    type ServiceLink
} from "./networks.js";
export { ComposeRuntime } from "./runtime/compose.js";
export { mountFailureReason } from "./mount-failure.js";
export { deployFailureReason, isOutOfSpace, parseReclaimedBytes } from "./deploy-failure.js";
export { SwarmRuntime } from "./runtime/swarm.js";
export { parseContainerState, type ContainerState } from "./runtime/status.js";
export { onboardingScript, DYNAMIC_DIR, type OnboardingOptions } from "./onboarding.js";
export { parseHttpLogs, bucketHttpMetrics, type HttpLogEntry, type HttpMetricPoint } from "./http-logs.js";
export { detectBuild, type DetectedBuild, type DetectOptions, type PackageManifest, type RepoSnapshot } from "./detect.js";
export { detectLanguageBuild, LANGUAGE_FILES, procfileWeb } from "./detect-languages.js";
export { diagnoseDeploy, type DeployFix, type Diagnosis, type DiagnoseContext } from "./diagnose.js";
export {
    CONFIG_FILES,
    importDeployConfig,
    importedAnything,
    type ConfigFile,
    type ImportedConfig,
    type PickedSetting
} from "./config-import.js";
export { nixpacksConfig, type NixpacksConfig } from "./nixpacks.js";
export { INSTALL_ENV } from "./install-env.js";
export { generateDockerfile, GENERATED_DOCKERFILE, type DockerfilePlan } from "./dockerfile.js";
export type { BuildContext } from "./build-context.js";
