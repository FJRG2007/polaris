/**
 * Deciding whether a message is junk, here rather than somewhere else.
 *
 * Polaris is a mail client, so this is not the first filter a message meets:
 * the provider has already had its go, and the Junk folder mirrors whatever it
 * decided. That is exactly the problem. The provider's filter is trained on
 * everybody's mail and knows nothing about this mailbox - it has never seen who
 * this person writes to, what they have already said is junk, or what they
 * fished back out of Junk and said was not. So the mail that gets through is
 * reliably the mail a filter with that knowledge would have caught.
 *
 * **Nothing leaves the machine.** No score is looked up, no hash is submitted,
 * no message is sent anywhere to be classified. Everything below reads what is
 * already on the row, and the only thing it learns from is somebody pressing
 * "junk" or "not junk" on their own mail. A spam filter that phones home is a
 * copy of somebody's correspondence going to a third party, which is a worse
 * outcome than the spam.
 *
 * The scale is 0 to 100, and the two thresholds are what turn a number into a
 * decision. Below 40 nothing happens. From 40 to 69 the message is delivered
 * normally and marked suspicious, which the reading pane says out loud and the
 * list can filter on. At 70 and above it goes to Junk.
 *
 * **Everything here is pure.** Given the message and the few numbers that had to
 * be read from the database - what this mailbox thinks of the sender, what its
 * token counts say - it answers with a score and the reasons behind it, and
 * touches nothing. That is what makes it testable, which for a filter matters
 * more than usual: the failure mode is somebody's real mail disappearing, and
 * the only way to be sure that does not happen is to be able to run the thing on
 * a message and read what it thought.
 *
 * Conservative in one direction on purpose, the same way the categoriser is:
 * everything it is unsure about is delivered. Junk in the inbox is an
 * annoyance; an invoice in Junk is the feature doing harm.
 */

import { baseDomain } from "./vault-uris.js";

/** What each band means. Two numbers, and the whole of the policy. */
export const SPAM_THRESHOLDS = { suspicious: 40, junk: 70 } as const;

/** What a message was judged to be. */
export type SpamVerdict = "clean" | "suspicious" | "junk";

/** One reason, with what it was worth. Negative scores are the ones arguing the
 *  message is legitimate, and they matter as much: a filter that can only accuse
 *  is one that eventually accuses a colleague. */
export interface SpamSignal {
    /** A stable key, so a signal can be pointed at from a test or a report
     *  without matching on its sentence. */
    readonly id: string;
    readonly score: number;
    /** Said as somebody reading their own mail would want it said. */
    readonly reason: string;
}

export interface SpamJudgement {
    readonly score: number;
    readonly verdict: SpamVerdict;
    readonly signals: readonly SpamSignal[];
    /** The strongest reason, for the one line a message view has room for. */
    readonly reason: string;
    /** What this message looks like, for recognising the next copy of it. */
    readonly fingerprint: string;
}

/**
 * What each kind of evidence is worth.
 *
 * Gathered in one place rather than scattered through the analysers, because
 * this table IS the filter's behaviour and it has to be readable as a whole.
 * The relationship weights are deliberately the largest negatives here: having
 * written to somebody is the strongest single piece of evidence a client has,
 * and it is evidence no provider-side filter can see.
 */
export const SPAM_WEIGHTS = {
    authentication: {
        dmarcFail: 18,
        dmarcPass: -8,
        dkimFail: 8,
        dkimPass: -4,
        spfFail: 6,
        spfPass: -2
    },
    relationships: {
        /** They are in this mailbox's address book because somebody put them
         *  there. */
        knownContact: -15,
        /** This mailbox has written to them. Nearly conclusive. */
        writtenTo: -25
    },
    reputation: { establishedJunk: 25, establishedGood: -15 },
    /** The ceiling on everything learned from words, so no amount of token
     *  evidence can decide a message on its own. */
    content: { maximum: 30 }
} as const;

/** How far the learned-words half is allowed to move a message, either way. */
export const MAX_CONTENT_SCORE = SPAM_WEIGHTS.content.maximum;

