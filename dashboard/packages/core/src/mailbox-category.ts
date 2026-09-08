/**
 * What kind of thing a message is.
 *
 * The tabs above a mail list are worth having for one reason: almost nothing in
 * a modern inbox is a person writing to you, and the handful of messages that
 * are get buried under the ones that are not. Sorting them is not filing - the
 * message stays exactly where it is, in the same folder, with the same flags -
 * it is only a way of looking at the same inbox.
 *
 * Six kinds, and two of them are ones no other client has:
 *
 * - **security** is a code, a link, or a notice about signing in. It is the most
 *   time-sensitive mail anybody gets and the least worth keeping: the code in it
 *   stops working in ten minutes and the message sits in the mailbox for years,
 *   which is why this is the only category Polaris offers to clear up on its
 *   own.
 * - **social** is somebody's account on a service telling them about people.
 * - **promotions** is somebody selling something.
 * - **billing** is money about to move: a subscription renewing, a card being
 *   charged, an invoice falling due, a trial ending. It is separated from the
 *   rest of the transactional pile because it is the only mail that is worth
 *   reading BEFORE it happens - a receipt tells you what you spent, and one of
 *   these tells you what you are about to spend, which is the one somebody would
 *   have wanted to see.
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

/**
 * Which set of rules decided a message's category.
 *
 * Stored beside the answer, and the reason is the whole difference between a
 * categoriser that improves and one that only improves for mail that has not
 * arrived yet. A category is decided once, as a message lands, and written to
 * the row - so every rule added afterwards was invisible on every message
 * already in the mailbox, for ever. A Stripe notice that a trial was ending sat
 * under the wrong tab because it was filed before "trial ends" was a phrase
 * Polaris knew, and nothing was ever going to look at it again.
 *
 * **Bump this in the same change that changes a rule.** A row behind the current
 * number is re-decided by the pass in `mailbox/categories`, in batches, with
 * nothing fetched and nobody asked to resync. Leaving it alone is what makes a
 * new rule apply to tomorrow's mail and no further.
 */
export const MAIL_CATEGORY_VERSION = 2;

export const MAIL_CATEGORIES = ["primary", "social", "promotions", "billing", "updates", "security"] as const;

export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export const MAIL_CATEGORY_LABELS: Readonly<Record<MailCategory, string>> = {
    primary: "Primary",
    social: "Social",
    promotions: "Promotions",
    billing: "Subscriptions and bills",
    updates: "Updates",
    security: "Security"
};

