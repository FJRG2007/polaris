/**
 * Why a request was blocked, in the words the visitor is given.
 *
 * Every block has a cause the operator can read in the log, but only some of them are
 * the visitor's business. The line drawn here is the one Cloudflare draws on its own
 * error pages (1005 ASN, 1006 banned address, 1015 rate limited, against a bare
 * "Access denied" for 1020 firewall rules): a property of the CONNECTION is stated,
 * because the visitor can change it or wait it out and nobody learns anything about
 * the ruleset from being told; what the request CARRIED, or which custom rule matched,
 * is not, because a scanner that is told which signature caught it is told what to
 * change. The owner can still put words on a rule of their own - `message` - and
 * those are shown as written.
 *
 * Geography and network ownership are not here: the edge has no geolocation or ASN
 * data at all (see `waf-rules.ts`), so no block can be about a country or an ASN.
 *
 * Pure and dependency-free so the guard, which is deliberately tiny, can render the
 * same sentence Polaris does.
 */

import { negotiateLocale, parseAcceptLanguage } from "./i18n/detect.js";
import { localeDirection, type Locale, type TextDirection } from "./i18n/locales.js";

/** The stable codes a block answers with. A JSON client switches on these. */
export const WAF_BLOCK_CAUSES = [
    /** Anything not safe to describe: a custom or managed rule, a signature, an
     *  integrity check, a denied range, a permanent automatic ban. */
    "firewall",
    /** A Tor exit node. */
    "tor",
    /** A VPN, a proxy or another anonymizing service, as a reputation provider says. */
    "anonymizer",
    /** A hosting or datacenter network, as a reputation provider says. */
    "hosting",
    /** Banned for carrying on after being rate limited; lifts at a known time. */
    "rate_limited",
    /** Any other automatic ban that lifts at a known time. */
    "temporary_ban",
    /** The operator blocked the address by hand. */
    "ip_banned",
    /** A custom rule the operator gave a message to visitors. */
    "custom",
    /** A signed-in account the service refuses by name. */
    "account_refused",
    /** A signed-in account the service does not admit. */
    "account_not_admitted"
] as const;
export type WafBlockCause = (typeof WAF_BLOCK_CAUSES)[number];

/** The causes the address intelligence snapshot can carry for an entry. */
export const WAF_INTEL_CAUSES = ["tor", "anonymizer", "hosting", "rate_limited"] as const;
export type WafIntelCause = (typeof WAF_INTEL_CAUSES)[number];

/** Whether a value is a cause code this build knows. */
export function isWafBlockCause(value: unknown): value is WafBlockCause {
    return typeof value === "string" && (WAF_BLOCK_CAUSES as readonly string[]).includes(value);
}

/** The longest message an operator can put on a rule. It travels in the header that
 *  carries the rules on every request, so it is kept short. */
export const WAF_RULE_MESSAGE_MAX = 200;

/**
 * What an address-intelligence entry is about, from what Polaris knows when it writes
 * the snapshot: why the address is listed, which jail or provider listed it, and the
 * provider's own word for it. Only connection properties are named; everything else
 * returns null and is described generically.
 *
 * A reputation note is the provider's label - "VPN", "Proxy", "Hosting or datacenter"
 * from one, `VPN`, `PROXY`, `TOR_NETWORK` from another - so the match is on those
 * words, and a label nobody mapped stays generic rather than guessed at.
 */
export function wafIntelCause(entry: {
    readonly reason: string;
    readonly source?: string | null;
    readonly note?: string | null;
}): WafIntelCause | null {
    if (entry.reason === "tor") return "tor";
    if (entry.reason === "ban") return entry.source === "rate-limited" ? "rate_limited" : null;
    if (entry.reason !== "reputation") return null;
    const note = (entry.note ?? "").toLowerCase();
    if (/(^|[^a-z])tor([^a-z]|$)|tor_network/.test(note)) return "tor";
    if (/(^|[^a-z])(vpn|proxy|anonymi[sz]er)([^a-z]|$)/.test(note)) return "anonymizer";
    if (/hosting|datacenter|data center|data_center/.test(note)) return "hosting";
    return null;
}

