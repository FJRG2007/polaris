/**
 * A mail server Polaris runs: what it is, what the operator may ask of it, and
 * the judgements that do not need the network to make.
 *
 * The engine is Stalwart, run as a Deploy service so it gets the same logs,
 * terminal, metrics and restart every other service has. The requests it is
 * managed with are in `mail-server-jmap`, the DNS it needs in `mail-dns`.
 */

import { z } from "zod";
import { normalizeDeployHostname } from "./edge-config.js";

/** A plain host or domain name: what the edge accepts, with no wildcard. */
function isHostname(value: string): boolean {
    const normalized = normalizeDeployHostname(value);
    return normalized !== null && !normalized.startsWith("*.");
}

/** The engine image, pinned to a minor release as its own documentation asks
 *  for production (stalw.art/docs/install/platform/docker). */
export const STALWART_IMAGE = "stalwartlabs/stalwart:v0.16";

/** The engine's HTTP listener: management, JMAP, webmail and ACME challenges.
 *  On a fresh start it is also where bootstrap mode listens. */
export const STALWART_HTTP_PORT = 8080;

/** Where the engine keeps its configuration and its data. */
export const STALWART_CONFIG_PATH = "/etc/stalwart";
export const STALWART_DATA_PATH = "/var/lib/stalwart";

/** The account Polaris manages the server with. */
export const MAIL_ADMIN_NAME = "polaris-admin";

/** The mailbox Polaris sends its own mail from, once the server is up. */
export const MAIL_SENDER_NAME = "polaris";

/** The mailbox receivers send DMARC aggregate reports to, at every domain on the
 *  server (an alias for each), which Polaris reads and files. */
export const MAIL_REPORTS_NAME = "dmarc-reports";

/** The ports a mail server answers on, published on the machine as themselves:
 *  a mail client and another mail server expect these numbers and no others. */
export const MAIL_SERVER_PORTS = [
    { port: 25, label: "SMTP", purpose: "Mail from other servers arrives here", required: true },
    { port: 465, label: "Submission over TLS", purpose: "Mail apps send through this", required: true },
    { port: 587, label: "Submission", purpose: "Mail apps send through this with STARTTLS", required: false },
    { port: 993, label: "IMAP over TLS", purpose: "Mail apps read mail through this", required: true },
    { port: 4190, label: "ManageSieve", purpose: "Mail apps edit filters through this", required: false }
] as const;

export type MailPort = (typeof MAIL_SERVER_PORTS)[number]["port"];

/** How a connection attempt to a port ended. */
export type PortOutcome = "open" | "refused" | "timeout" | "error";

export type PortVerdict = "pass" | "warn" | "fail" | "unverified";

/**
 * What a probe of one port proves.
 *
 * Only an answer is proof. A refusal proves nothing listens. A silence proves
 * nothing at all: it is what a firewall that drops packets looks like, and it
 * is also what a network that forbids outbound port 25 looks like from the
 * inside - which most home and cloud networks do. So a silent 25 is reported as
 * unverified rather than failed: saying "your mail server is down" about a
 * server that is fine, because the network Polaris asked from blocks the port,
 * would send somebody to fix the wrong thing.
 */
export function portVerdict(
    port: number,
    outcome: PortOutcome,
    throughOwnRouter = false
): { verdict: PortVerdict; note: string | null } {
    if (outcome === "open") return { verdict: "pass", note: null };
    // Asked from behind the same router the server sits behind: the knock goes
    // out to the public address and has to be turned back inward, which many
    // routers will not do - and a router that answers on the port itself refuses
    // for the server. Neither says what the internet sees.
    if (throughOwnRouter) {
        return {
            verdict: "unverified",
            note: "Polaris is on the same network as this server, and its router did not pass the connection back in. Mail from outside may still arrive."
        };
    }
    if (outcome === "refused") {
        return { verdict: "fail", note: "The server answered that nothing is listening on this port." };
    }
    if (port === 25) {
        return {
            verdict: "unverified",
            note: "Nothing answered in time. Many networks block outbound port 25, so this check cannot tell a closed port from one Polaris is not allowed to reach."
        };
    }
    return {
        verdict: "warn",
        note: "Nothing answered in time. A firewall in front of the server may be dropping this port."
    };
}

