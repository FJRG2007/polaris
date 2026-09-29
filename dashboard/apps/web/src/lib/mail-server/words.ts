/**
 * The mail server's words that @polaris/core writes in English: its schemas'
 * complaints, the ports it needs and what each one is for, and what a port check
 * concluded. Core keeps them in English because the server validates with the same
 * schemas; the screen matches the English back to its key in the `mailServer`
 * catalog. A sentence it does not know - a newer core, zod's own default -
 * passes through as it was written.
 */

import { BREACHED_PASSWORD_MESSAGE, MAILBOX_IDENTITY_PASSWORD_MESSAGE } from "@polaris/core";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { mailServerRefusalText } from "./refusal-text";

type Words = NamespaceTranslator<"mailServer">;
type Key = NamespaceKey<"mailServer">;

const SCHEMA: Readonly<Record<string, Key>> = {
    "That is not a domain name": "schema.domain",
    "Enter the part before the @": "schema.localPartMissing",
    "Use letters, digits, dots, dashes, underscores or plus": "schema.localPartChars",
    "That is not an email address": "schema.address",
    [MAILBOX_IDENTITY_PASSWORD_MESSAGE]: "schema.passwordIdentity",
    [BREACHED_PASSWORD_MESSAGE]: "schema.passwordBreached",
    "Use at least 12 characters": "schema.passwordLength",
    "A password cannot contain a line break": "schema.passwordLineBreak",
    "Add at least one address": "schema.recipients",
    "Enter the region, like eu-west-1": "schema.region",
    "Enter the SMTP host": "schema.host",
    "Name the rule": "schema.ruleName"
};

/** A schema's complaint in the reader's words, or null when there is none. */
export function mailSchemaText(t: Words, message: string | undefined): string | null {
    if (!message) return null;
    const key = SCHEMA[message];
    return key ? t(key) : message;
}

/** The ports a mail server needs, by number: `ports.<port>.label` / `.purpose`. */
const PORTS = new Set([25, 465, 587, 993, 4190]);

export function portWords(
    t: Words,
    port: { port: number; label: string; purpose: string }
): { label: string; purpose: string } {
    if (!PORTS.has(port.port)) return port;
    return {
        label: t(`ports.p${port.port}.label` as Key),
        purpose: t(`ports.p${port.port}.purpose` as Key)
    };
}

/** What a check concluded - a port, the engine, the certificate, a record, the
 *  reverse name - by the English core and the services write it in. */
const NOTES: Readonly<Record<string, Key>> = {
    "Polaris is on the same network as this server, and its router did not pass the connection back in. Mail from outside may still arrive.":
        "ports.notes.hairpin",
    "The server answered that nothing is listening on this port.": "ports.notes.refused",
    "Nothing answered in time. Many networks block outbound port 25, so this check cannot tell a closed port from one Polaris is not allowed to reach.":
        "ports.notes.timeout25",
    "Nothing answered in time. A firewall in front of the server may be dropping this port.": "ports.notes.timeout",
    "The mail server's service is missing. Repair it from the start.": "notes.serviceMissing",
    "The mail server could not be reached.": "notes.unreachable",
    "The mail server is not answering. It may be stopped or restarting.": "notes.notAnswering",
    "Setup has not finished yet.": "notes.setupUnfinished",
    "The mail server no longer accepts Polaris's administrator account. Repair it from the administrator step.":
        "notes.adminRejected",
    "There is no address to check it at yet.": "notes.noAddress",
    "The certificate expires within two weeks and has not been renewed yet.": "notes.certSoon",
    "Port 465 did not answer, so the certificate could not be read.": "notes.certNoAnswer",
    "Port 465 did not complete a secure connection.": "notes.certNoTls",
    "The public resolvers did not answer for this name.": "notes.resolversSilent",
    "Polaris cannot look this record type up.": "notes.cannotLookUp",
    "Only meaningful on a zone signed with DNSSEC; publish it yourself if yours is.": "notes.dnssecOnly",
    "The SPF already published covers this server.": "notes.spfCovers",
    "Adds this server to the SPF already published, keeping everything in it.": "notes.spfAdds",
    "A DMARC policy is already published; it is kept.": "notes.dmarcKept",
    "Mail for this domain goes somewhere else today. It is left there unless you replace it.": "notes.mxElsewhere",
    "Something else is published at this name. It is left there unless you replace it.": "notes.somethingElseKept",
    "Cloudflare refused it": "notes.cloudflareRefused",
    "There are two SPF records, which makes both invalid. Keep one.": "notes.spfTwo",
    "No SPF record is published.": "notes.spfNone",
    "An SPF record is published with more in it than this server needs. Mail still passes.": "notes.spfMore",
    "The published SPF record does not include this server.": "notes.spfMissing",
    "No DMARC policy is published.": "notes.dmarcNone",
    "A different DMARC policy is published. It is valid; reports may go elsewhere.": "notes.dmarcOther",
    "Nothing is published at this name yet.": "notes.nothingYet",
    "Not published. Mail works without it.": "notes.optional",
    "Something else is published at this name.": "notes.somethingElse",
    "There is no public address for this server yet, so its reverse name cannot be checked.": "notes.ptrNoAddress",
    "The reverse name could not be looked up just now. Check again in a moment.": "notes.ptrLookupFailed",
    // The descriptions Polaris gives the mailboxes it creates on the engine.
    "Polaris manages this mail server with this account.": "notes.adminMailbox",
    "Polaris sends its own mail from this mailbox.": "notes.senderMailbox",
    "DMARC reports about this server's domains arrive here; Polaris reads and files them.": "notes.reportsMailbox"
};

