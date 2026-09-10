/**
 * Working out where somebody's mail lives, so they never have to type a host.
 *
 * This is the difference between "add your mailbox" being one field and being
 * eight, and it is the reason people abandon mail clients. Five questions are
 * asked in order, each cheaper and more trustworthy than the one after it, and
 * the first that answers wins:
 *
 * 1. **The catalogue.** The dozen services that run most of the world's consumer
 *    mail, matched on the address domain. Costs nothing and is right for the
 *    majority of people.
 * 2. **The domain's own autoconfig.** Thunderbird's convention, which a large
 *    number of hosting providers publish because Thunderbird made them: an XML
 *    document at a well-known place under the domain, written by whoever runs
 *    the mail. It is the authoritative answer where it exists.
 * 3. **Mozilla's directory.** The same document, for domains whose owners never
 *    published one, kept by Mozilla for two decades.
 * 4. **What the domain's mail exchangers say.** A company on Workspace or
 *    Microsoft 365 has an address that gives nothing away and MX records that
 *    give everything away, and this is what turns an unrecognised company domain
 *    into a Connect button.
 * 5. **The conventional names.** `imap.<domain>` and its three neighbours, tried
 *    with a TLS handshake. Most small mail servers answer at one of them.
 *
 * Only then is a form shown, and even then it is shown pre-filled with the
 * closest guess rather than empty.
 *
 * Everything that leaves this machine goes through the guarded fetch: the domain
 * is somebody's typed input, and fetching it unguarded would be a request
 * forgery with an address bar in front of it. The TLS probe is guarded the same
 * way, by resolving the name and refusing anything that is not a public address
 * before a socket is opened.
 */

import * as net from "node:net";
import * as tls from "node:tls";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { resolveMx, resolveSrv } from "node:dns/promises";
import { follow, readAtMost, reachable, safeUrl } from "@/lib/safe-fetch";

/** What the account form is handed. */
export interface MailDiscovery {
    readonly address: string;
    /** The service it was recognised as, or "" when nobody recognised it. */
    readonly service: string;
    readonly serviceName: string;
    readonly imap: core.MailServerSettings;
    readonly smtp: core.MailServerSettings;
    /** Whether this can be authorized instead of asked for a password, and by
     *  which of the linked services. */
    readonly oauth: "google" | "microsoft" | null;
    /** Said next to the password box, when the sign-in password will not work. */
    readonly passwordHelp: string;
    /** Said under the address, before anything is typed, when there is something
     *  the person has to know for the settings below to mean what they say. */
    readonly note: string;
    readonly passwordUrl: string;
    /** Which of the five questions answered, so the form can say how sure it is
     *  and a support conversation has somewhere to start. */
    readonly source:
        | "catalogue"
        | "polaris"
        | "domain"
        | "directory"
        | "exchangers"
        | "probe"
        | "none";
}

/** How long any one lookup may take. Five of them run in sequence and somebody
 *  is watching a spinner, so none of them may be slow. */
const PROBE_TIMEOUT_MS = 4000;

/** Enough for any autoconfig document ever written, and small enough that a
 *  domain answering with a video is a failed lookup rather than a full disk. */
const CONFIG_MAX_BYTES = 256 * 1024;

function fromService(
    address: string,
    service: core.MailService,
    source: MailDiscovery["source"]
): MailDiscovery {
    return {
        address,
        service: service.slug,
        serviceName: service.name,
        imap: service.imap,
        smtp: service.smtp,
        oauth: service.oauth ?? null,
        passwordHelp: service.passwordHelp ?? "",
        note: service.note ?? "",
        passwordUrl: service.passwordUrl ?? "",
        source
    };
}

/**
 * Where this address's mail lives.
 *
 * Never throws and never leaves somebody stuck: a domain that answers nothing
 * comes back as `source: "none"` with the conventional guesses filled in, which
 * is a form somebody can correct rather than a form somebody has to complete.
 */
