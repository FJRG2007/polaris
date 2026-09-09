/**
 * Mail that says it is somebody it is not.
 *
 * The single most common shape of phishing, and the one the rest of the filter
 * is blind to. Everything else it measures is about wording, punctuation and
 * links; none of that catches a message whose only real lie is the name at the
 * top:
 *
 *     Subject: Your Net-flix account needs a quick review
 *     From:    NETFLIX <billing@some-domain-nobody-has-heard-of.tld>
 *
 * Every word in it is ordinary. It shouts nothing, it promises no money, and it
 * links to a site that has never been reported. What makes it phishing is that
 * a name people trust is on a message from a domain that has nothing to do with
 * that name - and that is a comparison, not a vocabulary.
 *
 * **Where the name is read matters.** Only the subject and the sender's own
 * display name count, because those are the two places a lie has to be for the
 * message to work, and they are the two places an honest mention almost never
 * appears. A newsletter that discusses Netflix in its body is not pretending to
 * be Netflix; a message titled "Your Netflix account" from a stranger is.
 *
 * **The name has to be recognised through the dressing.** `Net-flix`,
 * `N e t f l i x`, `NETFL1X` and `Netflíx` are all written to pass a matcher
 * that looks for the word - so the comparison is done on a squashed form with
 * the separators and the accents taken out and the digits people substitute put
 * back. That is also a signal in itself: nobody writes their own brand with a
 * hyphen in the middle of it.
 *
 * **And it is only a lie if the message is not theirs.** A message that comes
 * from any of these names' own domains, or that links to the one it mentions, is
 * that name's message - one of them naming another is a receipt, not a disguise.
 * That check is what keeps the real ones out of this, and it is why the table
 * below is domains rather than words. The exception is the domains anybody can
 * have a mailbox at, which say who sent nothing at all.
 */

import { baseDomain } from "./vault-uris.js";

/** A name people are phished with, and where its mail genuinely comes from. */
export interface ImpersonatedBrand {
    /** A stable key, for the reason line and for tests. */
    readonly id: string;
    /** What to call it on screen. */
    readonly label: string;
    /** How it is written, as `squash` leaves it - lower case, no accents, and a
     *  single space wherever the name itself has one. Several where a brand is
     *  known by more than one name. */
    readonly names: readonly string[];
    /** The registrable domains its mail and its links legitimately come from. */
    readonly domains: readonly string[];
    /**
     * Which of the names above are also ordinary words.
     *
     * `orange`, `visa` and `apple` are a colour, a document and a fruit, and a
     * subject line containing one of them is usually about none of the three
     * companies. Those only count when the message is also asking for account
     * details, which is the combination that is never innocent.
     *
     * Named one by one rather than marked on the brand, because a brand is
     * usually known by one ordinary word and several that are nobody else's:
     * `hacienda` is a word and `agencia tributaria` is not, `apple` is a fruit
     * and `icloud` is not, and holding the whole brand to the weaker rule would
     * throw away the names that are worth the most.
     */
    readonly common?: readonly string[];
}

/**
 * The names worth checking.
 *
 * Deliberately not "every large company": each entry costs a comparison on
 * every message, and what belongs here is what is actually used to phish people
 * - the streaming and shopping accounts, the couriers, the banks, the tax
 * office and the utilities. Written for the two places this app is read in, so
 * the Spanish institutions people are actually phished as are here beside the
 * global ones.
 */
