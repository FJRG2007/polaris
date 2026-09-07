/**
 * What kind of thing a message is.
 *
 * The tabs above a mail list are worth having for one reason: almost nothing in
 * a modern inbox is a person writing to you, and the handful of messages that
 * are get buried under the ones that are not. Sorting them is not filing - the
 * message stays exactly where it is, in the same folder, with the same flags -
 * it is only a way of looking at the same inbox.
 *
 * Five kinds, and the fifth is the one no other client has:
 *
 * - **security** is a code, a link, or a notice about signing in. It is the most
 *   time-sensitive mail anybody gets and the least worth keeping: the code in it
 *   stops working in ten minutes and the message sits in the mailbox for years,
 *   which is why this is the only category Polaris offers to clear up on its
 *   own.
 * - **social** is somebody's account on a service telling them about people.
 * - **promotions** is somebody selling something.
 * - **updates** is a receipt, an order, a statement, a delivery - transactional
 *   mail nobody replies to but everybody needs to find later.
 * - **primary** is what is left, which is what somebody actually wants to read.
 *
 * Multi-language throughout and compared with the accents taken off, because
 * "código de verificación" and "codigo de verificacion" are the same message and
 * a mailbox does not get to be sorted only when it is in English.
 *
 * Deliberately conservative in one direction: anything this is not sure about
 * lands in `primary`. A promotion that shows up in the main list is a minor
 * annoyance; a colleague's message hidden behind a tab nobody opens is the
 * feature doing harm.
 */

export const MAIL_CATEGORIES = ["primary", "social", "promotions", "updates", "security"] as const;

export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export const MAIL_CATEGORY_LABELS: Readonly<Record<MailCategory, string>> = {
    primary: "Primary",
    social: "Social",
    promotions: "Promotions",
    updates: "Updates",
    security: "Codes and sign-ins"
};

export const MAIL_CATEGORY_NOTES: Readonly<Record<MailCategory, string>> = {
    primary: "People writing to you, and anything Polaris could not place.",
    social: "What the services you use say about other people.",
    promotions: "Offers, newsletters, and anything else selling something.",
    updates: "Receipts, orders, deliveries and statements.",
    security: "Verification codes, sign-in links and password notices. They stop working long before they stop taking up room."
};

/** What the categoriser reads. Everything is already on the row: no message body
 *  is fetched to decide this. */
export interface CategorisableMessage {
    readonly subject: string;
    readonly snippet: string;
    readonly fromAddress: string;
    readonly fromName: string;
    readonly headers: Readonly<Record<string, string>> | null;
}

/** Services whose mail is about other people. Matched on the domain and on any
 *  parent of it, so `mail.notifications.facebook.com` is Facebook. */
const SOCIAL_DOMAINS: readonly string[] = [
    "facebook.com",
    "facebookmail.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "linkedin.com",
    "tiktok.com",
    "snapchat.com",
    "pinterest.com",
    "reddit.com",
    "redditmail.com",
    "discord.com",
    "discordapp.com",
    "slack.com",
    "whatsapp.com",
    "telegram.org",
    "youtube.com",
    "twitch.tv",
    "mastodon.social",
    "bsky.app",
    "meetup.com",
    "strava.com",
    "goodreads.com"
];

/**
 * Words that mean "here is a code, or a link, and it expires".
 *
 * Held apart from the rest because this is the category with a consequence: a
 * message put here can be cleared up automatically if its owner asks for that,
 * so a false positive costs somebody a real message. Every phrase here is one
 * that only ever appears in this kind of mail.
 */
const SECURITY_WORDS: readonly string[] = [
    // English
    "verification code",
    "verify your email",
    "verify your account",
    "confirm your email",
    "confirmation code",
    "security code",
    "one-time",
    "one time code",
    "single-use code",
    "access code",
    "login code",
    "sign-in code",
    "sign in code",
    "two-factor",
    "two factor",
    "2fa code",
    "authentication code",
    "magic link",
    "sign in to",
    "new sign-in",
    "new device",
    "reset your password",
    "password reset",
    "change your password",
    "password was changed",
    "your otp",
    "otp code",
    // Spanish
    "codigo de verificacion",
    "codigo de confirmacion",
    "codigo de seguridad",
    "codigo de acceso",
    "codigo de un solo uso",
    "verifica tu correo",
    "verifica tu cuenta",
    "confirma tu correo",
    "confirma tu cuenta",
    "verificacion en dos pasos",
    "doble factor",
    "enlace magico",
    "inicio de sesion",
    "inicia sesion",
    "nuevo inicio de sesion",
    "restablecer tu contrasena",
    "restablecer contrasena",
    "cambiar tu contrasena",
    "tu contrasena ha sido",
    "nueva contrasena",
    // Portuguese
    "codigo de verificacao",
    "codigo de seguranca",
    "redefinir sua senha",
    "alterar sua senha",
    // French
    "code de verification",
    "code de securite",
    "code a usage unique",
    "reinitialiser votre mot de passe",
    "nouvelle connexion",
    // German
    "bestatigungscode",
    "sicherheitscode",
    "einmalcode",
    "passwort zurucksetzen",
    "neue anmeldung",
    // Italian
    "codice di verifica",
    "codice di sicurezza",
    "reimposta la password"
];