export async function discoverMailbox(address: string): Promise<MailDiscovery> {
    const domain = core.mailDomain(address);
    const known = core.serviceForAddress(address);
    if (known) return fromService(address, known, "catalogue");
    if (!domain) return unknown(address, "");

    // A mail server this Polaris runs: its settings are known without asking
    // anybody, and before its DNS is published nothing else would find them.
    const ours = await prisma.mailServer
        .findFirst({
            where: { primaryDomain: domain, status: { in: ["ready", "down"] } },
            select: { hostname: true }
        })
        .catch(() => null);
    if (ours) {
        return {
            ...unknown(address, domain),
            imap: { host: ours.hostname, port: 993, security: "tls" },
            smtp: { host: ours.hostname, port: 465, security: "tls" },
            source: "polaris"
        };
    }

    const published = await domainAutoconfig(domain, address).catch(() => null);
    if (published) return { ...published, address, source: "domain" };

    const directory = await directoryAutoconfig(domain, address).catch(() => null);
    if (directory) return { ...directory, address, source: "directory" };

    const byExchangers = await serviceByExchangers(domain).catch(() => null);
    if (byExchangers) return fromService(address, byExchangers, "exchangers");

    const bySrv = await serversBySrv(domain).catch(() => null);
    if (bySrv) return { ...unknown(address, domain), ...bySrv, source: "probe" };

    const probed = await probeConventionalHosts(domain).catch(() => null);
    if (probed) return { ...unknown(address, domain), ...probed, source: "probe" };

    return unknown(address, domain);
}

/** The form somebody is shown when nothing answered: the conventional names,
 *  the conventional ports, and every field editable. */
function unknown(address: string, domain: string): MailDiscovery {
    const host = domain ? `imap.${domain}` : "";
    return {
        address,
        service: "",
        serviceName: "",
        imap: { host, port: 993, security: "tls" },
        smtp: { host: domain ? `smtp.${domain}` : "", port: 465, security: "tls" },
        oauth: null,
        passwordHelp: "",
        note: "",
        passwordUrl: "",
        source: "none"
    };
}

/* -------------------------------------------------------------------------- */
/* The autoconfig document                                                     */
/* -------------------------------------------------------------------------- */

type PartialDiscovery = Omit<MailDiscovery, "address" | "source">;

/**
 * The document the domain publishes about itself.
 *
 * Two addresses, because the convention has two and providers publish one or the
 * other. The address is passed along because some documents template the login
 * into their answer, and it is the address the person already typed.
 */
async function domainAutoconfig(domain: string, address: string): Promise<PartialDiscovery | null> {
    const candidates = [
        `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`,
        `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`
    ];
    for (const candidate of candidates) {
        const parsed = await fetchAutoconfig(candidate, address);
        if (parsed) return parsed;
    }
    return null;
}

/** The same document, out of the directory Mozilla keeps for the domains whose
 *  owners never published one. */