/** The words of one block page, in one language. `{host}` and `{at}` are filled in. */
interface BlockCopy {
    readonly title: string;
    readonly heading: string;
    /** "You are unable to access {host}." */
    readonly lead: string;
    readonly thisSite: string;
    readonly why: string;
    readonly whatToDo: string;
    readonly reference: string;
    readonly yourIp: string;
    readonly protectedBy: string;
    readonly signIn: string;
    readonly tryAgain: string;
    /** The plain-text answer's first line. */
    readonly blocked: string;
    readonly unavailable: string;
    readonly causes: Readonly<Record<WafBlockCause, string>>;
    /** What to do, for a cause the visitor cannot change. */
    readonly contactOwner: string;
    /** What to do, for a connection property: change it, or ask. */
    readonly mistake: string;
    /** "It is unblocked by itself at {at}." */
    readonly liftsAt: string;
    readonly tryAt: string;
    readonly signInLifts: string;
    readonly otherwise: string;
}

const EN: BlockCopy = {
    title: "Blocked",
    heading: "Sorry, you have been blocked",
    lead: "You are unable to access {host}.",
    thisSite: "this site",
    why: "Why have I been blocked?",
    whatToDo: "What can I do about it?",
    reference: "Reference ID",
    yourIp: "Your IP",
    protectedBy: "Protected by Polaris",
    signIn: "Sign in",
    tryAgain: "Try again",
    blocked: "Blocked by the firewall.",
    unavailable: "unavailable",
    causes: {
        firewall:
            "This site runs a firewall. Something about this request matched a rule that blocks it, either where it came from or what it carried.",
        tor: "Access through Tor is blocked on this site for security. Open it from a regular browser and connection.",
        anonymizer:
            "Access through a VPN, proxy or anonymizing service is blocked on this site for security. Turn it off and open the site from your regular connection.",
        hosting:
            "Access from hosting and datacenter networks is blocked on this site. Open it from a home, mobile or office connection.",
        rate_limited: "Too many requests came from your address in a short time, so it is blocked for a while.",
        temporary_ban: "This address was blocked automatically for what was sent from it.",
        ip_banned: "The owner of this site has blocked your IP address.",
        custom: "This site runs a firewall, and one of its rules blocks this request.",
        account_refused: "Your account has been blocked from this service.",
        account_not_admitted: "Your account does not have access to this service."
    },
    contactOwner:
        "If the site is yours, review its firewall rules. Otherwise contact the site owner and quote the reference below.",
    mistake: "If you think this is a mistake, contact the site owner and quote the reference below.",
    liftsAt: "It is unblocked by itself at {at}.",
    tryAt: "Try again after {at}.",
    signInLifts: "If you have an account here, sign in and it is unblocked now.",
    otherwise: "Otherwise contact the site owner and quote the reference below."
};

const ES: BlockCopy = {
    title: "Bloqueado",
    heading: "Lo sentimos, se te ha bloqueado",
    lead: "No puedes acceder a {host}.",
    thisSite: "este sitio",
    why: "¿Por qué se me ha bloqueado?",
    whatToDo: "¿Qué puedo hacer?",
    reference: "ID de referencia",
    yourIp: "Tu IP",
    protectedBy: "Protegido por Polaris",
    signIn: "Entrar",
    tryAgain: "Reintentar",
    blocked: "Bloqueado por el cortafuegos.",
    unavailable: "no disponible",
    causes: {
        firewall:
            "Este sitio usa un cortafuegos. Algo de esta petición coincidió con una regla que la bloquea, por su origen o por su contenido.",
        tor: "El acceso a través de Tor está bloqueado en este sitio por seguridad. Ábrelo desde un navegador y una conexión normales.",
        anonymizer:
            "El acceso mediante VPN, proxy u otro servicio de anonimato está bloqueado en este sitio por seguridad. Desactívalo y abre el sitio desde tu conexión habitual.",
        hosting:
            "El acceso desde redes de hosting y centros de datos está bloqueado en este sitio. Ábrelo desde una conexión de casa, móvil o de oficina.",
        rate_limited: "Llegaron demasiadas peticiones desde tu dirección en poco tiempo, así que está bloqueada un rato.",
        temporary_ban: "Esta dirección se bloqueó automáticamente por lo que se envió desde ella.",
        ip_banned: "El propietario de este sitio ha bloqueado tu dirección IP.",
        custom: "Este sitio usa un cortafuegos y una de sus reglas bloquea esta petición.",
        account_refused: "Tu cuenta tiene bloqueado el acceso a este servicio.",
        account_not_admitted: "Tu cuenta no tiene acceso a este servicio."
    },
    contactOwner:
        "Si el sitio es tuyo, revisa sus reglas de cortafuegos. Si no, contacta con su propietario e indica la referencia de abajo.",
    mistake: "Si crees que es un error, contacta con el propietario del sitio e indica la referencia de abajo.",
    liftsAt: "Se desbloquea solo el {at}.",
    tryAt: "Vuelve a intentarlo después del {at}.",
    signInLifts: "Si tienes una cuenta aquí, entra y se desbloquea ahora.",
    otherwise: "Si no, contacta con el propietario del sitio e indica la referencia de abajo."
};

