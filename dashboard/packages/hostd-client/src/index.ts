/**
 * @polaris/hostd-client - the typed bridge to the privileged host daemon. Use
 * HostdClient for direct calls (health, mounts) and the capabilities helpers to
 * keep the shared edition state current.
 */

export {
    HostdClient,
    type HostdSnmpSource,
    type HostdUpsDevice,
    type HostdUpsList,
    type HostdUpsReading,
    type HostdUpsRwVar,
    type HostdUpsNetserver,
    type MountResult,
    type MountSpec
} from "./client.js";
export { refreshCapabilities, startCapabilityRefresh } from "./capabilities.js";