// ---------------------------------------------------------------------------
// Sending through somebody else
// ---------------------------------------------------------------------------

/**
 * Relay providers. The hosts, ports, usernames and SPF includes are each
 * provider's published values; a provider whose SPF include is specific to the
 * account (Resend, Oracle) has none here on purpose - publishing a guessed one
 * turns a DNS check green for a mechanism the provider does not honour.
 */
export const RELAY_PROVIDERS = [
    {
        id: "ses",
        label: "Amazon SES",
        hostTemplate: "email-smtp.{region}.amazonaws.com",
        regional: true,
        defaultPort: 587,
        spfInclude: "include:amazonses.com",
        username: ""
    },
    {
        id: "sendgrid",
        label: "SendGrid",
        hostTemplate: "smtp.sendgrid.net",
        regional: false,
        defaultPort: 587,
        spfInclude: "include:sendgrid.net",
        username: "apikey"
    },
    {
        id: "mailgun",
        label: "Mailgun",
        hostTemplate: "smtp.mailgun.org",
        regional: false,
        defaultPort: 587,
        spfInclude: "include:mailgun.org",
        username: ""
    },
    {
        id: "postmark",
        label: "Postmark",
        hostTemplate: "smtp.postmarkapp.com",
        regional: false,
        defaultPort: 587,
        spfInclude: "include:spf.mtasv.net",
        username: ""
    },
    {
        id: "resend",
        label: "Resend",
        hostTemplate: "smtp.resend.com",
        regional: false,
        defaultPort: 587,
        spfInclude: "",
        username: "resend"
    },
    {
        id: "custom",
        label: "Another SMTP server",
        hostTemplate: "",
        regional: false,
        defaultPort: 587,
        spfInclude: "",
        username: ""
    }
] as const;

export type RelayProviderId = (typeof RELAY_PROVIDERS)[number]["id"];

export const RELAY_PROVIDER_IDS = RELAY_PROVIDERS.map((provider) => provider.id) as [
    RelayProviderId,
    ...RelayProviderId[]
];

export function relayProvider(id: string): (typeof RELAY_PROVIDERS)[number] {
    return RELAY_PROVIDERS.find((provider) => provider.id === id) ?? RELAY_PROVIDERS[RELAY_PROVIDERS.length - 1]!;
}

/** The SMTP host a relay setting resolves to, or null when it cannot. */
export function resolveRelayHost(input: { provider: string; host?: string; region?: string }): string | null {
    const spec = relayProvider(input.provider);
    if (spec.regional) {
        const region = input.region?.trim();
        return region && /^[a-z0-9-]+$/.test(region) ? spec.hostTemplate.replace("{region}", region) : null;
    }
    const explicit = input.host?.trim().toLowerCase();
    if (explicit) return explicit;
    return spec.hostTemplate || null;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const domainName = z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .refine((value) => isHostname(value) && value.includes("."), "That is not a domain name");

/** The part of an address before the @, as a mail server accepts it. */
const localPart = z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter the part before the @")
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/, "Use letters, digits, dots, dashes, underscores or plus");

const address = z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .regex(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/, "That is not an email address");

/** Why a mailbox password that is its own address is refused, in the words the
 *  dialog and the server both use (see `passwordMatchesIdentity`). */
export const MAILBOX_IDENTITY_PASSWORD_MESSAGE =
    "That password is too close to the mailbox's own address. Pick something unrelated to it.";

/** A password a mail client will be typing for years: long, and never
 *  something a script put a newline in. */