/** Words that mean somebody is selling something. */
const PROMOTION_WORDS: readonly string[] = [
    "sale",
    "% off",
    "discount",
    "offer",
    "deal",
    "coupon",
    "voucher",
    "free trial",
    "black friday",
    "cyber monday",
    "newsletter",
    "subscribe",
    "webinar",
    "last chance",
    "limited time",
    "descuento",
    "oferta",
    "ofertas",
    "rebajas",
    "promocion",
    "cupon",
    "gratis",
    "ahorra",
    "ultimas plazas",
    "boletin",
    "novedades",
    "desconto",
    "promocao",
    "soldes",
    "reduction",
    "angebot",
    "rabatt",
    "sconto",
    "offerta"
];

/** Words that mean a transaction happened. */
const UPDATE_WORDS: readonly string[] = [
    "receipt",
    "invoice",
    "your order",
    "order confirmation",
    "order #",
    "shipped",
    "out for delivery",
    "delivered",
    "tracking",
    "payment",
    "statement",
    "subscription renew",
    "your booking",
    "itinerary",
    "ticket",
    "refund",
    "factura",
    "recibo",
    "tu pedido",
    "pedido",
    "enviado",
    "en reparto",
    "entregado",
    "seguimiento",
    "pago",
    "cuota",
    "reembolso",
    "tu reserva",
    "en aduanas",
    "encomenda",
    "pagamento",
    "commande",
    "livraison",
    "bestellung",
    "lieferung",
    "rechnung",
    "ordine",
    "spedizione",
    "fattura"
];

/**
 * Which tab a message belongs under.
 *
 * The order of the questions is the whole of the logic. Security first, because
 * a code from a shop is still a code and burying it under Promotions is what
 * makes somebody go looking for their mail in another client. Social next,
 * because those senders are unambiguous. Then the two that both look like bulk
 * mail, told apart by what they say. Everything else is somebody writing.
 */
export function categoriseMail(message: CategorisableMessage): MailCategory {
    const subject = flatten(message.subject);
    const words = `${subject} ${flatten(message.snippet)}`;
    const domain = domainOf(message.fromAddress);
    const headers = message.headers ?? {};

    // A code in the subject with a word beside it. The subject is where these
    // always are, because the whole point is to be readable without opening it.
    if (SECURITY_WORDS.some((word) => subject.includes(word))) return "security";
    if (bareCode(message.subject) && SECURITY_WORDS.some((word) => words.includes(word))) return "security";

    if (SOCIAL_DOMAINS.some((one) => domain === one || domain.endsWith(`.${one}`))) return "social";

    // Bulk mail: the sender said so, one way or another. What KIND of bulk mail
    // is then decided by what it says, and a message that says nothing either
    // way is an update rather than a promotion - a receipt misfiled under
    // Promotions is worse than an offer misfiled under Updates.
    const bulk =
        Boolean(headers["list-unsubscribe"]) ||
        Boolean(headers["list-id"]) ||
        /bulk|list|auto/i.test(headers["precedence"] ?? "") ||
        Boolean(headers["x-campaign-id"]) ||
        Boolean(headers["x-mailer-campaign"]);

    const promotional = PROMOTION_WORDS.some((word) => words.includes(word));
    const transactional = UPDATE_WORDS.some((word) => words.includes(word));

    if (transactional && !promotional) return "updates";
    if (bulk && promotional) return "promotions";
    if (bulk) return "updates";
    if (transactional) return "updates";

    // Not bulk, nothing recognised - somebody wrote this.
    return "primary";
}

/** Whether a subject carries a code somebody is meant to type. Four to eight
 *  digits or an upper-case run, standing on its own rather than inside a word -
 *  an order number in a sentence is not one of these. */
function bareCode(subject: string): boolean {
    return /(?:^|[\s:>-])(?:\d{4,8}|[A-Z0-9]{6,8})(?:$|[\s.,)<-])/.test(subject);
}

/** The domain an address is at, lower case and with no trailing dot. */
function domainOf(address: string): string {
    const at = address.lastIndexOf("@");
    if (at < 0) return "";
    return address
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\.$/, "");
}

/** Accents off, one space between words, lower case - so one entry in a list
 *  covers every way a phrase gets typed. */
function flatten(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}
