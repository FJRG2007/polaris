/**
 * Signing in on this machine's own address on the local network.
 *
 * On unless an administrator turned it off. Sign-in used to be accepted only on
 * the addresses Polaris is configured to answer on (`POLARIS_APP_URL`,
 * `polaris.local`, the domains), so a browser that typed the machine's IP - the
 * natural thing to do when `polaris.local` does not resolve on that device - was
 * refused by the origin check, and the switch that allowed it sat behind the
 * very sign-in it refused. The machine's own private IPv4 addresses join that
 * list, and only those: `getHostLanIps` reads what the mDNS responder publishes
 * and keeps private addresses only, so a public IP or another machine's address
 * never becomes a trusted origin through this. They are as much this machine as
 * `polaris.local` and `127.0.0.1`, which were always trusted.
 *
 * Switched from Admin > Domains, or from the host with `polaris lan-access`.
 * Both write this one setting.
 */

import { isLocalAddress } from "@polaris/core";
import { getHostLanIps } from "@/lib/host-address";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The setting; the CLI writes the same key. "off" when refused; absent (or the
 *  "on" an earlier version wrote) when allowed. */
export const LAN_SIGN_IN_KEY = "auth.lanSignIn";

export interface LanSignInView {
    readonly enabled: boolean;
    /** This machine's private addresses, the ones sign-in is accepted on when on. */
    readonly addresses: readonly string[];
}

export async function lanSignInEnabled(): Promise<boolean> {
    return (await getSetting(LAN_SIGN_IN_KEY)) !== "off";
}

export async function setLanSignIn(enabled: boolean): Promise<void> {
    await setSetting(LAN_SIGN_IN_KEY, enabled ? "on" : "off");
}

export async function lanSignInView(): Promise<LanSignInView> {
    const [enabled, addresses] = await Promise.all([lanSignInEnabled(), getHostLanIps()]);
    return { enabled, addresses };
}

/**
 * The private address a request was sent to, as its `Host` header names it
 * (`192.168.1.20`, or with a port), or null for a name or a public address.
 *
 * Needed beside the responder's list because an install without the responder
 * (Docker Desktop restricts host networking, which is also why `polaris.local`
 * does not open there) never learns its own address, and that is exactly the
 * install whose people type the IP. Trusting it is no wider than the list: the
 * origin check compares this with the `Origin` the browser sent, and a browser
 * sends a private IP as the origin only for a page served from that same
 * address and port - the one the request reached, which is this server. A page
 * on another machine, or on another port here, carries its own address.
 */
export function requestLanHost(request: Request | undefined): string | null {
    const host = request?.headers.get("host")?.trim().toLowerCase() ?? "";
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(host);
    if (!match || !isLocalAddress(match[1] ?? "")) return null;
    const port = match[2] === undefined ? null : Number(match[2]);
    if (port !== null && (port < 1 || port > 65535)) return null;
    return host;
}

/** The hosts to trust for sign-in on account of this setting: none while off. */
export async function lanSignInHosts(request?: Request): Promise<string[]> {
    if (!(await lanSignInEnabled())) return [];
    const own = requestLanHost(request);
    const listed = await getHostLanIps();
    return own && !listed.includes(own) ? [...listed, own] : listed;
}
