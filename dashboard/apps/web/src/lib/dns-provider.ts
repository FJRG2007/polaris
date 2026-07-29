/**
 * Which DNS provider actually answers for a domain, and the shortest route from the
 * guided setup to its records.
 *
 * The zone's nameservers are the signal, not the registrar: a domain bought in one
 * place is very often served in another, and it is whoever SERVES it that holds the
 * records. Matching is by nameserver hostname, so every shard of a provider
 * (`dana.ns.cloudflare.com`, `rick.ns.cloudflare.com`) lands on the same entry.
 *
 * What it buys: on a provider Polaris can drive through an API, the setup offers to
 * create the records itself instead of dictating them; on every other one it names the
 * provider the operator actually uses and links straight to its record editor, instead
 * of leaving them to find it. Nothing here changes DNS - it only decides what to offer.
 */

import { resolveNs } from "node:dns/promises";

export interface DnsProvider {
    id: string;
    label: string;
    /** Nameserver hostname fragments that identify the provider. */
    match: string[];
    /** Where this zone's records are edited, when the provider has a stable URL. */
    url?: (zone: string) => string;
    /** True when Polaris can create the records itself through a connected account. */
    automatable?: boolean;
}

/**
 * Nameserver fragments per provider, most common first. Fragments start at a label
 * boundary so `.name.com` cannot match `something.name.com.br`, and stay short enough
 * to survive the shard numbering every provider does differently (`ns-1.awsdns-02.org`,
 * `hydrogen.ns1.hetzner.com`).
 *
 * A URL is only listed where the provider has a stable one; where a per-domain link
 * exists it is used, otherwise the panel the domain is managed from. An entry without
 * one still earns its place: naming the provider is most of the answer.
 */
const DNS_PROVIDERS: DnsProvider[] = [
    {
        id: "cloudflare",
        label: "Cloudflare",
        // Customer zones get `<name>.ns.cloudflare.com`, but not every Cloudflare zone
        // does (`ns3.cloudflare.com` and friends serve some), and any nameserver under
        // the domain is theirs either way. Foundation DNS is the same company under a
        // different name, served by the same API.
        match: [".cloudflare.com", ".foundationdns.com"],
        // The `:account` placeholder is resolved by the dashboard on redirect, so the
        // link lands on this domain's records whichever account the operator signs into.
        url: (zone) => `https://dash.cloudflare.com/?to=/:account/${zone}/dns/records`,
        automatable: true
    },
    {
        id: "route53",
        label: "AWS Route 53",
        match: [".awsdns-"],
        url: () => "https://console.aws.amazon.com/route53/v2/hostedzones"
    },
    {
        id: "godaddy",
        label: "GoDaddy",
        match: [".domaincontrol.com", ".godaddy.com"],
        url: () => "https://dcc.godaddy.com/domains"
    },
    {
        id: "namecheap",
        label: "Namecheap",
        match: [".registrar-servers.com"],
        url: (zone) => `https://ap.www.namecheap.com/Domains/DomainControlPanel/${zone}/advancedns`
    },
    {
        id: "hostinger",
        label: "Hostinger",
        match: [".dns-parking.com"],
        url: () => "https://hpanel.hostinger.com/domains"
    },
    { id: "vercel", label: "Vercel", match: [".vercel-dns.com"], url: () => "https://vercel.com/dashboard/domains" },
    { id: "ns1", label: "NS1 / Netlify", match: [".nsone.net"] },
    {
        id: "digitalocean",
        label: "DigitalOcean",
        match: [".digitalocean.com"],
        url: () => "https://cloud.digitalocean.com/networking/domains"
    },
    {
        id: "google",
        label: "Google Cloud DNS",
        match: [".googledomains.com"],
        url: () => "https://console.cloud.google.com/net-services/dns/zones"
    },
    {
        id: "squarespace",
        label: "Squarespace",
        match: [".squarespacedns.com"],
        url: () => "https://account.squarespace.com/domains"
    },
    { id: "azure", label: "Azure DNS", match: [".azure-dns."], url: () => "https://portal.azure.com" },
    { id: "ovh", label: "OVH", match: [".ovh.net"], url: () => "https://www.ovh.com/manager/#/web/domain" },
    { id: "ionos", label: "IONOS", match: [".ui-dns."], url: () => "https://my.ionos.com/domains" },
    { id: "gandi", label: "Gandi", match: [".gandi.net"], url: () => "https://admin.gandi.net/domain" },
    {
        id: "hetzner",
        label: "Hetzner",
        match: [".hetzner.com", ".hetzner.de", ".your-server.de"],
        url: () => "https://dns.hetzner.com"
    },
    {
        id: "porkbun",
        label: "Porkbun",
        match: [".porkbun.com"],
        url: () => "https://porkbun.com/account/domainsSpeedy"
    },
    { id: "dnsimple", label: "DNSimple", match: [".dnsimple.com"], url: () => "https://dnsimple.com/domains" },
    { id: "name-com", label: "Name.com", match: [".name.com"], url: () => "https://www.name.com/account/domain" },
    { id: "linode", label: "Akamai / Linode", match: [".linode.com"], url: () => "https://cloud.linode.com/domains" },
    { id: "bunny", label: "Bunny DNS", match: [".bunny.net"], url: () => "https://dash.bunny.net" },
    { id: "duckdns", label: "DuckDNS", match: [".duckdns.org"], url: () => "https://www.duckdns.org/domains" },
    {
        id: "dondominio",
        label: "DonDominio",
        match: [".dondominio.com"],
        url: () => "https://www.dondominio.com/panel/"
    },
    { id: "cdmon", label: "cdmon", match: [".cdmon.net", ".cdmon.com"] }
];

