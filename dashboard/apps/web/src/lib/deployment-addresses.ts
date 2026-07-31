/**
 * Every address this Polaris answers on.
 *
 * The question "where can I reach it from" has four answers at once and they
 * live in four places: the URL the deployment was installed with, the local
 * network name the mDNS responder advertises, the domains an operator configured
 * (which the edge is told to route), and a tunnel, when one is up. Nowhere in the
 * dashboard put them together, so Settings could only show the first and an
 * operator had no list of the names their own deployment answers to.
 *
 * This is deliberately the same set the auth layer trusts as origins: an address
 * that can be signed in on is an address Polaris is reachable at, and a list that
 * said otherwise would be worse than none.
 */

import { loadEnv } from "@polaris/config";
import { dashboardHosts, publicHostname } from "@/lib/domain-edge";
import { getPolarisPublicUrl } from "@/lib/polaris-tunnel-service";

/** What kind of address this is, which is what tells an operator where it works. */
export type AddressKind = "app" | "local" | "domain" | "tunnel";

export interface DeploymentAddress {
    readonly url: string;
    readonly host: string;
    readonly kind: AddressKind;
}

/** Its hostname, for de-duplicating URLs that differ only in scheme or a slash. */
function hostOf(url: string): string | null {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * The addresses, in the order an operator wants them: the one they installed
 * with first, then the local name, the configured domains, and a tunnel last -
 * it is the least permanent of them.
 *
 * Best-effort by design. The domain list and the tunnel both reach out of the
 * process, and a settings page that fails to render because a tunnel daemon is
 * busy would be a worse outcome than a short list.
 */
export async function reachableAddresses(): Promise<DeploymentAddress[]> {
    const env = loadEnv();
    const [domains, tunnel] = await Promise.all([
        dashboardHosts().catch(() => [] as string[]),
        getPolarisPublicUrl().catch(() => null)
    ]);

    const found: DeploymentAddress[] = [];
    const seen = new Set<string>();
    const add = (url: string, kind: AddressKind): void => {
        const host = hostOf(url);
        if (!host || seen.has(host)) return;
        seen.add(host);
        found.push({ url: url.replace(/\/+$/, ""), host, kind });
    };

    add(env.POLARIS_APP_URL, "app");
    // The name the responder advertises on the LAN. Plain HTTP: the certificate
    // for it is the internal one, and offering https first would send everyone
    // through a browser warning to reach their own dashboard.
    add(`http://${env.POLARIS_LOCAL_HOSTNAME}.local`, "local");
    for (const domain of domains) add(`https://${domain}`, "domain");
    const tunnelHost = publicHostname(tunnel);
    if (tunnelHost) add(`https://${tunnelHost}`, "tunnel");

    return found;
}
