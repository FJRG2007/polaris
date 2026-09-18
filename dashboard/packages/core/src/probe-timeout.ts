/**
 * How long a port probe waits for an answer.
 *
 * Its own module because the probe around it opens sockets and asks the network
 * service where this Polaris is, and this is a number - read while drawing a
 * screen, and by the installable apps, which import it from here.
 */

/** How long to wait on a port before calling the probe inconclusive. */
export const PROBE_TIMEOUT_MS = 4000;
