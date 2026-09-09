/**
 * Finding the way out of a mailing list.
 *
 * Two places to look, and they fail in opposite directions.
 *
 * **The headers.** `List-Unsubscribe` is what a legitimate bulk sender puts on
 * every message, and it is the one to trust: it is machine-readable, it was put
 * there deliberately, and `List-Unsubscribe-Post` turns it into something that
 * can be done without opening anything. Anybody sending enough mail for this to
 * matter sets it.
 *
 * **The body.** Everybody else. A small company's newsletter, a shop's receipts,
 * an old mailing tool - the link is in the footer and nowhere else.
 *
 * The body search is the interesting half, because the obvious way to do it does
 * not work. Matching the word "unsubscribe" against the link's own text fails on
 * most of the mail people actually get:
 *
 *     Si no quieres recibir correos informativos de EF, por favor haz clic aqui.
 *
 * The link says "haz clic aqui". The sentence around it is what says what the
 * link is for, and it says it in Spanish. So three things are read - the link's
 * text, its address, and the sentence it sits in - against words in the
 * languages people actually receive mail in, with the accents taken off so
 * `desuscribirse` and `desuscríbete` are the same word to look for.
 *
 * Deliberately generous about what counts. Offering a way out that turns out to
 * be a preferences page costs somebody one click; missing the only one in the
 * message costs them the newsletter for ever.
 */

/** What a message offers, and how. */
export interface UnsubscribeOffer {
    /** Where to go, or who to write to. */
    readonly url: string;
    /**
     * `one-click` - the sender accepts a POST and it can be done from here with
     *     nothing opened, which is what RFC 8058 exists for.
     * `link` - a page to open.
     * `mailto` - a message to send.
     */
    readonly kind: "one-click" | "link" | "mailto";
    /** Where it was found, because a header is a promise and a link in a footer
     *  is a guess. Worth saying on screen. */
    readonly source: "header" | "body";
}

/**
 * The way out named in the headers.
 *
 * `List-Unsubscribe` holds one or more addresses in angle brackets. An https one
 * is preferred over a mailto: it is a page somebody can read before committing,
 * and a mailto reveals the reader's address to a sender who may only have been
 * guessing it.
 */
