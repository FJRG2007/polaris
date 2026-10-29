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
    apiKey: z.string().min(1).nullable().catch(null),
    /** Whether the control server should be running. Off keeps its database,
     *  so the devices on it sign back in when it is turned on again. */
    enabled: z.boolean().catch(false)
});
export type VpnSettings = z.infer<typeof vpnSettingsSchema>;

export function readVpnSettings(stored: unknown): VpnSettings {
    const parsed = vpnSettingsSchema.safeParse(stored ?? {});
    return parsed.success
        ? parsed.data
        : { hostname: null, baseDomain: DEFAULT_BASE_DOMAIN, apiKey: null, enabled: false };
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

/** The account a Headscale user stands for, or null for a user Polaris did not
 *  make. Account ids are lowercase UUIDs, so `headscaleUserName` keeps them
 *  whole and this reads them back. */
const POLARIS_USER = /^polaris-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function accountIdOf(userName: string): string | null {
    return POLARIS_USER.exec(userName)?.[1] ?? null;
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

/** Whether `viewer` may approve a device's exit node or subnet routes. The
 *  access policy lets every user through an approved exit node (`vpnPolicy`),
 *  so approving one is an administrator's call. */
export function mayApproveRoutes(viewer: VpnViewer): boolean {
    return viewer.isAdmin;
}

/** The routes that make a device an exit node: everything, on both families. */
export const EXIT_ROUTES = ["0.0.0.0/0", "::/0"] as const;

export function isExitRoute(route: string): boolean {
    return (EXIT_ROUTES as readonly string[]).includes(route);
}

/** The tag a Polaris server signs in with, which every user may reach. */
export const POLARIS_TAG = "tag:polaris";

/**
 * The tailnet's access policy, as Headscale reads it in database mode (HuJSON;
 * plain JSON is a subset). Pure, so what each person reaches is asserted in a
 * test rather than found out on a device.
 *
 * - every user reaches their own devices (`autogroup:self`) and nobody else's;
 * - administrators reach every device and every approved subnet route;
 * - a Polaris server (tagged `tag:polaris`) is reachable by everybody;
 * - an exit node an administrator approved is usable by everybody
 *   (`autogroup:internet`).
 *
 * `adminUsers` are Headscale user names; with none, the administrators' rule is
 * left out rather than written with an empty group.
 */
export function vpnPolicy(adminUsers: readonly string[]): string {
    const admins = [...new Set(adminUsers)].sort();
    const everyone = ["autogroup:member"];
    const grants: { src: string[]; dst: string[]; ip: string[] }[] = [
        { src: everyone, dst: ["autogroup:self"], ip: ["*"] },
        { src: everyone, dst: [POLARIS_TAG], ip: ["*"] },
        { src: everyone, dst: ["autogroup:internet"], ip: ["*"] }
    ];
    if (admins.length > 0) grants.push({ src: ["group:admins"], dst: ["*"], ip: ["*"] });
    const owners = admins.length > 0 ? ["group:admins"] : [];
    return JSON.stringify(
        {
            groups: admins.length > 0 ? { "group:admins": admins.map((name) => `${name}@`) } : {},
            tagOwners: { [POLARIS_TAG]: owners },
            grants
        },
        null,
        2
    );
}