/** What the wizard renders from - plain data, so it crosses the server-action boundary. */
export interface DnsProviderInfo {
    /** Stable id, or null when the nameservers match nothing known. */
    id: string | null;
    label: string | null;
    /** The zone whose nameservers answered: `example.com` for `plr.example.com`. */
    zone: string;
    nameservers: string[];
    url: string | null;
    /** Polaris can create the records itself once the provider's account is connected. */
    automatable: boolean;
}

/** The provider a set of nameservers belongs to, or null when none is recognized. */
export function dnsProviderFor(nameservers: string[]): DnsProvider | null {
    const hosts = nameservers.map((nameserver) => nameserver.trim().toLowerCase().replace(/\.$/, ""));
    return (
        DNS_PROVIDERS.find((provider) =>
            hosts.some((host) => provider.match.some((fragment) => host.includes(fragment)))
        ) ?? null
    );
}

/** Resolve one zone's nameservers, treating "no such zone" as an empty answer. */
async function resolveNsOrEmpty(zone: string): Promise<string[]> {
    try {
        return await resolveNs(zone);
    } catch {
        return [];
    }
}

/**
 * Who answers DNS for a domain. Walks up label by label because the zone base is
 * usually a subdomain (`plr.example.com`) while only the registrable domain is
 * delegated, and stops before the TLD - that one always answers, and would name the
 * registry instead of the operator's provider.
 *
 * Returns null when nothing above the domain answers at all, which is the honest
 * outcome for a domain that does not exist yet.
 */
export async function detectDnsProvider(domain: string): Promise<DnsProviderInfo | null> {
    const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
    for (let index = 0; index + 2 <= labels.length; index += 1) {
        const zone = labels.slice(index).join(".");
        const nameservers = await resolveNsOrEmpty(zone);
        if (nameservers.length === 0) continue;
        const provider = dnsProviderFor(nameservers);
        return {
            id: provider?.id ?? null,
            label: provider?.label ?? null,
            zone,
            nameservers: nameservers.map((nameserver) => nameserver.toLowerCase().replace(/\.$/, "")),
            url: provider?.url?.(zone) ?? null,
            automatable: provider?.automatable === true
        };
    }
    return null;
}
