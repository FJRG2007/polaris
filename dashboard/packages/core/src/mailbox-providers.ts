/**
 * Where somebody's mail actually lives, worked out from their address.
 *
 * Asking a person for an IMAP host is asking them to go and read a support page
 * written for a mail client they are not using. Nearly nobody knows the answer,
 * and the ones who do resent being asked - so Polaris only ever asks when it has
 * run out of ways to find out for itself.
 *
 * This is the first of those ways and the only one that needs no network: the
 * handful of services that run most of the world's consumer mail, each with
 * settings that have not moved in a decade. What is not here falls through to
 * the autoconfig lookups (`lib/mailbox/autoconfig.ts`), which ask the domain
 * itself and then Mozilla's directory, and only then does a form appear.
 *
 * Two things are deliberately not in this table. Servers that speak POP3 only,
 * because a mailbox that cannot be read from two places is not what this app is
 * for; and services with no IMAP at all (Tutanota, HEY), because listing them
 * would promise a connection that cannot be made.
 */

/** How a socket is protected. `tls` speaks TLS from the first byte; `starttls`
 *  opens in the clear and upgrades before anything secret is sent; `none` is
 *  offered for a bridge running on the same machine and nowhere else. */
export type MailSocketSecurity = "tls" | "starttls" | "none";

/** How the server is told who is connecting. */
export type MailAuthMethod = "password" | "oauth";

export interface MailServerSettings {
    readonly host: string;
    readonly port: number;
    readonly security: MailSocketSecurity;
}

/**
 * What one service is, as a mail client needs to know it.
 *
 * `oauth` names the Polaris connection provider that authorizes it, so the
 * account form can offer a button instead of a password box. A service with
 * none is reached with a password, which for most of them means an app-specific
 * password rather than the one they sign in with - `passwordHelp` is where that
 * is said, because it is the single most common reason a correct password is
 * refused.
 */
export interface MailService {
    readonly slug: string;
    readonly name: string;
    /** The address domains this serves. Matched exactly, lowercased. */
    readonly domains: readonly string[];
    readonly imap: MailServerSettings;
    readonly smtp: MailServerSettings;
    /** The connection provider that can authorize this without a password. */
    readonly oauth?: "google" | "microsoft";
    /** Said next to the password box when the sign-in password will not work. */
    readonly passwordHelp?: string;
    /**
     * Something the person has to know before they type anything, shown under
     * the address rather than beside the password.
     *
     * One service needs it: Proton publishes autoconfig pointing at 127.0.0.1,
     * which is its Bridge - correct, and useless to a Polaris that is not
     * running on the same machine. Filling the form in with those settings and
     * saying "the domain publishes its own settings, and these are them" is
     * true and reads as everything being fine.
     */
    readonly note?: string;
    /** Where to go and make one. */
    readonly passwordUrl?: string;
    /**
     * True when the service files a message into Sent itself, so a client that
     * appends its own leaves two copies of everything sent. Gmail is the one
     * everybody trips over.
     */
    readonly sentIsAutomatic?: boolean;
    /**
     * True when the server has one folder holding every message and the rest are
     * views of it. Deleting from a folder there only unfiles the message, which
     * is why a Gmail mailbox needs its own move-to-trash path.
     */
    readonly allMailIsCanonical?: boolean;
}

/**
 * The scopes each OAuth service has to grant before its mailbox can be read.
 *
 * Kept beside the provider rather than with the connection code because they are
 * a property of the mail service, and because they are what somebody who linked
 * an account for the calendar has not granted - which the account form has to be
 * able to say out loud rather than failing at the first fetch.
 */
export const MAIL_OAUTH_SCOPES: Readonly<Record<string, readonly string[]>> = {
    google: ["https://mail.google.com/"],
    microsoft: [
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send",
        "offline_access"
    ]
};