export function unsubscribeFromHeaders(
    headers: Readonly<Record<string, string>> | null | undefined
): UnsubscribeOffer | null {
    const raw = headers?.["list-unsubscribe"] ?? "";
    if (!raw) return null;

    const found = [...raw.matchAll(/<([^>]+)>/g)].map((match) => (match[1] ?? "").trim());
    const candidates = found.length > 0 ? found : [raw.trim()];
    const link = candidates.find((one) => /^https?:\/\//i.test(one)) ?? "";
    const mailto = candidates.find((one) => /^mailto:/i.test(one)) ?? "";

    // One-click is only ever claimed for an https address: the RFC says the
    // client POSTs to it, and there is nothing to POST to a mailbox.
    const oneClick = /one-?click/i.test(headers?.["list-unsubscribe-post"] ?? "");
    if (link) return { url: link, kind: oneClick ? "one-click" : "link", source: "header" };
    if (mailto) return { url: mailto, kind: "mailto", source: "header" };
    return null;
}

/**
 * Words that mean "stop sending me this", in the languages mail actually arrives
 * in.
 *
 * Written without accents because that is how they are compared. Kept as
 * fragments rather than whole phrases so a sentence can be worded any way round
 * it - `no quieres recibir`, `si no deseas recibir mas`, `para dejar de
 * recibir` all contain one of these.
 */
const WORDS: readonly string[] = [
    // English
    "unsubscribe",
    "opt out",
    "opt-out",
    "optout",
    "stop receiving",
    "stop these emails",
    "remove me",
    "manage preferences",
    "email preferences",
    "notification settings",
    // Spanish
    "darse de baja",
    "dar de baja",
    "darte de baja",
    "date de baja",
    "cancelar la suscripcion",
    "cancelar suscripcion",
    "anular la suscripcion",
    "desuscribir",
    "desuscribete",
    "desuscripcion",
    "no quieres recibir",
    "no deseas recibir",
    "dejar de recibir",
    "no recibir mas",
    "preferencias de correo",
    "gestionar preferencias",
    // Catalan
    "donar-se de baixa",
    "cancellar la subscripcio",
    "cancel-lar la subscripcio",
    // Portuguese
    "cancelar a subscricao",
    "cancelar subscricao",
    "cancelar inscricao",
    "descadastrar",
    "nao quer receber",
    "deixar de receber",
    // French
    "se desabonner",
    "desabonnement",
    "desinscription",
    "me desinscrire",
    "ne plus recevoir",
    "gerer mes preferences",
    // German
    "abbestellen",
    "abmelden",
    "austragen",
    "keine e-mails mehr",
    "newsletter abbestellen",
    // Italian
    "annulla iscrizione",
    "annullare l iscrizione",
    "disiscriviti",
    "cancellati",
    "non vuoi piu ricevere",
    // Dutch
    "uitschrijven",
    "afmelden",
    "uitschrijf"
];

/** Address fragments that say what a link is for even when its text does not. */
const ADDRESS_WORDS: readonly string[] = [
    "unsubscribe",
    "unsub",
    "optout",
    "opt-out",
    "opt_out",
    "desuscribir",
    "baja",
    "darse-de-baja",
    "cancelar-suscripcion",
    "descadastr",
    "desabonn",
    "desinscri",
    "abmeld",
    "abbestell",
    "austragen",
    "disiscriv",
    "uitschrijv",
    "afmeld",
    "email-preferences",
    "manage-preferences",
    "list-manage",
    "preferences"
];

/**
 * The way out hidden in a message's own markup.
 *
 * `plain` is the text of the message where there is one, and it is not the same
 * question: a plain-text newsletter has the address on its own line under a
 * sentence, with no anchor to read.
 */
export function unsubscribeInBody(html: string, plain = ""): UnsubscribeOffer | null {
    const found = fromAnchors(html);
    if (found) return found;
    return fromPlainText(plain);
}

/** Everything a message offers, headers first. */
export function unsubscribeOffer(
    headers: Readonly<Record<string, string>> | null | undefined,
    html: string,
    plain = ""
): UnsubscribeOffer | null {
    return unsubscribeFromHeaders(headers) ?? unsubscribeInBody(html, plain);
}

/**
 * The body an RFC 8058 one-click unsubscribe POSTs, exactly.
 *
 * Sent as `application/x-www-form-urlencoded`, and it is the whole body: the RFC
 * says a sender must accept any well-formed POST to that address, and anything
 * else here would be a field somebody's parser has to ignore.
 */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/** What a `mailto:` way out asks for. */
export interface UnsubscribeMail {
    readonly address: string;
    readonly subject: string;
    readonly body: string;
}

/**
 * The message a `mailto:` unsubscribe wants sent.
 *
 * Nearly all of them name the subject in the address - `?subject=unsubscribe
 * list-42` - and it is not decoration: it is how the receiving robot knows which
 * list and which subscriber, so a message sent without it is a message that does
 * nothing. Where the sender named none, "unsubscribe" is what these robots read,
 * and the same word goes in the body for the ones that read that instead.
 *
 * Parsed by hand rather than with `URL`, which does not break a mailto into its
 * address and its query - to it the whole thing is one opaque path. The query is
 * parsed by hand too, and `URLSearchParams` is deliberately not used for it: it
 * reads a `+` as a space, which is right for a form submission and wrong here.
 * RFC 6068 says a mailto's fields are percent-encoded and nothing else, so
 * `?subject=unsubscribe+list-42` names the subject `unsubscribe+list-42`. Losing
 * that plus mangles the one string the robot at the other end matches on, and
 * the message that gets sent does nothing while Polaris reports it as sent.
 */
export function unsubscribeMailto(url: string): UnsubscribeMail | null {
    const bare = url.trim();
    if (!/^mailto:/i.test(bare)) return null;

    const rest = bare.slice("mailto:".length);
    const split = rest.indexOf("?");
    // More than one address is legal and means "any of these will do".
    const address = decodeField((split === -1 ? rest : rest.slice(0, split)).split(",")[0] ?? "");
    if (!address.includes("@")) return null;

    const fields = mailtoFields(split === -1 ? "" : rest.slice(split + 1));
    return {
        address: address.toLowerCase(),
        subject: fields.subject || "unsubscribe",
        body: fields.body || "unsubscribe"
    };
}

/** The `name=value` pairs after the `?`, each decoded exactly once. */
function mailtoFields(query: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const pair of query.split("&")) {
        if (!pair) continue;
        const at = pair.indexOf("=");
        const name = decodeField(at === -1 ? pair : pair.slice(0, at)).toLowerCase();
        if (name && !(name in fields)) fields[name] = decodeField(at === -1 ? "" : pair.slice(at + 1));
    }
    return fields;
}

