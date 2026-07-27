/**
 * How an app's OpenTunnel hostname is built. Derived rather than stored, so the
 * published URL is knowable before the tunnel is up and cannot drift from what the
 * sidecar actually asked the tunnel server for. Pure.
 */

import { shortHash, slugify } from "@polaris/deploy";
import type { OpenTunnelConfig } from "../integrations/registry";

/** The subdomain requested from the tunnel server: stable per app, and distinct even
 *  when two apps carry the same name. */
export function openTunnelSubdomain(appId: string, name: string): string {
    return `${slugify(name) || "app"}-${shortHash(appId, 6)}`.slice(0, 63);
}

/** The public hostname a subdomain becomes on the configured server. An empty base
 *  path is valid: the server then publishes on the domain itself. */
export function openTunnelHostname(subdomain: string, config: OpenTunnelConfig): string {
    return config.basePath ? `${subdomain}.${config.basePath}.${config.domain}` : `${subdomain}.${config.domain}`;
}
