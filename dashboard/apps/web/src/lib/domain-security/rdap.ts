/**
 * Reading a domain's registration from RDAP (RFC 9083), the JSON successor to
 * WHOIS that every gTLD registry and most ccTLDs serve over HTTPS. Pure: the
 * fetching is in `probes.ts`; this reads the bootstrap file and the answers.
 */

import type { RegistrationFacts } from "./facts";

/** IANA's map from top-level domain to RDAP server (RFC 9224). */
export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

/** The RDAP base URL for a domain's TLD, from IANA's bootstrap document, or null
 *  when the TLD has none (several ccTLDs). */
export function rdapBaseFor(bootstrap: unknown, domain: string): string | null {
    const services = (bootstrap as { services?: unknown })?.services;
    if (!Array.isArray(services)) return null;
    const labels = domain.toLowerCase().split(".");
    // The longest registered suffix wins, though today every entry is one label.
    for (let start = 0; start < labels.length; start += 1) {
        const suffix = labels.slice(start).join(".");
        for (const service of services) {
            if (!Array.isArray(service) || service.length < 2) continue;
            const [tlds, urls] = service as [unknown, unknown];
            if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
            if (!tlds.some((tld) => typeof tld === "string" && tld.toLowerCase() === suffix))
                continue;
            const https = urls.find(
                (url): url is string => typeof url === "string" && url.startsWith("https://")
            );
            if (https) return https.endsWith("/") ? https : `${https}/`;
        }
    }
    return null;
}

interface RdapEntity {
    readonly roles?: unknown;
    readonly vcardArray?: unknown;
    readonly remarks?: unknown;
    readonly entities?: unknown;
}

function entities(value: unknown): RdapEntity[] {
    return Array.isArray(value)
        ? (value.filter((entry) => entry && typeof entry === "object") as RdapEntity[])
        : [];
}

function hasRole(entity: RdapEntity, role: string): boolean {
    return Array.isArray(entity.roles) && entity.roles.some((entry) => entry === role);
}

/** A vCard property's text value (`fn`, `org`, `email`), or null. */
function vcardValue(entity: RdapEntity, property: string): string | null {
    const card = entity.vcardArray;
    if (!Array.isArray(card) || !Array.isArray(card[1])) return null;
    for (const entry of card[1] as unknown[]) {
        if (Array.isArray(entry) && entry[0] === property && typeof entry[3] === "string")
            return entry[3];
    }
    return null;
}

const REDACTED =
    /redact|privacy|private|withheld|not disclosed|data protected|gdpr|statutory masking|contact privacy|proxy/i;

/** Whether a registrant entity withholds who it is: no name at all, or a name or
 *  remark that says it is masked. */
function redacted(entity: RdapEntity): boolean {
    const name = vcardValue(entity, "fn") ?? "";
    const org = vcardValue(entity, "org") ?? "";
    const remarks = Array.isArray(entity.remarks) ? JSON.stringify(entity.remarks) : "";
    if (!name && !org) return true;
    return REDACTED.test(name) || REDACTED.test(org) || REDACTED.test(remarks);
}

/** The registrar-side RDAP link a thin registry points at, when it gives one. */
export function relatedRdapLink(answer: unknown): string | null {
    const links = (answer as { links?: unknown })?.links;
    if (!Array.isArray(links)) return null;
    for (const link of links) {
        const entry = link as { rel?: unknown; href?: unknown; type?: unknown };
        if (
            entry?.rel === "related" &&
            typeof entry.href === "string" &&
            entry.href.startsWith("https://") &&
            /rdap/i.test(String(entry.type ?? entry.href))
        ) {
            return entry.href;
        }
    }
    return null;
}

/** What an RDAP domain answer says about expiry, locks, registrar and privacy. */
export function parseRdapDomain(answer: unknown): RegistrationFacts | null {
    if (!answer || typeof answer !== "object") return null;
    const body = answer as {
        objectClassName?: unknown;
        events?: unknown;
        status?: unknown;
        entities?: unknown;
        redacted?: unknown;
    };
    if (body.objectClassName !== undefined && body.objectClassName !== "domain") return null;
    const events = Array.isArray(body.events) ? body.events : [];
    const expiry = events.find(
        (event) => (event as { eventAction?: unknown })?.eventAction === "expiration"
    ) as { eventDate?: unknown } | undefined;
    const expiresAt =
        typeof expiry?.eventDate === "string" && !Number.isNaN(Date.parse(expiry.eventDate))
            ? new Date(expiry.eventDate).toISOString()
            : null;
    const statuses = Array.isArray(body.status)
        ? body.status
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.toLowerCase())
        : [];
    const all = entities(body.entities);
    const registrarEntity = all.find((entity) => hasRole(entity, "registrar"));
    const registrar = registrarEntity
        ? (vcardValue(registrarEntity, "fn") ?? vcardValue(registrarEntity, "org"))
        : null;
    const registrant = all.find((entity) => hasRole(entity, "registrant"));
    // RFC 9537 lists the fields a server withheld; a registrant name among them
    // is an answer on its own.
    const redactedList = Array.isArray(body.redacted) ? JSON.stringify(body.redacted) : "";
    const registrantRedacted = registrant
        ? redacted(registrant)
        : /registrant/i.test(redactedList)
          ? true
          : null;
    return { expiresAt, statuses, registrar, registrantRedacted };
}

/** A thin registry's answer completed by the registrar's: the registry knows the
 *  dates and locks, the registrar knows the registrant. */
export function mergeRegistration(
    registry: RegistrationFacts,
    registrar: RegistrationFacts | null
): RegistrationFacts {
    if (!registrar) return registry;
    return {
        expiresAt: registry.expiresAt ?? registrar.expiresAt,
        statuses: registry.statuses.length > 0 ? registry.statuses : registrar.statuses,
        registrar: registry.registrar ?? registrar.registrar,
        registrantRedacted: registrar.registrantRedacted ?? registry.registrantRedacted
    };
}