/** Every language the block page speaks. A locale missing here reads English. */
const COPY: Readonly<Partial<Record<Locale, BlockCopy>>> = { "en-US": EN, "es-ES": ES };

/** The block page's language and direction for an Accept-Language header. */
export function wafBlockLocale(acceptLanguage: string | null | undefined): {
    readonly locale: Locale;
    readonly dir: TextDirection;
} {
    const locale = negotiateLocale(parseAcceptLanguage(acceptLanguage).map((range) => range.tag));
    const chosen: Locale = locale && COPY[locale] ? locale : "en-US";
    return { locale: chosen, dir: localeDirection(chosen) };
}

/** The words for a locale, English where it has none. */
export function wafBlockCopy(locale: Locale | undefined): BlockCopy {
    return (locale && COPY[locale]) || EN;
}

/** Fill `{name}` placeholders. Values are inserted as given - escape before. */
export function fillBlockCopy(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** What a block says about itself, decided once and rendered as a page or as data. */
export interface WafBlockStatement {
    readonly cause: WafBlockCause;
    /** The operator's own words, for `custom`. Raw - escaped where it is rendered. */
    readonly message?: string;
    /** When a timed block lifts, epoch ms. Stated for the causes that are timed. */
    readonly until?: number | null;
}

/** Whether a cause is a property of the connection the visitor can change. */
export function wafBlockChangeable(cause: WafBlockCause): boolean {
    return cause === "tor" || cause === "anonymizer" || cause === "hosting";
}

/** Whether the time a block lifts is worth telling: only for a timed ban. A
 *  reputation verdict also has an expiry, but it is when Polaris asks again, not
 *  when the visitor is let back in. */
export function wafBlockStatesUntil(cause: WafBlockCause): boolean {
    return cause === "rate_limited" || cause === "temporary_ban";
}

/** The "why" sentence for a statement, in plain text. */
export function wafBlockSentence(statement: WafBlockStatement, locale?: Locale): string {
    const copy = wafBlockCopy(locale);
    if (statement.cause === "custom") {
        const message = (statement.message ?? "").trim().slice(0, WAF_RULE_MESSAGE_MAX);
        return message || copy.causes.custom;
    }
    return copy.causes[statement.cause];
}

/** The "what can I do" sentence's first part, without the time or the sign-in. */
export function wafBlockAdvice(cause: WafBlockCause, locale?: Locale): string {
    const copy = wafBlockCopy(locale);
    // A signed-in account already knows who it is, and cannot review the rules.
    if (wafBlockChangeable(cause) || cause === "account_refused" || cause === "account_not_admitted")
        return copy.mistake;
    return copy.contactOwner;
}

/** The body of a block answered to a client that asked for JSON. */
export interface WafBlockJson {
    readonly error: "blocked";
    readonly reason: WafBlockCause;
    readonly message: string;
    readonly reference: string;
    readonly ip: string | null;
    /** ISO time a timed block lifts, when it is one. */
    readonly retryAfter?: string;
}

/** The JSON answer for a block: the stable code, the sentence, and the reference. */
export function wafBlockJson(
    statement: WafBlockStatement,
    facts: { readonly reference: string; readonly ip?: string | null; readonly locale?: Locale }
): WafBlockJson {
    const until = statement.until;
    return {
        error: "blocked",
        reason: statement.cause,
        message: wafBlockSentence(statement, facts.locale),
        reference: facts.reference,
        ip: facts.ip ?? null,
        ...(wafBlockStatesUntil(statement.cause) && typeof until === "number" && Number.isFinite(until)
            ? { retryAfter: new Date(until).toISOString() }
            : {})
    };
}
