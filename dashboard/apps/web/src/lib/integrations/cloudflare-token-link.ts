/**
 * Cloudflare's token form, opened with the permissions Polaris needs already ticked.
 * The dashboard pre-fills the form from `permissionGroupKeys`, so the operator lands
 * on a page where the only thing left to do is press Create - which is the whole
 * difference between one click and a walk through somebody else's permission tree.
 *
 * Two permissions and no more: DNS Edit writes the records, Zone Read finds the zone
 * they belong to. Anything else would be access Polaris asks for without using.
 *
 * Import-free on purpose: the guided setup is a client component, and the provider
 * detection this sits next to reads DNS, so it can never cross that boundary.
 */

/** Permission groups in Cloudflare's own `{key, type}` form. */
const DNS_PERMISSIONS = [
    { key: "dns", type: "edit" },
    { key: "zone", type: "read" }
];

/**
 * Scoped to every account and zone the operator has, because the zone is only
 * identifiable once the token can read it - narrowing it here would mean asking them
 * to pick their domain a second time, on a page that does not know which one it is.
 */
export const CLOUDFLARE_DNS_TOKEN_URL =
    "https://dash.cloudflare.com/profile/api-tokens" +
    `?permissionGroupKeys=${encodeURIComponent(JSON.stringify(DNS_PERMISSIONS))}` +
    "&accountId=%2A&zoneId=all&name=Polaris%20DNS";
