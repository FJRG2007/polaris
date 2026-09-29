/**
 * Why the junk filter said what it said, in the reader's language.
 *
 * The filter (`@polaris/core` mailbox-spam, and the reputation checks under
 * `lib/mailbox`) writes its reasons in English and the message keeps them as
 * written, so the banner translates them where it draws them: the sentences it
 * writes by itself come from `mail.spam`, looked up by their English or by their
 * shape, and anything else - what an outside reputation service said - is shown
 * as it came.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type MailKey = NamespaceKey<"mail">;

const FIXED: Readonly<Record<string, MailKey>> = {
    "The address it claims to be from does not allow this server to send for it": "spam.spf",
    "Its signature does not check out": "spam.dkim",
    "It was not sent from a server the domain lists": "spam.notListed",
    "A link points at a bare address instead of a name": "spam.bareAddress",
    "A link uses a name written in another alphabet": "spam.otherAlphabet",
    "A link hides where it goes behind a shortener": "spam.shortener",
    "A link points into a part of a site that is meant for machines, not people": "spam.machinePath",
    "It is mostly links": "spam.mostlyLinks",
    "The subject is dressed up as an alert": "spam.alert",
    "The subject is decorated with pictures": "spam.pictures",
    "The subject promises an amount of money": "spam.money",
    "It asks you to go and confirm your account details": "spam.confirmAccount",
    "The subject is all capitals": "spam.capitals",
    "The subject is shouting": "spam.shouting",
    "It has no text in it at all, only pictures": "spam.onlyPictures",
    "It is not addressed to anybody": "spam.nobody",
    "Its Privacy and Terms links do not go anywhere": "spam.deadLinks",
    "Every link under it goes to the same page, whatever it says": "spam.sameLink",
    "It says it is a mailing list but publishes no way to leave it": "spam.noLeave",
    "Nothing vouches for the domain it says it came from": "spam.unvouched",
    "This sender has repeatedly been marked as junk": "spam.senderJunk",
    "This domain has repeatedly been marked as junk": "spam.domainJunk",
    "Messages like this one have repeatedly been marked as junk": "spam.fingerprintJunk",
    "Its wording matches what you have marked as junk": "spam.learned",
    "You blocked this sender": "spam.blocked",
    "You marked this as junk": "spam.marked"
};

/** Reasons that carry a value, by the shape of their English. */
const SHAPED: readonly { readonly pattern: RegExp; readonly key: MailKey; readonly params: readonly string[] }[] = [
    { pattern: /^A link says (.+) and goes to (.+)$/, key: "spam.linkSays", params: ["said", "target"] },
    { pattern: /^The subject has an email address in it \((.+)\)$/, key: "spam.subjectAddress", params: ["address"] },
    { pattern: /^The subject pushes for a decision \("(.+)"\)$/, key: "spam.subjectUrgent", params: ["words"] },
    { pattern: /^The subject shouts from a bracket \("(.+)"\)$/, key: "spam.subjectBracket", params: ["words"] },
    {
        pattern: /^It came from (.+), which borrows (.+)'s name and is not theirs \((.+) is\)$/,
        key: "spam.cousin",
        params: ["sent", "brand", "home"]
    },
    {
        pattern: /^It says it is (.+?)(, written with something inserted into the name)?, it did not come from (.+), and it is asking for your account$/,
        key: "spam.brandPhish",
        params: ["brand", "dressed", "home"]
    },
    {
        pattern: /^It says it is (.+?)(, written with something inserted into the name)?, and it did not come from (.+)$/,
        key: "spam.brand",
        params: ["brand", "dressed", "home"]
    },
    { pattern: /^Replies would go to (.+), not to (.+)$/, key: "spam.replyTo", params: ["reply", "from"] },
    { pattern: /^It shows itself as (.+) but was sent by (.+)$/, key: "spam.posing", params: ["posing", "sender"] },
    {
        pattern: /^It carries a file that would run when opened \((.+)\)$/,
        key: "spam.dangerousFile",
        params: ["file"]
    },
    {
        pattern: /^It pushes \("(.+)"\) and nobody here has written to this sender$/,
        key: "spam.pushes",
        params: ["words"]
    },
    {
        pattern: /^The domain it came from, (.+), is known for defrauding people$/,
        key: "spam.fraud",
        params: ["domain"]
    },
    { pattern: /^(\d+) security engines flag this domain$/, key: "spam.engines", params: ["count"] },
    { pattern: /^(.+) is flagged by security engines$/, key: "spam.flagged", params: ["subject"] }
];

export function spamReasonText(t: NamespaceTranslator<"mail">, reason: string): string {
    const fixed = FIXED[reason];
    if (fixed) return t(fixed);
    for (const { pattern, key, params } of SHAPED) {
        const found = pattern.exec(reason);
        if (!found) continue;
        const values = Object.fromEntries(params.map((name, index) => [name, found[index + 1] ?? ""]));
        // The one optional part: an obfuscated brand name says so.
        if ("dressed" in values) values.dressed = values.dressed ? "yes" : "no";
        return t(key, values);
    }
    return reason;
}
