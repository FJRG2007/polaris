/**
 * @polaris/sdk - start, prompt and follow Polaris agent sessions from code.
 * `createPolarisClient` is the client; the schemas are the ones the routes
 * parse with, for a caller that wants to validate on its own side too.
 */

export { createPolarisClient, PolarisApiError, type EventsOptions, type PolarisClient, type PolarisClientOptions } from "./client.js";
export { readSse, type SseMessage, type SseReader } from "./sse.js";
export * from "./schemas.js";