export const IMPERSONATED_BRANDS: readonly ImpersonatedBrand[] = [
    { id: "netflix", label: "Netflix", names: ["netflix"], domains: ["netflix.com"] },
    { id: "paypal", label: "PayPal", names: ["paypal"], domains: ["paypal.com", "paypal.es"] },
    {
        id: "apple",
        label: "Apple",
        names: ["apple", "icloud", "apple id"],
        domains: ["apple.com", "icloud.com"],
        common: ["apple"]
    },
    {
        id: "microsoft",
        label: "Microsoft",
        names: ["microsoft", "office 365", "outlook", "onedrive"],
        domains: ["microsoft.com", "outlook.com", "office.com", "live.com", "microsoftonline.com"]
    },
    {
        id: "amazon",
        label: "Amazon",
        names: ["amazon"],
        domains: ["amazon.com", "amazon.es", "amazon.co.uk", "amazon.de"]
    },
    {
        id: "google",
        label: "Google",
        names: ["google", "gmail"],
        domains: ["google.com", "gmail.com"]
    },
    {
        id: "meta",
        label: "Meta",
        names: ["facebook", "instagram", "whatsapp"],
        domains: ["facebook.com", "instagram.com", "whatsapp.com", "meta.com", "facebookmail.com"]
    },
    { id: "linkedin", label: "LinkedIn", names: ["linkedin"], domains: ["linkedin.com"] },
    { id: "telegram", label: "Telegram", names: ["telegram"], domains: ["telegram.org"] },
    {
        id: "steam",
        label: "Steam",
        names: ["steam", "steampowered"],
        domains: ["steampowered.com", "valvesoftware.com"]
    },
    { id: "spotify", label: "Spotify", names: ["spotify"], domains: ["spotify.com"] },
    {
        id: "disney",
        label: "Disney+",
        names: ["disney plus", "disney"],
        domains: ["disneyplus.com", "disney.com"]
    },
    {
        id: "hbo",
        label: "HBO Max",
        names: ["hbo max", "hbo"],
        domains: ["hbomax.com", "max.com", "hbo.com"]
    },
    { id: "dropbox", label: "Dropbox", names: ["dropbox"], domains: ["dropbox.com"] },
    { id: "adobe", label: "Adobe", names: ["adobe"], domains: ["adobe.com"] },
    { id: "binance", label: "Binance", names: ["binance"], domains: ["binance.com"] },
    { id: "coinbase", label: "Coinbase", names: ["coinbase"], domains: ["coinbase.com"] },
    { id: "ebay", label: "eBay", names: ["ebay"], domains: ["ebay.com", "ebay.es"] },
    { id: "aliexpress", label: "AliExpress", names: ["aliexpress"], domains: ["aliexpress.com"] },
    { id: "booking", label: "Booking.com", names: ["booking com"], domains: ["booking.com"] },
    { id: "airbnb", label: "Airbnb", names: ["airbnb"], domains: ["airbnb.com", "airbnb.es"] },
    { id: "dhl", label: "DHL", names: ["dhl"], domains: ["dhl.com", "dhl.de", "dhl.es"] },
    { id: "ups", label: "UPS", names: ["ups"], domains: ["ups.com"], common: ["ups"] },
    { id: "fedex", label: "FedEx", names: ["fedex"], domains: ["fedex.com"] },
    {
        id: "correos",
        label: "Correos",
        names: ["correos"],
        domains: ["correos.es", "correos.com"],
        common: ["correos"]
    },
    { id: "seur", label: "SEUR", names: ["seur"], domains: ["seur.com", "seur.es"] },
    { id: "mrw", label: "MRW", names: ["mrw"], domains: ["mrw.es"] },
    { id: "glovo", label: "Glovo", names: ["glovo"], domains: ["glovoapp.com"] },
    {
        id: "santander",
        label: "Santander",
        names: ["santander"],
        domains: ["santander.es", "santander.com"]
    },
    { id: "bbva", label: "BBVA", names: ["bbva"], domains: ["bbva.es", "bbva.com"] },
    {
        id: "caixabank",
        label: "CaixaBank",
        names: ["caixabank", "la caixa"],
        domains: ["caixabank.es", "caixabank.com"]
    },
    {
        id: "sabadell",
        label: "Banco Sabadell",
        names: ["banco sabadell", "sabadell"],
        domains: ["bancsabadell.com", "bancosabadell.com"]
    },
    { id: "bankinter", label: "Bankinter", names: ["bankinter"], domains: ["bankinter.com"] },
    { id: "openbank", label: "Openbank", names: ["openbank"], domains: ["openbank.es"] },
    { id: "revolut", label: "Revolut", names: ["revolut"], domains: ["revolut.com"] },
    { id: "n26", label: "N26", names: ["n26"], domains: ["n26.com"] },
    {
        id: "visa",
        label: "Visa",
        names: ["visa"],
        domains: ["visa.com", "visa.es"],
        common: ["visa"]
    },
    {
        id: "mastercard",
        label: "Mastercard",
        names: ["mastercard"],
        domains: ["mastercard.com", "mastercard.es"]
    },
    {
        id: "aeat",
        label: "the Agencia Tributaria",
        names: ["agencia tributaria", "hacienda", "aeat"],
        domains: ["agenciatributaria.es", "agenciatributaria.gob.es"],
        common: ["hacienda"]
    },
    { id: "dgt", label: "the DGT", names: ["dgt"], domains: ["dgt.es", "sede.dgt.gob.es"] },
    {
        id: "segsocial",
        label: "the Seguridad Social",
        names: ["seguridad social"],
        domains: ["seg-social.es", "seg-social.gob.es"]
    },
    { id: "endesa", label: "Endesa", names: ["endesa"], domains: ["endesa.com", "endesa.es"] },
    {
        id: "iberdrola",
        label: "Iberdrola",
        names: ["iberdrola"],
        domains: ["iberdrola.es", "iberdrola.com"]
    },
    { id: "naturgy", label: "Naturgy", names: ["naturgy"], domains: ["naturgy.es", "naturgy.com"] },
    {
        id: "movistar",
        label: "Movistar",
        names: ["movistar", "telefonica"],
        domains: ["movistar.es", "telefonica.com"]
    },
    {
        id: "vodafone",
        label: "Vodafone",
        names: ["vodafone"],
        domains: ["vodafone.es", "vodafone.com"]
    },
    {
        id: "orange",
        label: "Orange",
        names: ["orange"],
        domains: ["orange.es", "orange.com"],
        common: ["orange"]
    }
];

