/**
 * The VPN's ids, its stored settings, and the rules every screen and action of
 * it reads: who sees which devices, and what a browser registration id looks
 * like. Pure, so the rules are asserted in tests rather than read off a screen.
 */

import { z } from "zod";

/** The app people install: the screens, and the settings on its install row. */
export const VPN_APP = "vpn";
/** The control server, which exists only between Turn on and Turn off. */
export const VPN_ENGINE_APP = "vpn-engine";
/** The port Headscale listens on inside its container. */
export const VPN_PORT = 8080;
/** The subdomain the control server is offered under in a zone. */
export const DEFAULT_SUBDOMAIN = "vpn";
/**
 * The suffix every device's MagicDNS name ends in (`laptop.vpn.internal`).
 *
 * `.internal` is the top-level name ICANN reserved for private use, so it never
 * collides with a real domain - and Headscale refuses a base domain that the
 * control server's own hostname sits under, which a name in the operator's zone
 * could be.
 */
export const DEFAULT_BASE_DOMAIN = "vpn.internal";

/** The settings as they live on the app's install row, key `vpn`. Every field
 *  has a default, so a row written by an older Polaris reads whole. */
export const vpnSettingsSchema = z.object({
    /** The hostname the control server answers on, once it has one. */
    hostname: z.string().trim().min(1).max(253).nullable().catch(null),
    baseDomain: z
        .string()
        .trim()
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/)
        .catch(DEFAULT_BASE_DOMAIN),
    /** The Headscale API key, sealed with the master key. */
    apiKey: z.string().min(1).nullable().catch(null)
});
export type VpnSettings = z.infer<typeof vpnSettingsSchema>;

export function readVpnSettings(stored: unknown): VpnSettings {
    const parsed = vpnSettingsSchema.safeParse(stored ?? {});
    return parsed.success
        ? parsed.data
        : { hostname: null, baseDomain: DEFAULT_BASE_DOMAIN, apiKey: null };
}

/**
 * A browser registration id, exactly as Headscale v0.29.6 mints them
 * (hscontrol/types/common.go): the prefix `hskey-authreq-` and 24 characters of
 * URL-safe base64. Checked before it reaches a URL or the API.
 */
export const authIdSchema = z
    .string()
    .trim()
    .regex(/^hskey-authreq-[A-Za-z0-9_-]{24}$/);

/** A device name as Headscale accepts one for `given_name`: a DNS label. */
export const deviceNameSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);

/**
 * The Headscale user a Polaris account signs devices in as. Derived from the
 * account id, never the name or email, so renaming an account never moves its
 * devices and two people with the same name never share one. Headscale wants a
 * name that starts with a letter and holds letters, digits and dashes.
 */
export function headscaleUserName(userId: string): string {
    return `polaris-${userId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

/** Who a device list is for: an administrator sees every device, anybody else
 *  their own. */
export interface VpnViewer {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** Whether `viewer` may see or change a device signed in as `ownerName`. */
export function mayManageDevice(viewer: VpnViewer, ownerName: string): boolean {
    return viewer.isAdmin || ownerName === headscaleUserName(viewer.id);
}

/** Whether `viewer` may turn the VPN on or off, or move its hostname. */
export function mayOperate(viewer: VpnViewer): boolean {
    return viewer.isAdmin;
}

/** Whether `viewer` may approve a device's exit node or subnet routes. With no
 *  access policy yet an approved route serves every device on the tailnet, so
 *  this is an administrator's call. */
export function mayApproveRoutes(viewer: VpnViewer): boolean {
    return viewer.isAdmin;
}

/** The routes that make a device an exit node: everything, on both families. */
export const EXIT_ROUTES = ["0.0.0.0/0", "::/0"] as const;

export function isExitRoute(route: string): boolean {
    return (EXIT_ROUTES as readonly string[]).includes(route);
}