const mailboxPassword = z
    .string()
    .min(12, "Use at least 12 characters")
    .max(256)
    .refine((value) => !/[\r\n]/.test(value), "A password cannot contain a line break");

/** Setting a mail server up: where it runs, what it is called, and the first
 *  domain it serves. The name need not be under the domain - one server
 *  (mail.example.net) serves many domains. */
export const mailServerSetupSchema = z.object({
    /** "local" or a Host id. */
    serverId: z.string().trim().min(1).max(64),
    /** The server's own name: what its certificate is for and what MX points at. */
    hostname: domainName,
    /** The first domain it receives mail for. */
    domain: domainName
});

export type MailServerSetup = z.infer<typeof mailServerSetupSchema>;

export const mailDomainSchema = z.object({ serverId: z.string().uuid(), name: domainName });

/** Bytes in a megabyte, for the quota field the screen asks in megabytes. */
const MB = 1024 * 1024;

export const mailboxCreateSchema = z.object({
    serverId: z.string().uuid(),
    domainId: z.string().trim().min(1).max(64),
    localPart,
    description: z.string().trim().max(200).default(""),
    password: mailboxPassword,
    /** Megabytes; 0 for no quota. */
    quotaMb: z.coerce.number().int().min(0).max(10 * 1024 * 1024).default(0),
    /** Add it to the creator's own Mail app as well, with the same password. */
    addToMyMail: z.boolean().default(false)
});

export type MailboxCreateInput = z.infer<typeof mailboxCreateSchema>;

export function quotaBytes(quotaMb: number): number | null {
    return quotaMb > 0 ? quotaMb * MB : null;
}

export const mailboxPasswordSchema = z.object({
    serverId: z.string().uuid(),
    accountId: z.string().trim().min(1).max(64),
    password: mailboxPassword
});

export const mailboxQuotaSchema = z.object({
    serverId: z.string().uuid(),
    accountId: z.string().trim().min(1).max(64),
    quotaMb: z.coerce.number().int().min(0).max(10 * 1024 * 1024)
});

export const mailAliasesSchema = z.object({
    serverId: z.string().uuid(),
    accountId: z.string().trim().min(1).max(64),
    aliases: z.array(z.object({ localPart, domainId: z.string().trim().min(1).max(64) })).max(100)
});

export const mailForwardSchema = z.object({
    serverId: z.string().uuid(),
    domainId: z.string().trim().min(1).max(64),
    localPart,
    recipients: z.array(address).min(1, "Add at least one address").max(50),
    description: z.string().trim().max(200).default("")
});

export const mailCatchAllSchema = z.object({
    serverId: z.string().uuid(),
    domainId: z.string().trim().min(1).max(64),
    /** Null stops catching. */
    address: address.nullable()
});

export const mailRelaySchema = z
    .object({
        serverId: z.string().uuid(),
        /** Null sends directly to each recipient's server again. */
        provider: z.enum(RELAY_PROVIDER_IDS).nullable(),
        host: z.string().trim().max(253).default(""),
        region: z.string().trim().max(32).default(""),
        port: z.coerce.number().int().min(1).max(65535).default(587),
        username: z.string().trim().max(320).default(""),
        /** Empty keeps the stored one. */
        secret: z.string().max(1024).default("")
    })
    .superRefine((value, context) => {
        const provider = value.provider;
        if (provider === null) return;
        const host = resolveRelayHost({ provider, host: value.host, region: value.region });
        if (!host || !isHostname(host)) {
            const regional = relayProvider(provider).regional;
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [regional ? "region" : "host"],
                message: regional ? "Enter the region, like eu-west-1" : "Enter the SMTP host"
            });
        }
    });

export type MailRelayInput = z.infer<typeof mailRelaySchema>;

// ---------------------------------------------------------------------------
// Rules on incoming mail
// ---------------------------------------------------------------------------

/** A wildcard pattern: `*` is any run of characters, everything else literal,
 *  case ignored. What an operator types for "anything from @bank.example". */