/**
 * Percent-decoding that survives a malformed escape, which a mailto written by
 * hand routinely carries.
 *
 * Done a run of escapes at a time rather than over the whole string, because a
 * sale newsletter puts a bare `%` in its subject - `?subject=100%%20off` - and
 * `decodeURIComponent` refuses the entire value over it. One bad escape must
 * cost that escape and nothing else, or the subject the robot matches on comes
 * back with every other escape still in it.
 *
 * A run rather than a single `%XX` because anything outside ASCII is several of
 * them in a row and they only mean a character together.
 */
function decodeField(value: string): string {
    return value.trim().replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
        try {
            return decodeURIComponent(run);
        } catch {
            return run;
        }
    });
}

/** Accents off, one space between words, lower case - the form everything here
 *  is compared in, so one entry covers every way a word gets typed. */
function flatten(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function saysUnsubscribe(value: string): boolean {
    const flat = flatten(value);
    return WORDS.some((word) => flat.includes(word));
}

function addressSaysUnsubscribe(url: string): boolean {
    const flat = flatten(url);
    return ADDRESS_WORDS.some((word) => flat.includes(word));
}

/** Anchors, with the sentence each one sits in. */
function fromAnchors(html: string): UnsubscribeOffer | null {
    if (!html) return null;
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
    let fallback: UnsubscribeOffer | null = null;

    for (const anchor of anchors) {
        const attributes = anchor[1] ?? "";
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
        const url = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
        if (!url || url.startsWith("#") || /^javascript:/i.test(url)) continue;

        const text = decodeEntities(stripTags(anchor[2] ?? ""));
        const kind: UnsubscribeOffer["kind"] = /^mailto:/i.test(url) ? "mailto" : "link";
        if (!/^https?:\/\//i.test(url) && kind !== "mailto") continue;

        // What the link says, and what its address says. Either is enough.
        if (saysUnsubscribe(text) || addressSaysUnsubscribe(url)) {
            return { url, kind, source: "body" };
        }

        // What the sentence around it says. This is the case the obvious
        // implementation misses: the link reads "haz clic aqui" and the sentence
        // it sits in is the only thing that says what it does.
        const around = stripTags(html.slice(Math.max(0, anchor.index - 300), anchor.index + anchor[0].length + 120));
        if (saysUnsubscribe(decodeEntities(around))) {
            // Held rather than returned, because an anchor that says so itself
            // is a better answer than one whose neighbourhood does.
            fallback ??= { url, kind, source: "body" };
        }
    }
    return fallback;
}

/** A plain-text message, where the address sits under the sentence rather than
 *  inside it. */
function fromPlainText(plain: string): UnsubscribeOffer | null {
    if (!plain) return null;
    const lines = plain.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
        if (!saysUnsubscribe(line)) continue;
        // The address on this line, or on one of the next two - which is where a
        // mailing tool puts it when the sentence would otherwise wrap.
        const nearby = lines.slice(index, index + 3).join(" ");
        const url = /https?:\/\/[^\s<>"'\]]+/i.exec(nearby)?.[0] ?? "";
        if (url) return { url, kind: "link", source: "body" };
        const mail = /mailto:[^\s<>"'\]]+/i.exec(nearby)?.[0] ?? "";
        if (mail) return { url: mail, kind: "mailto", source: "body" };
    }
    return null;
}

function stripTags(value: string): string {
    return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Enough entity handling for the words this reads. A footer written by a
 *  mailing tool is full of `&nbsp;` and `&#39;`. */
function decodeEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, " ")
        // An accented letter written as a named entity is the base letter as far
        // as this is concerned: everything here is compared with the accents
        // taken off anyway. Two lines instead of a table of two hundred.
        .replace(/&([a-z])(?:acute|grave|circ|uml|tilde|ring|slash);/gi, "$1")
        .replace(/&([a-z])cedil;/gi, "$1")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&#(\d+);/g, (_match, digits: string) => codePoint(Number.parseInt(digits, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePoint(Number.parseInt(hex, 16)));
}

function codePoint(value: number): string {
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
    try {
        return String.fromCodePoint(value);
    } catch {
        return "";
    }
}
