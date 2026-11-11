/**
 * Signing in on this machine's own address on the local network.
 *
 * Off by default. Sign-in is accepted only on the addresses Polaris is
 * configured to answer on (`POLARIS_APP_URL`, `polaris.local`, the domains), so
 * a browser that typed the machine's IP - the natural thing to do when
 * `polaris.local` does not resolve on that device - was refused by the origin
 * check. Switched on, the machine's own private IPv4 addresses join that list,
 * and only those: `getHostLanIps` reads what the mDNS responder publishes and
 * keeps private addresses only, so a public IP or another machine's address
 * never becomes a trusted origin through this.
 *
 * Switched from Admin > Domains, or from the host with `polaris lan-access on`
 * for an operator who cannot sign in at all yet. Both write this one setting.
 */

import { getHostLanIps } from "@/lib/host-address";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The setting; the CLI writes the same key. "on" when allowed, absent when not. */
export const LAN_SIGN_IN_KEY = "auth.lanSignIn";

export interface LanSignInView {
    readonly enabled: boolean;
    /** This machine's private addresses, the ones sign-in is accepted on when on. */
    readonly addresses: readonly string[];
}

export async function lanSignInEnabled(): Promise<boolean> {
    return (await getSetting(LAN_SIGN_IN_KEY)) === "on";
}

export async function setLanSignIn(enabled: boolean): Promise<void> {
    await setSetting(LAN_SIGN_IN_KEY, enabled ? "on" : null);
}

export async function lanSignInView(): Promise<LanSignInView> {
    const [enabled, addresses] = await Promise.all([lanSignInEnabled(), getHostLanIps()]);
    return { enabled, addresses };
}

/** The hosts to trust for sign-in on account of this setting: none while off. */
export async function lanSignInHosts(): Promise<string[]> {
    return (await lanSignInEnabled()) ? getHostLanIps() : [];
}
