/**
 * Cloudflare's token form, opened with the permissions Polaris needs already ticked.
 * The dashboard pre-fills the form from `permissionGroupKeys`, so the operator lands
 * on a page where the only thing left to do is press Create - which is the whole
 * difference between one click and a walk through somebody else's permission tree.
 *
 * Three links because Polaris asks for two unrelated things. Writing DNS records
 * needs zone permissions; creating named tunnels needs an account one. An operator
 * who wants both in one token takes the first link; one who would rather not hand a
 * DNS tool any tunnel access takes the other two and connects them separately.
 *
 * Import-free on purpose: the guided setup is a client component, and the provider
 * detection this sits next to reads DNS, so it can never cross that boundary.
 */

/** A permission group in Cloudflare's own `{key, type}` form. */
interface Permission {
    key: string;
    type: string;
}

/** Writes the records and finds the zone they belong to. Nothing else. */
const DNS_PERMISSIONS: Permission[] = [
    { key: "dns", type: "edit" },
    { key: "zone", type: "read" }
];

/**
 * Creates and configures named tunnels. Cloudflare documents the permission group
 * itself ("Cloudflare Tunnel", account-scoped) but not the key its template URLs
 * take, so this is the API's own historical name for it. A key the dashboard does
 * not recognize is ignored silently - the form opens looking perfectly normal with
 * that row missing - which is why the permissions stay written out next to the link.
 */
const TUNNEL_PERMISSIONS: Permission[] = [{ key: "argo_tunnel", type: "edit" }];

/**
 * Scoped to every account and zone the operator has, because the zone is only
 * identifiable once the token can read it - narrowing it here would mean asking them
 * to pick their domain a second time, on a page that does not know which one it is.
 */
function tokenUrl(permissions: Permission[], name: string): string {
    return (
        "https://dash.cloudflare.com/profile/api-tokens" +
        `?permissionGroupKeys=${encodeURIComponent(JSON.stringify(permissions))}` +
        `&accountId=%2A&zoneId=all&name=${encodeURIComponent(name)}`
    );
}

/** What a token can be created for. `all` is one token carrying both sets. */
export type CloudflareTokenScope = "all" | "dns" | "tunnel";

export const CLOUDFLARE_TOKEN_LINKS: Record<CloudflareTokenScope, string> = {
    all: tokenUrl([...DNS_PERMISSIONS, ...TUNNEL_PERMISSIONS], "Polaris"),
    dns: tokenUrl(DNS_PERMISSIONS, "Polaris DNS"),
    tunnel: tokenUrl(TUNNEL_PERMISSIONS, "Polaris Tunnels")
};

/** The permissions each scope asks for, written out for the operator to check
 *  against the form - and to tick by hand if the pre-fill ever misses one. */
export const CLOUDFLARE_TOKEN_PERMISSIONS: Record<CloudflareTokenScope, string[]> = {
    all: ["Zone - DNS: Edit", "Zone - Zone: Read", "Account - Cloudflare Tunnel: Edit"],
    dns: ["Zone - DNS: Edit", "Zone - Zone: Read"],
    tunnel: ["Account - Cloudflare Tunnel: Edit"]
};

/** The DNS-only link, kept under its old name for the guided setup. */
export const CLOUDFLARE_DNS_TOKEN_URL = CLOUDFLARE_TOKEN_LINKS.dns;
