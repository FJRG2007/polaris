/**
 * The two deliverability facts that are not DNS records at a registrar: the
 * reverse name of the address mail leaves from, and whether the name the server
 * greets with resolves back to that same address.
 *
 * Every other check in `mail-dns` is about a record the operator publishes in
 * their own zone. These two are not theirs to publish - a reverse name is set by
 * whoever hands out the address, and the forward name has to agree with it - and
 * they are the pair large receivers check first. A server with perfect SPF, DKIM
 * and DMARC and no reverse name is one whose mail is refused at the door by
 * several of the biggest receivers before any of that is read.
 *
 * Pure: every lookup is the caller's, and what arrives here is the answers.
 */

/** How a check came out. `unverified` is "nothing could be checked", which is
 *  never the same as a pass and never the same as a failure. */
export type MailReverseVerdict = "pass" | "warn" | "fail" | "unverified";

export interface MailReverseCheck {
    readonly verdict: MailReverseVerdict;
    /** The reverse name the address answers with, or "". */
    readonly pointer: string;
    /** What it means, in one sentence. */
    readonly note: string;
    /** What to do about it, where there is something to do, or "". Names who
     *  sets it, because the operator will otherwise look for it at the registrar
     *  where every other record on these screens lives, and not find it. */
    readonly instruction: string;
}

/** What the lookups came back with. `null` is "the lookup itself failed", which
 *  is different from an empty answer - an empty answer is the DNS saying there
 *  is nothing there. */
export interface MailReverseLookup {
    /** The mail server's own name: its greeting, its certificate, its MX target. */
    readonly hostname: string;
    /** The public address mail leaves from, or null where there is none to check. */
    readonly address: string | null;
    /** The names the address reverse-resolves to. */
    readonly pointers: readonly string[] | null;
    /** The addresses the first reverse name forward-resolves to. A reverse name
     *  that does not resolve back is one a receiver treats as absent. */
    readonly pointerAddresses: readonly string[] | null;
    /** The addresses `hostname` resolves to. */
    readonly hostAddresses: readonly string[] | null;
}

/** A name, comparable: no trailing dot, no case. */
export function sameName(one: string, two: string): boolean {
    const flat = (name: string): string => name.trim().replace(/\.$/, "").toLowerCase();
    return flat(one) !== "" && flat(one) === flat(two);
}

/**
 * Names a provider hands out by the block rather than by the customer.
 *
 * Matched only to warn, never to fail: a receiver's own judgment of these is a
 * matter of its reputation data and not of the shape of the name, and telling
 * somebody their perfectly working reverse name is wrong would be worse than
 * saying nothing. What it is worth is naming the one thing that is genuinely
 * likely to be filing their mail as junk while every record shows green.
 */
const GENERIC_POINTER =
    /(^|\.)(ip|host|node|static|dynamic|dyn|dsl|cable|pool|client|customer|broadband|dhcp|res|user)[-.]?\d|(\d{1,3}[-.]){3}\d{1,3}/i;

/**
 * Grade the reverse name of the address mail leaves from.
 *
 * A pass needs all three of: a reverse name exists, it resolves back to the same
 * address (which is what stops anybody claiming any name they like), and it is
 * the name the server greets with. Anything less is said as what it is rather
 * than rounded to a failure, because mail from a forward-confirmed name that is
 * not the greeting name is accepted nearly everywhere - it is simply the next
 * thing to fix.
 */
