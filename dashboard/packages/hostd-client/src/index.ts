/**
 * @polaris/hostd-client - the typed bridge to the privileged host daemon. Use
 * HostdClient for direct calls (health, mounts) and the capabilities helpers to
 * keep the shared edition state current.
 */

export { HostdClient, type MountSpec, type MountResult } from "./client.js";
export { refreshCapabilities, startCapabilityRefresh } from "./capabilities.js";
