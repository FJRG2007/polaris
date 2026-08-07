/**
 * The address the edge dials a locally deployed app on.
 *
 * Every app publishes a stable host port, and the edge reaches it over the host - so
 * the only question is which address stands for "this host" from inside the Docker
 * network. It used to be the box's LAN address, and that answer is wrong in a way
 * that only shows up later: the address is DHCP-assigned, it is detected once and
 * stored, and on a machine with more than one interface it can be the wireless one.
 * When that lease moves or that link drops, every deployed domain on the instance
 * answers 502 with a perfectly healthy container behind it, and it comes back on its
 * own the moment the interface does - which reads as a flapping app rather than a
 * routing address that was never stable.
 *
 * So the edge is given a name for the host instead, resolved through the
 * `host-gateway` entry compose grants it. The name and the containers that resolve it
 * are configured from the same file, which is what keeps them in step.
 *
 * The LAN address remains the fallback, for an instance whose compose predates the
 * variable. It is read live rather than from the value stored at install (see
 * `getPublicIp`), so even then it follows the machine.
 */

import { getPublicIp } from "../domain-service";

/**
 * The host address to write into an app's edge route, or null when none is known -
 * then the caller leaves routing as it is rather than publishing a route to nowhere.
 */
export async function localDialHost(): Promise<string | null> {
    const configured = (process.env.POLARIS_APP_DIAL_HOST ?? "").trim();
    if (configured) return configured;
    return getPublicIp();
}

/**
 * The edge as a sidecar on the proxy network reaches it.
 *
 * A tunnel connector forwards to Traefik rather than straight to an app, so that its
 * traffic is routed and logged like any other request. It runs on the proxy network
 * the edge is on, so it can address the edge container by name - and for the same
 * reason as above, that is what it should do: a connector pointed at the box's LAN
 * address stops forwarding the moment that address changes, and a tunnel that has to
 * be recreated to learn a new one is a public URL that quietly dies.
 */
export function edgeOrigin(): string {
    return process.env.POLARIS_EDGE_ORIGIN ?? "http://traefik:80";
}

/**
 * The same edge as a bare `host:port`, for a connector that is configured with an
 * address rather than a URL. Derived from the origin so there is one value to set.
 *
 * The port is spelled out even when it is the scheme's own: `URL` drops a default
 * port, and a connector handed a bare hostname forwards to whatever it assumes.
 */
export function edgeAddress(): string {
    const url = new URL(edgeOrigin());
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}