function directoryAutoconfig(domain: string, address: string): Promise<PartialDiscovery | null> {
    return fetchAutoconfig(
        `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
        address
    );
}

async function fetchAutoconfig(url: string, address: string): Promise<PartialDiscovery | null> {
    const target = safeUrl(url);
    if (!target) return null;
    const response = await follow(target, "application/xml,text/xml");
    if (!response || response.status !== 200) return null;
    const bytes = await readAtMost(response, CONFIG_MAX_BYTES);
    if (!bytes) return null;
    return parseAutoconfig(new TextDecoder().decode(bytes), address);
}

/**
 * Read the servers out of an autoconfig document.
 *
 * Deliberately a handful of regular expressions rather than an XML parser. The
 * whole of what is wanted is two elements and four fields inside each, the
 * documents are written by hand and are frequently not well formed, and adding
 * an XML dependency to read four values from a document nobody validates is a
 * dependency that has to keep working forever. A malformed document reads as no
 * answer, which is the correct outcome either way.
 *
 * Exported for the test: it is the one piece of this file that can be asserted
 * without a network.
 */
export function parseAutoconfig(xml: string, address: string): PartialDiscovery | null {
    const imap = readServer(xml, "imap");
    const smtp = readServer(xml, "smtp");
    if (!imap || !smtp) return null;
    const name = /<displayName>([^<]+)<\/displayName>/i.exec(xml)?.[1]?.trim() ?? "";
    return {
        service: "",
        serviceName: name,
        imap: fillLogin(imap, address),
        smtp: fillLogin(smtp, address),
        oauth: null,
        passwordHelp: "",
        note: "",
        passwordUrl: ""
    };
}

/** A `%EMAILADDRESS%` placeholder is a login template, not a host: the fields
 *  this reads never carry one, so this only guards against a document that put
 *  one where a host belongs. */
function fillLogin(settings: core.MailServerSettings, address: string): core.MailServerSettings {
    return settings.host.includes("%")
        ? { ...settings, host: settings.host.replace(/%EMAILADDRESS%/gi, address) }
        : settings;
}

function readServer(xml: string, type: "imap" | "smtp"): core.MailServerSettings | null {
    // The first block of the wanted type. Documents list several and the first
    // is the one the publisher recommends.
    const block = new RegExp(
        `<(?:incoming|outgoing)Server[^>]*type="${type}"[^>]*>([\\s\\S]*?)</(?:incoming|outgoing)Server>`,
        "i"
    ).exec(xml)?.[1];
    if (!block) return null;
    const host = /<hostname>([^<]+)<\/hostname>/i.exec(block)?.[1]?.trim().toLowerCase();
    const port = Number(/<port>(\d+)<\/port>/i.exec(block)?.[1]);
    const socket =
        /<socketType>([^<]+)<\/socketType>/i.exec(block)?.[1]?.trim().toUpperCase() ?? "";
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const security: core.MailSocketSecurity =
        socket === "SSL"
            ? "tls"
            : socket === "STARTTLS"
              ? "starttls"
              : port === 993 || port === 465
                ? "tls"
                : "starttls";
    return { host, port, security };
}

/* -------------------------------------------------------------------------- */
/* DNS                                                                         */
/* -------------------------------------------------------------------------- */

/** Which of the big services runs this domain's mail, by its exchangers. */
async function serviceByExchangers(domain: string): Promise<core.MailService | null> {
    const records = await resolveMx(domain).catch(() => []);
    if (records.length === 0) return null;
    return core.serviceForExchangers(records.map((record) => record.exchange));
}

/**
 * The servers a domain publishes in DNS (RFC 6186).
 *
 * Rarer than the XML document but authoritative where it exists, and it is the
 * one answer a small self-hosted server is likely to have published. A record
 * with the target `.` is the domain saying explicitly that it offers none, which
 * is an answer and is treated as one.
 */
async function serversBySrv(
    domain: string
): Promise<Pick<PartialDiscovery, "imap" | "smtp"> | null> {
    const [imaps, submission] = await Promise.all([
        resolveSrv(`_imaps._tcp.${domain}`).catch(() => []),
        resolveSrv(`_submission._tcp.${domain}`).catch(() => [])
    ]);
    const inbound = imaps
        .filter((record) => record.name && record.name !== ".")
        .sort((a, b) => a.priority - b.priority)[0];
    if (!inbound) return null;
    const outbound = submission
        .filter((record) => record.name && record.name !== ".")
        .sort((a, b) => a.priority - b.priority)[0];
    return {
        imap: {
            host: inbound.name.toLowerCase(),
            port: inbound.port,
            security: inbound.port === 993 ? "tls" : "starttls"
        },
        smtp: outbound
            ? {
                  host: outbound.name.toLowerCase(),
                  port: outbound.port,
                  security: outbound.port === 465 ? "tls" : "starttls"
              }
            : {
                  host: inbound.name.toLowerCase().replace(/^imaps?\./, "smtp."),
                  port: 465,
                  security: "tls"
              }
    };
}

/* -------------------------------------------------------------------------- */
/* The last resort                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Try the conventional names until one answers on 993.
 *
 * A TLS handshake and nothing more: no command is sent, no credential exists
 * yet, and a name that completes a handshake on the IMAP port is a mail server
 * with a probability close to one. Guarded exactly as a fetch is, because the
 * host is derived from typed input and a name that resolves to the machine next
 * to this one must not be connected to.
 */
async function probeConventionalHosts(
    domain: string
): Promise<Pick<PartialDiscovery, "imap" | "smtp"> | null> {
    for (const host of core.guessedHosts(domain)) {
        if (!(await reachable(host))) continue;
        if (!(await handshakes(host, 993))) continue;
        // The submission port is not probed separately: a server answering IMAP
        // on 993 answers submission on one of two ports, and getting that wrong
        // is a field somebody corrects rather than a mailbox that cannot be
        // added. 465 is the one to guess - it is what a modern server offers.
        return {
            imap: { host, port: 993, security: "tls" },
            smtp: { host: host.replace(/^imap4?\./, "smtp."), port: 465, security: "tls" }
        };
    }
    return null;
}

/** Whether a TLS connection to this host and port completes. Nothing is sent
 *  and nothing is read. */
function handshakes(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = tls.connect(
            {
                host,
                port,
                servername: net.isIP(host) ? undefined : host,
                // Nothing is sent on this socket and nothing is read from it. A
                // certificate this machine happens not to trust still answers
                // the only question being asked - is there a mail server here -
                // and refusing it would mean guessing a host as wrong because
                // of an intermediate certificate. The connection that carries
                // the credential is opened in imap.ts and does verify.
                rejectUnauthorized: false
            },
            () => {
                socket.destroy();
                resolve(true);
            }
        );
        socket.setTimeout(PROBE_TIMEOUT_MS, () => {
            socket.destroy();
            resolve(false);
        });
        // A certificate this machine does not trust still proves something is
        // listening and speaking TLS, which is all this asks. The credential is
        // never sent here, and the connection that will carry one verifies it.
        socket.on("error", () => {
            socket.destroy();
            resolve(false);
        });
    });
}
