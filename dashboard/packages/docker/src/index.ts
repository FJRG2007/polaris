/**
 * @polaris/docker - the modular Docker Engine connector. Import the connection
 * schemas, the driver, and the registry from here. New transports are added
 * under ./transports and wired into the registry without changing the driver the
 * Containers app depends on.
 */

export * from "./schema.js";
export * from "./driver.js";
export { createDockerDriver, type DockerConnectionRecord } from "./registry.js";
export type { DockerTransportConn } from "./transports.js";