const wildcard = z.string().trim().toLowerCase().max(320).default("");

export const mailInboundRuleSchema = z.object({
    serverId: z.string().uuid(),
    name: z.string().trim().min(1, "Name the rule").max(80),
    /** Which recipient it watches. Empty is every address on the server. */
    recipient: wildcard,
    /** Which senders it is about. Empty is anybody. */
    sender: wildcard,
    /** Whether mail the spam filter caught still counts. Off by default. */
    includeSpam: z.boolean().default(false),
    enabled: z.boolean().default(true)
});

export type MailInboundRuleInput = z.infer<typeof mailInboundRuleSchema>;

/** One message the server took in, as much of it as its event said. */
export interface InboundEvent {
    readonly spam: boolean;
    readonly from: string;
    readonly to: readonly string[];
    readonly autoSubmitted: boolean;
}

/** Whether a wildcard pattern matches a value. */
export function wildcardMatches(pattern: string, value: string): boolean {
    const wanted = pattern.trim().toLowerCase();
    if (!wanted) return true;
    const escaped = wanted.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value.trim().toLowerCase());
}

/** Addresses no rule ever fires on: the server's own, whose mail about mail is
 *  how a notice about a notice becomes a loop. */
const LOOPING_SENDERS = /^(?:mailer-daemon|postmaster|polaris|noreply|no-reply|dmarc|abuse)@/;

/**
 * Whether a rule fires for one message.
 *
 * Fails closed: an event that does not say who a message was for matches no
 * rule that names a recipient, rather than every one. Three guards come before
 * the rule is asked anything, because each is how a notification rule turns
 * into a flood: mail the spam filter caught (unless the rule asks for it), mail
 * a machine sent about mail (bounces, auto-replies), and mail from the server's
 * own system addresses.
 */
export function inboundRuleMatches(
    rule: { recipient: string; sender: string; includeSpam: boolean; enabled: boolean },
    event: InboundEvent
): boolean {
    if (!rule.enabled) return false;
    if (event.spam && !rule.includeSpam) return false;
    if (event.autoSubmitted) return false;
    if (LOOPING_SENDERS.test(event.from)) return false;
    if (rule.recipient) {
        if (event.to.length === 0) return false;
        if (!event.to.some((recipient) => wildcardMatches(rule.recipient, recipient))) return false;
    }
    if (rule.sender) {
        if (!event.from) return false;
        if (!wildcardMatches(rule.sender, event.from)) return false;
    }
    return true;
}

/**
 * Read one engine event into the fields a rule asks about.
 *
 * The event's `type` says ham or spam; its `data` is the engine's own record of
 * the message, keyed from the engine's fixed list of event keys (`from` and `to`
 * among them; there is no subject key, which is why a rule cannot ask about
 * one). Which of them a given event carries is the engine's business, so every
 * key that could name the sender or the recipients is looked for, and a missing
 * one is left empty rather than guessed at. What a rule cannot see, it does not
 * match on (see `inboundRuleMatches`).
 */
export function readInboundEvent(event: { type?: unknown; data?: unknown }): InboundEvent | null {
    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "message-ingest.ham" && type !== "message-ingest.spam") return null;
    const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
    const pick = (...keys: string[]): unknown => {
        for (const key of keys) if (data[key] !== undefined) return data[key];
        return undefined;
    };
    const asText = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");
    const asList = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.map(asText).filter(Boolean)
            : typeof value === "string"
              ? value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
              : [];
    const autoSubmitted = asText(pick("autoSubmitted", "auto_submitted", "precedence"));
    return {
        spam: type === "message-ingest.spam",
        from: asText(pick("from", "sender", "mailFrom", "returnPath")),
        to: asList(pick("to", "rcptTo", "recipients", "recipient")),
        autoSubmitted: autoSubmitted !== "" && autoSubmitted !== "no"
    };
}