export const MAIL_SERVICES: readonly MailService[] = [
    {
        slug: "gmail",
        name: "Gmail",
        domains: ["gmail.com", "googlemail.com"],
        imap: { host: "imap.gmail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
        oauth: "google",
        passwordHelp:
            "Google refuses your ordinary password here. An account with two-step verification can make an app password for Polaris; without it, authorizing the account is the only way in.",
        passwordUrl: "https://myaccount.google.com/apppasswords",
        sentIsAutomatic: true,
        allMailIsCanonical: true
    },
    {
        slug: "google-workspace",
        name: "Google Workspace",
        // Matched by MX rather than by domain: a company on Workspace signs in at
        // its own name and nothing about the address says so.
        domains: [],
        imap: { host: "imap.gmail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
        oauth: "google",
        sentIsAutomatic: true,
        allMailIsCanonical: true
    },
    {
        slug: "outlook",
        name: "Outlook",
        domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com"],
        imap: { host: "outlook.office365.com", port: 993, security: "tls" },
        smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
        oauth: "microsoft",
        passwordHelp:
            "Microsoft has stopped accepting passwords for mail on personal accounts. Authorizing the account is the way in.",
        passwordUrl: "https://account.live.com/proofs/AppPassword"
    },
    {
        slug: "office365",
        name: "Microsoft 365",
        domains: [],
        imap: { host: "outlook.office365.com", port: 993, security: "tls" },
        smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
        oauth: "microsoft"
    },
    {
        slug: "yahoo",
        name: "Yahoo Mail",
        domains: ["yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es", "ymail.com", "rocketmail.com"],
        imap: { host: "imap.mail.yahoo.com", port: 993, security: "tls" },
        smtp: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
        passwordHelp: "Yahoo needs an app password. Your sign-in password is refused.",
        passwordUrl: "https://login.yahoo.com/account/security"
    },
    {
        slug: "icloud",
        name: "iCloud Mail",
        domains: ["icloud.com", "me.com", "mac.com"],
        imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
        smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
        passwordHelp: "Apple needs an app-specific password. Your Apple Account password is refused.",
        passwordUrl: "https://account.apple.com/account/manage"
    },
    {
        slug: "fastmail",
        name: "Fastmail",
        domains: ["fastmail.com", "fastmail.fm", "messagingengine.com"],
        imap: { host: "imap.fastmail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
        passwordHelp: "Fastmail needs an app password with the Mail scope.",
        passwordUrl: "https://app.fastmail.com/settings/security/apppassword"
    },
    {
        slug: "zoho",
        name: "Zoho Mail",
        domains: ["zoho.com", "zohomail.com", "zoho.eu"],
        imap: { host: "imap.zoho.com", port: 993, security: "tls" },
        smtp: { host: "smtp.zoho.com", port: 465, security: "tls" },
        passwordHelp: "Zoho needs an app password when two-factor authentication is on.",
        passwordUrl: "https://accounts.zoho.com/home#security/device"
    },
    {
        slug: "gmx",
        name: "GMX",
        domains: ["gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
        imap: { host: "imap.gmx.com", port: 993, security: "tls" },
        smtp: { host: "mail.gmx.com", port: 587, security: "starttls" },
        passwordHelp: "IMAP has to be switched on in the GMX settings before this will connect."
    },
    {
        slug: "web-de",
        name: "WEB.DE",
        domains: ["web.de"],
        imap: { host: "imap.web.de", port: 993, security: "tls" },
        smtp: { host: "smtp.web.de", port: 587, security: "starttls" },
        passwordHelp: "IMAP has to be switched on in the WEB.DE settings before this will connect."
    },
    {
        slug: "mail-com",
        name: "mail.com",
        domains: ["mail.com", "email.com", "usa.com"],
        imap: { host: "imap.mail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.mail.com", port: 587, security: "starttls" }
    },
    {
        slug: "aol",
        name: "AOL Mail",
        domains: ["aol.com", "aim.com"],
        imap: { host: "imap.aol.com", port: 993, security: "tls" },
        smtp: { host: "smtp.aol.com", port: 465, security: "tls" },
        passwordHelp: "AOL needs an app password. Your sign-in password is refused.",
        passwordUrl: "https://login.aol.com/account/security"
    },
    {
        slug: "yandex",
        name: "Yandex Mail",
        domains: ["yandex.com", "yandex.ru", "ya.ru"],
        imap: { host: "imap.yandex.com", port: 993, security: "tls" },
        smtp: { host: "smtp.yandex.com", port: 465, security: "tls" },
        passwordHelp: "Yandex needs an app password and IMAP switched on in its settings."
    },
    {
        slug: "mailbox-org",
        name: "mailbox.org",
        domains: ["mailbox.org", "secure.mailbox.org"],
        imap: { host: "imap.mailbox.org", port: 993, security: "tls" },
        smtp: { host: "smtp.mailbox.org", port: 465, security: "tls" }
    },
    {
        slug: "posteo",
        name: "Posteo",
        domains: ["posteo.de", "posteo.net", "posteo.org"],
        imap: { host: "posteo.de", port: 993, security: "tls" },
        smtp: { host: "posteo.de", port: 465, security: "tls" }
    },
    {
        slug: "migadu",
        name: "Migadu",
        domains: ["migadu.com"],
        imap: { host: "imap.migadu.com", port: 993, security: "tls" },
        smtp: { host: "smtp.migadu.com", port: 465, security: "tls" }
    },
    {
        slug: "purelymail",
        name: "Purelymail",
        domains: ["purelymail.com"],
        imap: { host: "imap.purelymail.com", port: 993, security: "tls" },
        smtp: { host: "smtp.purelymail.com", port: 465, security: "tls" }
    },
    {
        // IONOS runs one mail platform under several regional names, and a
        // customer's own domain only ever names the region through its MX
        // records - which is why this is reached from `serviceForExchangers`
        // and never from a domain match. Each of these was confirmed to answer
        // on its port rather than taken from a support page.
        slug: "ionos-es",
        name: "IONOS",
        domains: [],
        imap: { host: "imap.ionos.es", port: 993, security: "tls" },
        smtp: { host: "smtp.ionos.es", port: 465, security: "tls" }
    },
    {
        slug: "ionos-de",
        name: "IONOS",
        domains: [],
        imap: { host: "imap.ionos.de", port: 993, security: "tls" },
        smtp: { host: "smtp.ionos.de", port: 465, security: "tls" }
    },
    {
        slug: "ionos-co-uk",
        name: "IONOS",
        domains: [],
        imap: { host: "imap.ionos.co.uk", port: 993, security: "tls" },
        smtp: { host: "smtp.ionos.co.uk", port: 465, security: "tls" }
    },
    {
        slug: "ionos",
        name: "IONOS",
        domains: [],
        imap: { host: "imap.ionos.com", port: 993, security: "tls" },
        smtp: { host: "smtp.ionos.com", port: 465, security: "tls" }
    },
    {
        // The German 1&1 brand on the same platform. It is the one name the
        // shared autoconfig directory does list, under kundenserver.de.
        slug: "1und1",
        name: "1&1",
        domains: ["1und1.de", "online.de"],
        imap: { host: "imap.1und1.de", port: 993, security: "tls" },
        smtp: { host: "smtp.1und1.de", port: 465, security: "tls" }
    },
    {
        slug: "ovh",
        name: "OVH",
        domains: [],
        imap: { host: "ssl0.ovh.net", port: 993, security: "tls" },
        smtp: { host: "ssl0.ovh.net", port: 465, security: "tls" }
    },
    {
        slug: "hostinger",
        name: "Hostinger",
        domains: [],
        imap: { host: "imap.hostinger.com", port: 993, security: "tls" },
        smtp: { host: "smtp.hostinger.com", port: 465, security: "tls" }
    },
    {
        slug: "namecheap",
        name: "Namecheap Private Email",
        domains: [],
        imap: { host: "mail.privateemail.com", port: 993, security: "tls" },
        smtp: { host: "mail.privateemail.com", port: 465, security: "tls" }
    },
    {
        slug: "proton-bridge",
        name: "Proton Mail",
        // Matched by domain, and the note is the reason why. Proton's own
        // servers speak no IMAP: the Bridge does, on the machine its owner is
        // sitting at, which is not the machine Polaris runs on. Leaving these
        // domains out meant the address fell through to autoconfig, which
        // returns exactly these settings with "the domain publishes its own
        // settings, and these are them" - true, and read by everybody as
        // everything being fine. Recognised here so the sentence can be the
        // honest one.
        domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me", "passinbox.com"],
        imap: { host: "127.0.0.1", port: 1143, security: "starttls" },
        smtp: { host: "127.0.0.1", port: 1025, security: "starttls" },
        note:
            "Proton's servers do not speak IMAP. Reaching this mailbox needs Proton Mail Bridge running on a machine Polaris can connect to, and the address below is that machine - 127.0.0.1 only works if the Bridge is on this server.",
        passwordHelp:
            "The Bridge prints its own password, which is not your Proton one."
    }
];

/** The domain half of an address, lowercased. Empty when there is not one. */
export function mailDomain(address: string): string {
    const at = address.trim().toLowerCase().lastIndexOf("@");
    return at === -1 ? "" : address.trim().toLowerCase().slice(at + 1);
}

/** The service that runs this address, by its domain alone. Null when the
 *  domain does not say, which is every company that runs its own name. */
export function serviceForAddress(address: string): MailService | null {
    const domain = mailDomain(address);
    if (!domain) return null;
    return MAIL_SERVICES.find((entry) => entry.domains.includes(domain)) ?? null;
}

export function findMailService(slug: string): MailService | undefined {
    return MAIL_SERVICES.find((entry) => entry.slug === slug);
}

/**
 * The service behind a domain's mail exchangers.
 *
 * A company on Workspace or Microsoft 365 has an address that says nothing and
 * MX records that say everything, so this is the second question asked, and the
 * one that turns "some domain I have never heard of" into a Connect button.
 */
/**
 * Which service a mail exchanger belongs to, longest suffix first.
 *
 * This is the question that answers for a company. An address at a company's own
 * domain says nothing about where its mail lives; its MX records say everything,
 * and for most domains they are the ONLY thing that says anything - a small
 * business on a hosting provider publishes no autoconfig document, is not in the
 * shared directory, and has no `imap.` name of its own to guess at.
 *
 * The regional entries matter and are not noise: a provider that runs one
 * platform under several country names still expects a mailbox to connect to the
 * one its own MX names, and sending somebody to the wrong region is a login that
 * is refused with nothing on screen explaining why.
 *
 * Ordered longest-suffix-first so `mx.zoho.eu` is not matched by a shorter rule
 * that happens to be a tail of it.
 */
const EXCHANGER_SERVICES: readonly (readonly [suffix: string, slug: string])[] = [
    ["aspmx.l.google.com", "google-workspace"],
    ["googlemail.com", "google-workspace"],
    ["google.com", "google-workspace"],
    ["protection.outlook.com", "office365"],
    ["outlook.com", "office365"],
    ["icloud.com", "icloud"],
    ["apple.com", "icloud"],
    ["messagingengine.com", "fastmail"],
    ["zoho.eu", "zoho"],
    ["zoho.com", "zoho"],
    ["yandex.net", "yandex"],
    ["yandex.ru", "yandex"],
    ["mailbox.org", "mailbox-org"],
    ["migadu.com", "migadu"],
    ["posteo.de", "posteo"],
    // IONOS, by region. The suffixes are what a customer domain's MX actually
    // carries - `mx00.ionos.es`, `mx00.kundenserver.de` - rather than the names
    // the mailbox then connects to.
    ["ionos.es", "ionos-es"],
    ["1and1.es", "ionos-es"],
    ["ionos.de", "ionos-de"],
    ["kundenserver.de", "ionos-de"],
    ["schlund.de", "ionos-de"],
    ["ionos.co.uk", "ionos-co-uk"],
    ["1and1.co.uk", "ionos-co-uk"],
    ["ionos.com", "ionos"],
    ["perfora.net", "ionos"],
    ["1and1.com", "ionos"],
    ["1und1.de", "1und1"],
    ["ovh.net", "ovh"],
    ["mail.ovh.net", "ovh"],
    ["hostinger.com", "hostinger"],
    ["privateemail.com", "namecheap"],
    ["registrar-servers.com", "namecheap"]
];

/**
 * The service behind a domain's mail exchangers.
 *
 * A company on a hosting provider has an address that says nothing and MX
 * records that say everything, so this is the question that turns "some domain
 * nobody has heard of" into a filled-in form. Null when the exchangers belong to
 * nobody recognised, which is an answer and sends discovery on to the next step.
 */
export function serviceForExchangers(hosts: readonly string[]): MailService | null {
    const names = hosts.map((host) => host.trim().toLowerCase().replace(/\.$/, ""));
    for (const [suffix, slug] of EXCHANGER_SERVICES) {
        // Matched on a label boundary, so `notionos.es` is not IONOS.
        const matched = names.some((name) => name === suffix || name.endsWith(`.${suffix}`));
        if (matched) return findMailService(slug) ?? null;
    }
    return null;
}

/**
 * Hosts worth trying when nothing else answered, in the order they are tried.
 *
 * Most small mail servers are reachable at one of four names under their own
 * domain, and trying them costs one TLS handshake each against a machine the
 * person already trusts with their mail. It is the last thing attempted before
 * a form appears, and finding nothing here is not an error.
 */
export function guessedHosts(domain: string): readonly string[] {
    const clean = domain.trim().toLowerCase();
    if (!clean) return [];
    return [`imap.${clean}`, `mail.${clean}`, `imap4.${clean}`, clean];
}