export const MAIL_CATEGORY_NOTES: Readonly<Record<MailCategory, string>> = {
    primary: "People writing to you, and anything Polaris could not place.",
    social: "What the services you use say about other people.",
    promotions: "Offers, newsletters, and anything else selling something.",
    billing: "Renewals, charges and invoices - what is about to be taken, while there is still time to do something about it.",
    updates: "Receipts, orders, deliveries and statements.",
    security: "Codes, sign-in links, password notices - and anything else about the safety of an account you have. The codes stop working long before they stop taking up room; the alerts are the ones worth reading first."
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

/**
 * Words that mean something about the safety of an account, rather than a code
 * to type into one.
 *
 * Held apart from the codes above on purpose. A verification code stops working
 * in ten minutes and can be swept up automatically; "secrets detected in your
 * repository" is the opposite kind of message - it does not expire, it is the
 * most important mail somebody gets that week, and nothing may ever clear it up
 * on its own. Both belong under Security, because both are about an account
 * being safe; only one of them is disposable.
 *
 * That difference is what `MAIL_SECURITY_DISPOSABLE` answers, and it is why the
 * sweep reads that rather than the category.
 */
const SECURITY_ALERT_WORDS: readonly string[] = [
    // English
    "secret detected",
    "secrets detected",
    "secret scanning",
    "exposed secret",
    "leaked credential",
    "security alert",
    "security advisory",
    "security warning",
    "suspicious activity",
    "unusual activity",
    "unauthorized access",
    "unauthorised access",
    "data breach",
    "vulnerability",
    "vulnerable dependency",
    "action needed",
    "action required",
    "compromised",
    "two-factor",
    "two factor",
    "2fa",
    "recovery code",
    "account locked",
    "account suspended",
    // The same three things said as sentences, which is how they are actually
    // written: "Your account has been locked" is the common form and "account
    // locked" is the rare one.
    "has been locked",
    "has been suspended",
    "has been disabled",
    "was locked",
    "password expired",
    // Something about an account CHANGED, which is the most common security mail
    // there is and the one nobody thinks to look for: it arrives worded as news
    // rather than as a warning, so none of the words above appear in it. "Your
    // password has been updated" is the whole message, and if it was not you who
    // updated it, it is the most urgent mail of the year.
    //
    // Every ordering, because senders write them all: a subject is "Password
    // Changed", "Your password was updated" or "We have changed your password"
    // depending on the house style, and matching one of the three is matching
    // none of the mail from the other two.
    "password changed",
    "password updated",
    "password has been",
    "password was changed",
    "password was updated",
    "changed your password",
    "updated your password",
    "email address changed",
    "email address was changed",
    "phone number changed",
    "recovery email",
    "recovery phone",
    "backup codes",
    "passkey added",
    "new passkey",
    "signed in from",
    "new sign-in",
    "new sign in",
    "new login",
    // Spanish
    "alerta de seguridad",
    "actividad sospechosa",
    "acceso no autorizado",
    "brecha de seguridad",
    "vulnerabilidad",
    "accion necesaria",
    "accion requerida",
    "cuenta bloqueada",
    "cuenta suspendida",
    "doble factor",
    "verificacion en dos pasos",
    "contrasena actualizada",
    "contrasena cambiada",
    "contrasena modificada",
    "tu contrasena ha sido",
    "cambio de contrasena",
    "hemos cambiado tu contrasena",
    "correo de recuperacion",
    "nuevo inicio de sesion",
    // Portuguese
    "alerta de seguranca",
    "atividade suspeita",
    "acesso nao autorizado",
    "senha alterada",
    "senha atualizada",
    "sua senha foi",
    // French
    "alerte de securite",
    "activite suspecte",
    "acces non autorise",
    "mot de passe modifie",
    "mot de passe a ete",
    "mot de passe mis a jour",
    // German
    "sicherheitswarnung",
    "sicherheitshinweis",
    "verdachtige aktivitat",
    "unbefugter zugriff",
    "passwort geandert",
    "passwort wurde",
    // Italian
    "avviso di sicurezza",
    "attivita sospetta",
    "password modificata",
    "password aggiornata",
    "la tua password e stata"
];

/**
 * Whether a message in Security is one that stops mattering.
 *
 * A code or a sign-in link is worthless within the hour and is what the
 * clear-up offers to sweep. An alert about an account is the opposite: it does
 * not expire, and deleting one automatically would be deleting the most
 * important mail somebody got that week.
 *
 * So the sweep asks this rather than asking the category, and the two kinds
 * share a tab without sharing a fate.
 */
export function isDisposableSecurityMail(message: CategorisableMessage): boolean {
    const subject = flatten(message.subject);
    const words = `${subject} ${flatten(message.snippet)}`;
    if (SECURITY_ALERT_WORDS.some((word) => words.includes(word))) return false;
    return (
        SECURITY_WORDS.some((word) => subject.includes(word)) ||
        (bareCode(message.subject) && SECURITY_WORDS.some((word) => words.includes(word)))
    );
}

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

/**
 * Words that mean money is about to move, or has moved on a schedule.
 *
 * The distinction from an update is tense and repetition rather than subject:
 * "your order has shipped" is something that happened once and is over, and
 * "your plan renews on the 3rd" is something that will happen again next month
 * whether or not anybody reads it. That second kind is the only mail in an inbox
 * with a deadline attached, which is the whole reason it gets a tab.
 *
 * An invoice is here rather than under updates for the same reason: it is a
 * demand, not a record.
 */
const BILLING_WORDS: readonly string[] = [
    // English
    "subscription",
    "subscriptions",
    "renew",
    "renews",
    "renewal",
    "auto-renew",
    "automatically renew",
    "will be charged",
    "we will charge",
    "upcoming payment",
    "next payment",
    "payment due",
    "amount due",
    "due on",
    "past due",
    "payment failed",
    "card declined",
    "card expiring",
    "card is expiring",
    "card expires",
    "card will expire",
    "billing",
    "invoice",
    "your plan",
    "plan renews",
    "membership",
    "trial ends",
    "trial is ending",
    "free trial ends",
    "direct debit",
    "instalment",
    "installment",
    // Spanish
    "suscripcion",
    "suscripciones",
    "renovacion",
    "se renueva",
    "se renovara",
    "renovacion automatica",
    "proximo pago",
    "proximos pagos",
    "proximo cobro",
    "se te cobrara",
    "cargo en tu",
    "cuota",
    "cuotas",
    "factura",
    "facturacion",
    "importe pendiente",
    "pago pendiente",
    "pago fallido",
    "domiciliacion",
    "tarjeta caduca",
    "tu plan",
    "prueba gratuita termina",
    "periodo de prueba",
    // Portuguese
    "assinatura",
    "renovacao",
    "proxima cobranca",
    "fatura",
    "mensalidade",
    // French
    "abonnement",
    "renouvellement",
    "prochain paiement",
    "prelevement",
    "facture",
    // German
    "abonnement",
    "verlangerung",
    "nachste zahlung",
    "rechnung faellig",
    "lastschrift",
    // Italian
    "abbonamento",
    "rinnovo",
    "prossimo pagamento",
    "fattura"
];

/** Words that mean a transaction happened. */
const UPDATE_WORDS: readonly string[] = [
    "receipt",
    "your order",
    "order confirmation",
    "order #",
    "shipped",
    "out for delivery",
    "delivered",
    "tracking",
    "payment",
    "statement",
    "your booking",
    "itinerary",
    "ticket",
    "refund",
    "recibo",
    "tu pedido",
    "pedido",
    "enviado",
    "en reparto",
    "entregado",
    "seguimiento",
    "pago",
    "reembolso",
    "tu reserva",
    "en aduanas",
    "encomenda",
    "pagamento",
    "commande",
    "livraison",
    "bestellung",
    "lieferung",
    "ordine",
    "spedizione"
];

/**
 * Which tab a message belongs under.
 *
 * The order of the questions is the whole of the logic. Security first, because
 * a code from a shop is still a code and burying it under Promotions is what
 * makes somebody go looking for their mail in another client. Social next,
 * because those senders are unambiguous. Then money about to move, which is the
 * only mail with a deadline on it. Then the two that both look like bulk mail,
 * told apart by what they say. Everything else is somebody writing.
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
    // And anything about the safety of an account rather than a code to type
    // into one: a leaked credential, a suspicious sign-in, a repository with a
    // secret in it. Read from the snippet as well as the subject, because these
    // are written as sentences rather than as headlines - "Action needed" says
    // nothing on its own, and the line under it says everything.
    if (SECURITY_ALERT_WORDS.some((word) => words.includes(word))) return "security";

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
    const billed = BILLING_WORDS.some((word) => words.includes(word));

    // Money about to move comes before everything except a code, and before the
    // word that is selling something: half of these arrive dressed as an offer -
    // "your plan renews, and here is 20% off the annual one" - and the half a
    // reader needs is the renewal.
    if (billed) return "billing";
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