export function gradeReverseName(lookup: MailReverseLookup): MailReverseCheck {
    if (!lookup.address) {
        return {
            verdict: "unverified",
            pointer: "",
            note: "There is no public address for this server yet, so its reverse name cannot be checked.",
            instruction: ""
        };
    }
    if (lookup.pointers === null) {
        return {
            verdict: "unverified",
            pointer: "",
            note: "The reverse name could not be looked up just now. Check again in a moment.",
            instruction: ""
        };
    }

    const setBy = `A reverse name is set by whoever gives you the address - the hosting provider or the internet provider - not at your DNS host. Ask them to point ${lookup.address} at ${lookup.hostname}.`;
    const pointer = lookup.pointers[0] ?? "";
    if (!pointer) {
        return {
            verdict: "fail",
            pointer: "",
            note: `${lookup.address} has no reverse name. Several large receivers refuse mail from an address with none, before they read anything else about it.`,
            instruction: setBy
        };
    }

    const confirms = (lookup.pointerAddresses ?? []).includes(lookup.address);
    if (!confirms) {
        return {
            verdict: "fail",
            pointer,
            note: `${lookup.address} reverse-resolves to ${pointer}, and ${pointer} does not resolve back to it. A receiver checking both reads that as no reverse name at all.`,
            instruction: setBy
        };
    }
    if (!sameName(pointer, lookup.hostname)) {
        return {
            verdict: "warn",
            pointer,
            note: `${lookup.address} reverse-resolves to ${pointer}, not to ${lookup.hostname}. Mail is accepted more readily when the greeting name and the reverse name are the same.`,
            instruction: setBy
        };
    }
    if (GENERIC_POINTER.test(pointer)) {
        return {
            verdict: "warn",
            pointer,
            note: `${pointer} reads as an address a provider hands out in a block. Receivers that judge on the shape of the name file mail from one as junk even when everything else passes.`,
            instruction: setBy
        };
    }
    return {
        verdict: "pass",
        pointer,
        note: `${lookup.address} reverse-resolves to ${pointer}, and it resolves back. This is the name the server greets with.`,
        instruction: ""
    };
}

/**
 * Grade the forward name: whether the name the server announces itself as is a
 * name that leads back to it.
 *
 * A greeting name that does not resolve at all is refused outright by servers
 * that check it, and it is also the name on the certificate and the MX target -
 * so it failing here means rather more than one warning.
 */
export function gradeGreetingName(lookup: MailReverseLookup): MailReverseCheck {
    if (lookup.hostAddresses === null) {
        return {
            verdict: "unverified",
            pointer: lookup.hostname,
            note: `${lookup.hostname} could not be looked up just now. Check again in a moment.`,
            instruction: ""
        };
    }
    const publish = `Publish an A record for ${lookup.hostname}${lookup.address ? ` pointing at ${lookup.address}` : ""} at your DNS host.`;
    if (lookup.hostAddresses.length === 0) {
        return {
            verdict: "fail",
            pointer: lookup.hostname,
            note: `${lookup.hostname} does not resolve. It is the name this server greets other servers with, the name on its certificate and the target of its MX record, so nothing reaches it and its mail is refused by servers that check the greeting.`,
            instruction: publish
        };
    }
    if (!lookup.address) {
        return {
            verdict: "unverified",
            pointer: lookup.hostname,
            note: `${lookup.hostname} resolves, but there is no known public address to compare it with.`,
            instruction: ""
        };
    }
    if (!lookup.hostAddresses.includes(lookup.address)) {
        return {
            verdict: "warn",
            pointer: lookup.hostname,
            note: `${lookup.hostname} resolves to ${lookup.hostAddresses.join(", ")}, and mail leaves from ${lookup.address}. A receiver checking the greeting against the sending address will not see a match.`,
            instruction: publish
        };
    }
    return {
        verdict: "pass",
        pointer: lookup.hostname,
        note: `${lookup.hostname} resolves to ${lookup.address}, which is where mail leaves from.`,
        instruction: ""
    };
}

/** The worse of the two, for one badge over the pair. */
export function reverseOverall(checks: readonly MailReverseCheck[]): MailReverseVerdict {
    if (checks.some((check) => check.verdict === "fail")) return "fail";
    if (checks.some((check) => check.verdict === "warn")) return "warn";
    if (checks.length > 0 && checks.every((check) => check.verdict === "pass")) return "pass";
    return "unverified";
}