/**
 * The form a name is compared in.
 *
 * Accents off and the digits people substitute put back, so `Netflíx` and
 * `NETFL1X` both arrive as `netflix`. Everything that is not a letter or a digit
 * becomes a space rather than disappearing: joining the words up would let
 * `much boat` contain `hbo`, which is exactly the kind of accident a filter
 * never lives down.
 */
export function squash(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/0/g, "o")
        .replace(/1/g, "i")
        .replace(/3/g, "e")
        .replace(/4/g, "a")
        .replace(/5/g, "s")
        .replace(/7/g, "t")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** What people put between the letters to get a name past a matcher: a space, a
 *  dot, a hyphen, an underscore. Two at most between any pair - more than that
 *  is not a disguised word, it is a different sentence. */
const DRESSING = "[\\s._-]{0,2}";

/** One name to look for, ready to compare. */
interface NamePattern {
    /** Whether this particular name is also an ordinary word. */
    readonly common: boolean;
    /** The name, however it has been dressed up. What it matched is read back
     *  afterwards to see how much dressing it took. */
    readonly dressed: RegExp;
    /** How many separators the name has of its own: one for `Agencia
     *  Tributaria`, none for `Netflix`. What a match is allowed before it reads
     *  as somebody writing the name oddly on purpose. */
    readonly spacing: number;
}

/**
 * The names, compiled. Built once: this is a table of fifty names and a message
 * is judged on arrival.
 *
 * Compiled from the *squashed* name rather than from the name as it is written
 * in the table, because the squashed form is what the comparison happens in.
 * `Office 365` squashes to `office e6s` - the digits people substitute are
 * mapped back whether or not the brand put them there itself - so a pattern
 * built from the raw name is a pattern that can never match anything, silently,
 * for every name in the table that has a digit in it.
 */
const PATTERNS = new Map<string, readonly NamePattern[]>(
    IMPERSONATED_BRANDS.map((brand) => [
        brand.id,
        brand.names.map((name) => {
            const written = squash(name);
            return {
                common: brand.common?.includes(name) ?? false,
                dressed: new RegExp(`\\b${[...written.replace(/\s+/g, "")].join(DRESSING)}\\b`),
                spacing: (written.match(/ /g) ?? []).length
            };
        })
    ])
);

/**
 * Whether the name had to be undressed to be read.
 *
 * What the match holds is read back with the letters taken out, leaving exactly
 * what somebody put between them, and weighed against what the name has of its
 * own. `Netflix` has nothing between its letters, so `Net-flix` and
 * `N e t f l i x` are both somebody's doing; `Agencia Tributaria` has one space,
 * and writing it with that one space is writing it correctly.
 *
 * Getting this wrong is not a missed phish, it is a sentence on the screen
 * accusing an institution of dressing up its own name on the strength of it
 * being spelled the way it is spelled - and every name in the table that is two
 * words would have carried it.
 */