/** The same, for sentences that carry a name, an address or a reason. */
const SHAPED_NOTES: readonly (readonly [RegExp, Key, readonly string[]])[] = [
    [
        /^(\S+) does not resolve yet, and this network has no public address to check instead\. Publish its DNS records first\.$/,
        "notes.hostUnresolved",
        ["host"]
    ],
    [
        /^Mail apps will refuse this certificate \((.+)\)\. It is usually the engine's own until its certificate for (\S+) is issued\.$/,
        "notes.certRefused",
        ["reason", "host"]
    ],
    [/^Outside (\S+); add it at your DNS host\.$/, "notes.outside", ["root"]],
    [/^Replaced (.+)$/, "notes.replaced", ["values"]],
    [
        /^A reverse name is set by whoever gives you the address - the hosting provider or the internet provider - not at your DNS host\. Ask them to point (\S+) at (\S+)\.$/,
        "notes.ptrSetBy",
        ["address", "host"]
    ],
    [
        /^(\S+) has no reverse name\. Several large receivers refuse mail from an address with none, before they read anything else about it\.$/,
        "notes.ptrNone",
        ["address"]
    ],
    [
        /^(\S+) reverse-resolves to (\S+), and \S+ does not resolve back to it\. A receiver checking both reads that as no reverse name at all\.$/,
        "notes.ptrNotConfirmed",
        ["address", "pointer"]
    ],
    [
        /^(\S+) reverse-resolves to (\S+), not to (\S+)\. Mail is accepted more readily when the greeting name and the reverse name are the same\.$/,
        "notes.ptrOtherName",
        ["address", "pointer", "host"]
    ],
    [
        /^(\S+) reads as an address a provider hands out in a block\. Receivers that judge on the shape of the name file mail from one as junk even when everything else passes\.$/,
        "notes.ptrGeneric",
        ["pointer"]
    ],
    [
        /^(\S+) reverse-resolves to (\S+), and it resolves back\. This is the name the server greets with\.$/,
        "notes.ptrPass",
        ["address", "pointer"]
    ],
    [/^(\S+) could not be looked up just now\. Check again in a moment\.$/, "notes.hostLookupFailed", ["host"]],
    [/^Publish an A record for (\S+) pointing at (\S+) at your DNS host\.$/, "notes.publishAPointing", ["host", "address"]],
    [/^Publish an A record for (\S+) at your DNS host\.$/, "notes.publishA", ["host"]],
    [
        /^(\S+) does not resolve\. It is the name this server greets other servers with, the name on its certificate and the target of its MX record, so nothing reaches it and its mail is refused by servers that check the greeting\.$/,
        "notes.greetingUnresolved",
        ["host"]
    ],
    [/^(\S+) resolves, but there is no known public address to compare it with\.$/, "notes.greetingNoAddress", ["host"]],
    [
        /^(\S+) resolves to (.+), and mail leaves from (\S+)\. A receiver checking the greeting against the sending address will not see a match\.$/,
        "notes.greetingMismatch",
        ["host", "addresses", "address"]
    ],
    [/^(\S+) resolves to (\S+), which is where mail leaves from\.$/, "notes.greetingPass", ["host", "address"]]
];

/** Every English sentence the notes table knows, for the test that holds the catalog to it. */
export const KNOWN_MAIL_NOTES: readonly string[] = Object.keys(NOTES);

/** What a check concluded, in the reader's words. A sentence this does not know -
 *  the engine's own, a newer service's - passes through. */
export function mailNoteText(t: Words, note: string | null | undefined): string | null {
    if (!note) return null;
    const key = NOTES[note];
    if (key) return t(key);
    for (const [pattern, shaped, names] of SHAPED_NOTES) {
        const match = pattern.exec(note);
        if (!match) continue;
        return t(shaped, Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? ""])));
    }
    return mailServerRefusalText(t, note);
}

/** What a port check concluded, in the reader's words. */
export function portNote(t: Words, note: string | null | undefined): string | null {
    return mailNoteText(t, note);
}