/* -------------------------------------------------------------------------- */
/* What the filter reads                                                       */
/* -------------------------------------------------------------------------- */

/** The message, in the shape the row already holds it. No body is fetched to
 *  decide this: what has been downloaded is what is judged. */
export interface JudgeableMessage {
    readonly subject: string;
    readonly fromAddress: string;
    readonly fromName: string;
    readonly replyToAddress: string;
    /** Every address the message was sent to, so a message addressed to nobody
     *  in particular can be told from one addressed to this person. */
    readonly toAddresses: readonly string[];
    readonly snippet: string;
    readonly bodyText: string;
    readonly bodyHtml: string;
    readonly listId: string;
    readonly hasAttachments: boolean;
    readonly attachmentNames: readonly string[];
    /** The headers Polaris keeps, lowercased keys. `authentication-results` is
     *  the one that matters most here. */
    readonly headers: Readonly<Record<string, string>> | null;
}

/** What had to be read from the database before the pure part could run. */
export interface SpamKnowledge {
    /** This mailbox has the sender in its address book. */
    readonly knownContact: boolean;
    /** This mailbox has sent mail to the sender. */
    readonly writtenTo: boolean;
    /** The sender is on the blocked list, which ends the question. */
    readonly blocked: boolean;
    /**
     * What this mailbox has learned about the sender, their domain and this
     * shape of message, as counts of junk and not-junk.
     *
     * Only the strongest of them is used, so a sender whose domain is bad and
     * whose address is bad is not punished twice for the same thing.
     */
    readonly reputation: readonly SpamReputation[];
    /**
     * What the learned words say, already summed and already bounded to
     * `MAX_CONTENT_SCORE`. Zero when this mailbox has not been taught anything
     * yet, which is every mailbox on its first day.
     */
    readonly contentScore: number;
    /**
     * What somebody outside this mailbox says about the sender - a reputation
     * provider the operator configured, already asked and already turned into
     * signals by the half of the filter that can reach the network.
     *
     * Absent is the normal case: no provider configured, none that had heard of
     * this sender, or one that did not answer. Silence contributes nothing at
     * all rather than a small penalty, which is why this is a list and not a
     * number.
     */
    readonly outside?: readonly SpamSignal[];
}

export interface SpamReputation {
    readonly kind: "sender" | "domain" | "fingerprint";
    readonly junkCount: number;
    readonly goodCount: number;
}

/** How many times an identity has to have been judged before its record counts.
 *  One person pressing Junk once is not a reputation. */
export const REPUTATION_FLOOR = 3;

/* -------------------------------------------------------------------------- */
/* Reading a message                                                           */
/* -------------------------------------------------------------------------- */

/** The domain of an address, lowercased, or "". */
export function domainOf(address: string): string {
    const at = address.lastIndexOf("@");
    return at < 0
        ? ""
        : address
              .slice(at + 1)
              .trim()
              .toLowerCase();
}

/** Every link in the message, as hosts. Read from the HTML when there is any,
 *  and from the text when there is not. */