function dressing(matched: string, spacing: number): boolean {
    return matched.replace(/[a-z0-9]/g, "").length > spacing;
}

/**
 * The domains of the table, as the comparison sees them.
 *
 * Every one of them is put through the same `baseDomain` the rest of the filter
 * uses, so both sides of the comparison are the same shape. Doing it any other
 * way is how `amazon.co.uk` came to be unreachable: a sender at
 * `mail.amazon.co.uk` reduces to `amazon.co.uk`, and a table holding the string
 * it was typed as would still have matched, but a table holding a *different*
 * reduction of it would not.
 */
const OWNED = new Map<string, ReadonlySet<string>>(
    IMPERSONATED_BRANDS.map((brand) => [
        brand.id,
        new Set(brand.domains.map((one) => baseDomain(one)))
    ])
);

/**
 * The domains in the table that anybody at all can have an address at.
 *
 * Some of these names are mailbox providers, and a sender at one of them is a
 * person rather than the company: a phishing message sent from a free account is
 * the oldest shape there is. So they identify nobody, and they are the one part
 * of the table that cannot exonerate a message.
 */
const PUBLIC_MAILBOXES: ReadonlySet<string> = new Set([
    "gmail.com",
    "icloud.com",
    "outlook.com",
    "live.com"
]);

/** Every domain in the table that says who sent a message, in one set: what
 *  answers "is this sender one of these names in its own right". */
const ALL_OWNED: ReadonlySet<string> = new Set(
    [...OWNED.values()].flatMap((domains) =>
        [...domains].filter((one) => !PUBLIC_MAILBOXES.has(one))
    )
);

/** What was found, and how badly it was dressed. */
export interface BrandClaim {
    readonly brand: ImpersonatedBrand;
    /** True when the name only reads as itself once the dressing is taken off -
     *  the hyphen in `Net-flix`, the spaces in `N e t f l i x`, the dots in
     *  `N.E.T.F.L.I.X`. Nobody writes their own name that way. */
    readonly obfuscated: boolean;
}

/**
 * The brand a message claims to be, when the message is not that brand's.
 *
 * `null` for the overwhelming majority of mail, including every real message
 * from every brand in the table: a message whose sender or whose links belong to
 * the brand it names is that brand's message.
 *
 * `asksForAccount` is passed in rather than worked out here, so the caller keeps
 * one definition of what account bait reads like. It decides whether the names
 * that are also ordinary words count at all.
 */
export function brandClaim(
    input: {
        readonly subject: string;
        readonly fromName: string;
        readonly fromDomain: string;
        readonly linkHosts: readonly string[];
    },
    asksForAccount: boolean
): BrandClaim | null {
    // The subject and the sender's name, and deliberately nothing else: those
    // are the two places the lie has to be, and the two places an honest mention
    // almost never is.
    const text = squash(`${input.subject} ${input.fromName}`);
    if (!text) return null;

    const from = baseDomain(input.fromDomain);
    // A message sent by one of these names is not impersonating another one of
    // them. An Apple receipt for a Spotify subscription names Spotify, and PayPal
    // saying "you sent a payment to Netflix" names Netflix; both are the sender's
    // own mail, and reading the table in order would have accused them of the
    // first name they happen to mention.
    if (from && ALL_OWNED.has(from)) return null;

    const linked = new Set(input.linkHosts.map((host) => baseDomain(host)));

    for (const brand of IMPERSONATED_BRANDS) {
        const owned = OWNED.get(brand.id);
        for (const pattern of PATTERNS.get(brand.id) ?? []) {
            const found = pattern.dressed.exec(text);
            if (!found) continue;
            if (pattern.common && !asksForAccount) continue;
            // Theirs. A message that sends the reader to the brand is the brand
            // talking about itself - the sender's side of the same question was
            // answered above, for the whole table at once.
            if (owned && [...linked].some((host) => owned.has(host))) return null;
            return { brand, obfuscated: dressing(found[0], pattern.spacing) };
        }
    }
    return null;
}