export function linkHosts(message: Pick<JudgeableMessage, "bodyHtml" | "bodyText">): string[] {
    const found = new Set<string>();
    const source = `${message.bodyHtml} ${message.bodyText}`;
    for (const match of source.matchAll(/https?:\/\/([^\s"'<>)\]]+)/gi)) {
        const authority = (match[1] ?? "").split("/")[0] ?? "";
        // Credentials in front of the host are a phishing idiom in themselves,
        // and taking them off is also what stops `evil.com` being read as the
        // host of `https://bank.com@evil.com/`.
        const host = (authority.split("@").pop() ?? "").split(":")[0]?.toLowerCase() ?? "";
        if (host) found.add(host);
    }
    return [...found];
}

/**
 * What a message looks like, as a short string.
 *
 * Used to recognise the next copy of the same campaign when it arrives from a
 * different address, which is the whole trick behind a mailing that rotates its
 * sender. Built from the shape rather than the words - how long the subject is,
 * how many links, whether there are attachments - so it survives the small
 * personalisations these messages carry and does not become a way of storing
 * what somebody's mail said.
 */
export function spamFingerprint(message: JudgeableMessage): string {
    const body = message.bodyText || message.snippet;
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    const shape = [
        // Bucketed, so "a bit longer" is not a different message.
        Math.min(9, Math.floor(message.subject.length / 12)),
        Math.min(9, Math.floor(words / 40)),
        Math.min(9, linkHosts(message).length),
        message.hasAttachments ? 1 : 0,
        message.listId ? 1 : 0,
        // The first and last letters of the subject, lowercased and stripped of
        // anything that is not a letter: enough to separate two mailings of the
        // same shape, and nowhere near enough to read one back.
        (message.subject.toLowerCase().match(/[a-z]/g) ?? []).slice(0, 2).join(""),
        (message.subject.toLowerCase().match(/[a-z]/g) ?? []).slice(-2).join("")
    ];
    return shape.join(":");
}

/* -------------------------------------------------------------------------- */
/* The analysers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the receiving server said about who sent this.
 *
 * `Authentication-Results` is written by the mail server that accepted the
 * message, which is the one piece of evidence here that cannot be forged by the
 * sender - so it is weighted accordingly. A DMARC failure means the domain the
 * message claims to be from has published a policy and this message does not
 * satisfy it, which for the domains anybody impersonates is close to conclusive.
 *
 * Absent entirely on servers that do not write it, and then this contributes
 * nothing rather than guessing. A mailbox on such a server simply leans harder
 * on everything else.
 */
export function authenticationSignals(
    headers: Readonly<Record<string, string>> | null
): SpamSignal[] {
    const line = (headers?.["authentication-results"] ?? "").toLowerCase();
    if (!line) return [];
    const signals: SpamSignal[] = [];
    const read = (method: "dmarc" | "dkim" | "spf"): "pass" | "fail" | "" => {
        const found = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`).exec(line);
        const outcome = found?.[1] ?? "";
        if (outcome === "pass") return "pass";
        // `none`, `neutral` and `temperror` are not failures: they mean nobody
        // said, and treating "nobody said" as "it is forged" would mark half the
        // mail from small domains as junk.
        if (outcome === "fail" || outcome === "softfail" || outcome === "permerror") return "fail";
        return "";
    };

    const dmarc = read("dmarc");
    // A pass only counts in the message's favour while DMARC is not saying the
    // opposite. Anybody can sign their own domain, so DKIM passing for
    // `sender.example.ru` says nothing good about a message claiming to be from
    // a bank - and subtracting points for it is how an impersonation ends up
    // scoring lower than the shouting newsletter next to it.
    const vouched = dmarc !== "fail";
    if (dmarc === "fail") {
        signals.push({
            id: "dmarc_fail",
            score: SPAM_WEIGHTS.authentication.dmarcFail,
            reason: "The address it claims to be from does not allow this server to send for it"
        });
    } else if (dmarc === "pass") {
        signals.push({
            id: "dmarc_pass",
            score: SPAM_WEIGHTS.authentication.dmarcPass,
            reason: "The sending domain vouches for this message"
        });
    }

    const dkim = read("dkim");
    if (dkim === "fail") {
        signals.push({
            id: "dkim_fail",
            score: SPAM_WEIGHTS.authentication.dkimFail,
            reason: "Its signature does not check out"
        });
    } else if (dkim === "pass" && vouched) {
        signals.push({
            id: "dkim_pass",
            score: SPAM_WEIGHTS.authentication.dkimPass,
            reason: "Its signature checks out"
        });
    }

    const spf = read("spf");
    if (spf === "fail") {
        signals.push({
            id: "spf_fail",
            score: SPAM_WEIGHTS.authentication.spfFail,
            reason: "It was not sent from a server the domain lists"
        });
    } else if (spf === "pass" && vouched) {
        signals.push({
            id: "spf_pass",
            score: SPAM_WEIGHTS.authentication.spfPass,
            reason: "It came from a server the domain lists"
        });
    }
    return signals;
}

/**
 * The `/.well-known/` names a real service links a PERSON to.
 *
 * Almost nothing in that directory is meant to be followed by hand, which is why
 * a link into it is worth points at all - but these few are, and they turn up in
 * exactly the mail that must not be filed as junk. `change-password` is the
 * W3C's registered address for "change your password here" and is what a
 * password or breach notice links to; `security.txt` is what a disclosure page
 * points at. Written without the leading slash, which is how they are compared.
 */
const HUMAN_WELL_KNOWN: readonly string[] = ["change-password", "security.txt"];

/** Link shorteners, which are not evidence on their own and are evidence
 *  alongside anything else: their whole purpose is that the destination cannot
 *  be read. */
const SHORTENERS: readonly string[] = [
    "bit.ly",
    "tinyurl.com",
    "goo.gl",
    "t.co",
    "ow.ly",
    "is.gd",
    "buff.ly",
    "cutt.ly",
    "rb.gy",
    "shorturl.at",
    "rebrand.ly",
    "t.ly"
];

/**
 * What the links say.
 *
 * The one that catches real phishing is the last: a link whose text says one
 * domain and whose destination is another. Legitimate mail does it too - a
 * tracking redirector is exactly that shape - so it is worth points rather than
 * a verdict, and a redirector on the sender's own domain is not counted at all.
 */
export function urlSignals(message: JudgeableMessage): SpamSignal[] {
    const signals: SpamSignal[] = [];
    const hosts = linkHosts(message);
    if (hosts.length === 0) return signals;

    if (hosts.some((host) => /^\d+\.\d+\.\d+\.\d+$/.test(host))) {
        signals.push({
            id: "url_ip_literal",
            score: 14,
            reason: "A link points at a bare address instead of a name"
        });
    }
    if (hosts.some((host) => host.startsWith("xn--") || host.includes(".xn--"))) {
        signals.push({
            id: "url_punycode",
            score: 10,
            reason: "A link uses a name written in another alphabet"
        });
    }
    const shortened = hosts.filter((host) => SHORTENERS.includes(baseDomain(host)));
    if (shortened.length > 0) {
        signals.push({
            id: "url_shortener",
            score: 6,
            reason: "A link hides where it goes behind a shortener"
        });
    }
    // A link into `/.well-known/`, other than the few names that were registered
    // for a person to follow. That directory exists so that machines can find a
    // site's certificate challenges, its security contact and its app
    // associations, and what puts one of THOSE in an email is a phishing kit
    // dropped on a server somebody else owns: `.well-known` is writable on a
    // badly configured host, it is excluded from most site scans, and it
    // survives longer there than anywhere else on the domain.
    // `/.well-known/css/` and `/.well-known/pki/` are the two that turn up most.
    if (
        [
            ...`${message.bodyHtml} ${message.bodyText}`.matchAll(
                /https?:\/\/[^\s"'<>)\]]*\/\.well-known\/([^\s"'<>)\]\/?#]*)/gi
            )
        ].some((match) => !HUMAN_WELL_KNOWN.includes((match[1] ?? "").toLowerCase()))
    ) {
        signals.push({
            id: "url_well_known",
            score: 20,
            reason: "A link points into a part of a site that is meant for machines, not people"
        });
    }
    if (hosts.length > 25) {
        signals.push({
            id: "url_many",
            score: 5,
            reason: "It is mostly links"
        });
    }

    const senderBase = baseDomain(domainOf(message.fromAddress));
    for (const match of message.bodyHtml.matchAll(
        /<a\b[^>]*href\s*=\s*["']https?:\/\/([^/"'?#]+)[^"']*["'][^>]*>([\s\S]{0,200}?)<\/a>/gi
    )) {
        const target = baseDomain((match[1] ?? "").split("@").pop() ?? "");
        const text = (match[2] ?? "").replace(/<[^>]*>/g, " ");
        const claimed = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text);
        const said = baseDomain(claimed?.[1] ?? "");
        if (!said || !target || said === target) continue;
        // A link on the sender's own domain saying somebody else's name is a
        // newsletter quoting a site, not a disguise.
        if (target === senderBase) continue;
        signals.push({
            id: "url_disguised",
            score: 22,
            reason: `A link says ${said} and goes to ${target}`
        });
        break;
    }
    return signals;
}

/* -------------------------------------------------------------------------- */
/* What the subject line says                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Words that exist to stop somebody thinking.
 *
 * Not "important" or "urgent" on their own - a colleague writes those. These are
 * the constructions that manufacture a deadline or a consequence, which is the
 * one thing every phishing subject has in common regardless of what it is
 * pretending to be: a delivery, a bank, a domain registrar, a prize.
 */
const URGENCY: readonly string[] = [
    "action required",
    "immediate action",
    "act now",
    "final notice",
    "last chance",
    "expires today",
    "expiring soon",
    "within 24 hours",
    "24h only",
    "24 hours only",
    "verify your account",
    "verify now",
    "confirm your account",
    "we need your confirmation",
    "needs your confirmation",
    "delivery attempt failed",
    "failed delivery",
    "undelivered",
    "will be suspended",
    "will be closed",
    "will be deleted",
    "unusual activity",
    "unauthorized access",
    "limited time",
    // The same constructions in the languages a Spanish or Portuguese mailbox
    // actually receives them in.
    "accion requerida",
    "acción requerida",
    "verifica tu cuenta",
    "verifique su cuenta",
    "confirma tu cuenta",
    "ultimo aviso",
    "último aviso",
    "su cuenta sera",
    "su cuenta será",
    "acao necessaria",
    "ação necessária"
];

/**
 * The marks a subject wears to look like an alert.
 *
 * Deliberately narrow. This is not "contains an emoji" - a newsletter puts a sun
 * in its weather subject and a colleague sends a party hat - it is the small set
 * that impersonates a system notice, which is a different intent. The warning
 * triangle is the one that appears most, by a distance.
 */
const ALARM_MARKS = /[⚠‼❗❕]|\u{1F514}|\u{1F6A8}|\u{1F534}/u;

/** Anything pictographic, for the weaker "this is decorated" signal. */
const PICTOGRAPH = /[☀-➿]|[\u{1F300}-\u{1FAFF}]/u;

/** An amount of money, in the currencies these arrive in. */
const MONEY = /[$£€]\s?\d[\d,.]{2,}|\d[\d,.]{2,}\s?(?:usd|eur|gbp|dollars|euros)/i;

/**
 * What the subject line is doing.
 *
 * Every one of these is deliberately small. A subject is the least reliable
 * thing in a message - free text a stranger chose - so no combination of them
 * alone reaches the threshold that files a message away. Together they can reach
 * the one that shows a warning, which is the honest ceiling for evidence of this
 * kind: a person can look at a warning and disagree, and cannot look at a
 * message that was filed while they were not watching.
 */
export function subjectSignals(message: JudgeableMessage): SpamSignal[] {
    const signals: SpamSignal[] = [];
    const subject = message.subject.trim();
    if (!subject) return signals;
    const lower = subject.toLowerCase();

    // An address in the subject. Legitimate mail does this - a receipt naming
    // the account it belongs to - so it is worth points rather than a verdict.
    // What makes it suspicious is that it is how a template is made to look
    // personally addressed, and the address it names is always the reader's own.
    const address = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(subject);
    if (address) {
        signals.push({
            id: "subject_address",
            score: 14,
            reason: `The subject has an email address in it (${address[0]})`
        });
    }

    if (ALARM_MARKS.test(subject)) {
        signals.push({
            id: "subject_alarm_mark",
            score: 8,
            reason: "The subject is dressed up as an alert"
        });
    } else if (PICTOGRAPH.test(subject)) {
        signals.push({
            id: "subject_pictures",
            score: 5,
            reason: "The subject is decorated with pictures"
        });
    }

    const urgent = URGENCY.find((phrase) => lower.includes(phrase));
    if (urgent) {
        signals.push({
            id: "subject_urgency",
            score: 10,
            reason: `The subject pushes for a decision ("${urgent}")`
        });
    }

    // A bracketed shout - [24H ONLY], [URGENT]. Bracketed tags on their own are
    // ordinary: mailing lists, ticket systems and build servers all use them, so
    // only a bracket whose contents are shouting counts.
    const bracket = /\[([^\]]{2,20})\]/.exec(subject);
    const inside = bracket?.[1]?.trim() ?? "";
    if (inside && inside.replace(/[^a-zA-Z]/g, "").length >= 3 && inside === inside.toUpperCase()) {
        signals.push({
            id: "subject_bracket_shout",
            score: 6,
            reason: `The subject shouts from a bracket ("${inside}")`
        });
    }

    if (MONEY.test(subject)) {
        signals.push({
            id: "subject_money",
            score: 8,
            reason: "The subject promises an amount of money"
        });
    }

    return signals;
}
/** Attachment types that are executable on arrival, which no ordinary
 *  correspondence carries. */
const DANGEROUS_ATTACHMENTS: readonly string[] = [
    ".exe",
    ".scr",
    ".bat",
    ".cmd",
    ".com",
    ".pif",
    ".js",
    ".jar",
    ".vbs",
    ".vbe",
    ".wsf",
    ".hta",
    ".msi",
    ".lnk",
    ".iso",
    ".img"
];

/**
 * What the message is shaped like.
 *
 * Each of these is weak alone, which is the point: a shouting subject is a
 * shouting subject, and a shouting subject on a message that also failed DMARC
 * and links to a shortener is something else.
 */
export function structureSignals(message: JudgeableMessage): SpamSignal[] {
    const signals: SpamSignal[] = [];
    const subject = message.subject.trim();
    const letters = subject.replace(/[^a-zA-Z]/g, "");

    if (letters.length >= 8 && letters === letters.toUpperCase()) {
        signals.push({ id: "subject_shouting", score: 6, reason: "The subject is all capitals" });
    }
    if (/[!?]{3,}/.test(subject)) {
        signals.push({ id: "subject_punctuation", score: 5, reason: "The subject is shouting" });
    }
    if (message.bodyHtml && !message.bodyText.trim() && !message.snippet.trim()) {
        // A message with nothing readable in it is a picture with a link on it.
        signals.push({
            id: "image_only",
            score: 12,
            reason: "It has no text in it at all, only pictures"
        });
    }

    const fromDomain = baseDomain(domainOf(message.fromAddress));
    const replyDomain = baseDomain(domainOf(message.replyToAddress));
    if (replyDomain && fromDomain && replyDomain !== fromDomain) {
        signals.push({
            id: "reply_elsewhere",
            score: 12,
            reason: `Replies would go to ${replyDomain}, not to ${fromDomain}`
        });
    }

    // A display name that is itself an address, and a different one. The oldest
    // trick there is, and still the most effective on a phone, where the address
    // is not shown at all.
    const posing = /[\w.+-]+@[\w.-]+\.\w+/.exec(message.fromName);
    if (posing && domainOf(posing[0]).toLowerCase() !== domainOf(message.fromAddress)) {
        signals.push({
            id: "name_poses_as_address",
            // The heaviest thing the shape of a message can say on its own, and
            // still not enough to file one by itself. A display name that IS an
            // address, at a domain other than the one that sent it, is close to
            // never legitimate - and on a phone it is all anybody sees.
            score: 24,
            reason: `It shows itself as ${posing[0]} but was sent by ${message.fromAddress}`
        });
    }

    if (message.toAddresses.length === 0 && !message.listId) {
        signals.push({
            id: "undisclosed_recipients",
            score: 6,
            reason: "It is not addressed to anybody"
        });
    }

    const dangerous = message.attachmentNames.filter((name) =>
        DANGEROUS_ATTACHMENTS.includes((name.toLowerCase().match(/\.[a-z0-9]+$/) ?? [""])[0] ?? "")
    );
    if (dangerous.length > 0) {
        signals.push({
            id: "attachment_executable",
            score: 30,
            reason: `It carries a file that would run when opened (${dangerous[0]})`
        });
    }
    return signals;
}

/** What this mailbox already knows about the sender. */
export function relationshipSignals(known: SpamKnowledge): SpamSignal[] {
    if (known.writtenTo) {
        return [
            {
                id: "written_to",
                score: SPAM_WEIGHTS.relationships.writtenTo,
                reason: "You have written to this address before"
            }
        ];
    }
    if (known.knownContact) {
        return [
            {
                id: "known_contact",
                score: SPAM_WEIGHTS.relationships.knownContact,
                reason: "This sender is in your contacts"
            }
        ];
    }
    return [];
}

/**
 * What this mailbox has learned about the sender, its domain and this shape of
 * message - the strongest of the three and no more.
 *
 * Only one, because they are three views of the same thing: counting a bad
 * sender, their bad domain and their recognisable mailing separately would
 * treble one piece of evidence.
 */
export function reputationSignal(known: SpamKnowledge): SpamSignal | null {
    const what: Record<SpamReputation["kind"], string> = {
        sender: "This sender has",
        domain: "This domain has",
        fingerprint: "Messages like this one have"
    };
    let strongest: SpamSignal | null = null;
    for (const record of known.reputation) {
        const seen = record.junkCount + record.goodCount;
        if (seen < REPUTATION_FLOOR) continue;
        // Laplace-smoothed, so three out of three is confident and not certain.
        const ratio = (record.junkCount + 1) / (seen + 2);
        const signal =
            ratio >= 0.8
                ? {
                      id: `reputation_junk_${record.kind}`,
                      score: SPAM_WEIGHTS.reputation.establishedJunk,
                      reason: `${what[record.kind]} repeatedly been marked as junk`
                  }
                : ratio <= 0.2
                  ? {
                        id: `reputation_good_${record.kind}`,
                        score: SPAM_WEIGHTS.reputation.establishedGood,
                        reason: `${what[record.kind]} repeatedly been kept`
                    }
                  : null;
        if (signal && (!strongest || Math.abs(signal.score) > Math.abs(strongest.score))) {
            strongest = signal;
        }
    }
    return strongest;
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Add it all up.
 *
 * A blocked sender short-circuits everything: somebody said never again, and no
 * amount of DKIM makes that untrue.
 */
export function judgeSpam(message: JudgeableMessage, known: SpamKnowledge): SpamJudgement {
    const fingerprint = spamFingerprint(message);
    if (known.blocked) {
        const signal = { id: "blocked_sender", score: 100, reason: "You blocked this sender" };
        return {
            score: 100,
            verdict: "junk",
            signals: [signal],
            reason: signal.reason,
            fingerprint
        };
    }

    const signals: SpamSignal[] = [
        ...authenticationSignals(message.headers),
        ...urlSignals(message),
        ...subjectSignals(message),
        ...structureSignals(message),
        ...relationshipSignals(known),
        // Whatever a provider outside this mailbox said. Added as ordinary
        // signals so an outside opinion is weighed against the rest rather than
        // overriding it, and so it shows up in the reasons like anything else.
        ...(known.outside ?? [])
    ];
    const reputation = reputationSignal(known);
    if (reputation) signals.push(reputation);

    const learned = Math.max(-MAX_CONTENT_SCORE, Math.min(MAX_CONTENT_SCORE, known.contentScore));
    if (learned !== 0) {
        signals.push({
            id: learned > 0 ? "learned_junk" : "learned_good",
            score: learned,
            reason:
                learned > 0
                    ? "Its wording matches what you have marked as junk"
                    : "Its wording matches mail you have kept"
        });
    }

    const score = Math.max(
        0,
        Math.min(
            100,
            signals.reduce((total, signal) => total + signal.score, 0)
        )
    );
    const verdict: SpamVerdict =
        score >= SPAM_THRESHOLDS.junk
            ? "junk"
            : score >= SPAM_THRESHOLDS.suspicious
              ? "suspicious"
              : "clean";

    // The heaviest accusation, for the one line a message view has room for.
    // Never a reason the message is fine: nobody needs telling why their mail
    // arrived.
    const worst = [...signals].sort((left, right) => right.score - left.score)[0];
    return {
        score,
        verdict,
        signals,
        reason: verdict === "clean" || !worst || worst.score <= 0 ? "" : worst.reason,
        fingerprint
    };
}

/* -------------------------------------------------------------------------- */
/* Learning                                                                    */
/* -------------------------------------------------------------------------- */

/** How many distinct words are taken from one message. Bounded so a long
 *  message does not weigh more than a short one. */
export const MAX_TOKENS_PER_MESSAGE = 400;

/** How many of them are allowed to decide a verdict. The most opinionated few,
 *  which is what keeps one repeated word from dominating. */
export const MAX_DECIDING_TOKENS = 20;

/** Words too common to mean anything, in the languages this is likely to meet.
 *  Not an exhaustive stop list - the classifier handles common words correctly
 *  on its own - only the ones that would otherwise fill the deciding twenty. */
const NOISE = new Set([
    "the",
    "and",
    "for",
    "you",
    "your",
    "this",
    "that",
    "with",
    "from",
    "have",
    "are",
    "was",
    "our",
    "not",
    "但是",
    "que",
    "los",
    "las",
    "una",
    "por",
    "con",
    "del",
    "para",
    "como",
    "der",
    "die",
    "und",
    "les",
    "des",
    "est",
    "pour"
]);

/**
 * The words a message is learned by.
 *
 * The subject counts twice, because it is where the intent of a message
 * actually lives. Numbers are dropped: an invoice number is unique to one
 * message and teaches nothing, while filling the table with them is how a
 * learned filter turns into a store of everybody's order references.
 */
export function tokensOf(message: JudgeableMessage): string[] {
    const source = [
        message.subject,
        message.subject,
        message.bodyText || message.snippet,
        domainOf(message.fromAddress)
    ].join(" ");
    const seen = new Set<string>();
    for (const raw of source.toLowerCase().split(/[^\p{L}\p{N}$€£%.-]+/u)) {
        const word = raw.replace(/^[.-]+|[.-]+$/g, "");
        if (word.length < 3 || word.length > 24) continue;
        if (/^[\d.,-]+$/.test(word)) continue;
        if (NOISE.has(word)) continue;
        seen.add(word);
        if (seen.size >= MAX_TOKENS_PER_MESSAGE) break;
    }
    return [...seen];
}

/** One word, as the table holds it. */
export interface TokenCounts {
    readonly token: string;
    readonly junkCount: number;
    readonly goodCount: number;
}

/**
 * What the learned words are worth for one message, bounded.
 *
 * A plain naive-Bayes probability is the textbook answer and the wrong one here:
 * it is confidently wrong on the first hundred messages, which is exactly the
 * period when a new filter has to earn trust. So each word contributes a bounded
 * amount, only the most opinionated few are counted, and the whole thing is
 * capped - the words can push a message over the line, and can never carry it
 * there alone.
 */
export function contentScore(
    tokens: readonly string[],
    counts: ReadonlyMap<string, TokenCounts>,
    totals: { junkMessages: number; goodMessages: number }
): number {
    if (totals.junkMessages < 3 || totals.goodMessages < 3) return 0;
    const opinions: number[] = [];
    for (const token of tokens) {
        const held = counts.get(token);
        if (!held) continue;
        const seen = held.junkCount + held.goodCount;
        if (seen < 2) continue;
        // Each side as a rate rather than a count, so a mailbox with far more of
        // one than the other does not read every word as that one.
        const junkRate = held.junkCount / Math.max(1, totals.junkMessages);
        const goodRate = held.goodCount / Math.max(1, totals.goodMessages);
        if (junkRate + goodRate === 0) continue;
        // -1 (always in kept mail) to +1 (always in junk).
        opinions.push((junkRate - goodRate) / (junkRate + goodRate));
    }
    if (opinions.length === 0) return 0;
    const deciding = opinions
        .sort((left, right) => Math.abs(right) - Math.abs(left))
        .slice(0, MAX_DECIDING_TOKENS);
    const average = deciding.reduce((total, one) => total + one, 0) / deciding.length;
    // Confidence grows with how many opinionated words were found, so one word
    // out of four hundred cannot swing a message.
    const confidence = Math.min(1, deciding.length / MAX_DECIDING_TOKENS);
    return Math.round(average * confidence * MAX_CONTENT_SCORE);
}
