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
 * **And it is only a lie if the message is not theirs.** A brand named by a
 * message that comes from that brand's own domain, or that links to it, is a
 * message from that brand. That check is what keeps the real receipts out of
 * this, and it is why the table below is domains rather than words.
 */

/** A name people are phished with, and where its mail genuinely comes from. */
export interface ImpersonatedBrand {
    /** A stable key, for the reason line and for tests. */
    readonly id: string;
    /** What to call it on screen. */
    readonly label: string;
    /** How it is written, squashed - see `squash`. Several where a brand is
     *  known by more than one name. */
    readonly names: readonly string[];
    /** The registrable domains its mail and its links legitimately come from. */
    readonly domains: readonly string[];
    /**
     * Whether the name is also an ordinary word.
     *
     * `orange`, `visa` and `apple` are a colour, a document and a fruit, and a
     * subject line containing one of them is usually about none of the three
     * companies. Those only count when the message is also asking for account
     * details, which is the combination that is never innocent.
     */
    readonly common?: boolean;
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
        names: ["apple", "icloud", "appleid"],
        domains: ["apple.com", "icloud.com"],
        common: true
    },
    {
        id: "microsoft",
        label: "Microsoft",
        names: ["microsoft", "office365", "outlook", "onedrive"],
        domains: ["microsoft.com", "outlook.com", "office.com", "live.com", "microsoftonline.com"]
    },
    {
        id: "amazon",
        label: "Amazon",
        names: ["amazon"],
        domains: ["amazon.com", "amazon.es", "amazon.co.uk", "amazon.de"]
    },
    { id: "google", label: "Google", names: ["google", "gmail"], domains: ["google.com", "gmail.com"] },
    {
        id: "meta",
        label: "Meta",
        names: ["facebook", "instagram", "whatsapp"],
        domains: ["facebook.com", "instagram.com", "whatsapp.com", "meta.com", "facebookmail.com"]
    },
    { id: "linkedin", label: "LinkedIn", names: ["linkedin"], domains: ["linkedin.com"] },
    { id: "telegram", label: "Telegram", names: ["telegram"], domains: ["telegram.org"] },
    { id: "steam", label: "Steam", names: ["steam", "steampowered"], domains: ["steampowered.com", "valvesoftware.com"] },
    { id: "spotify", label: "Spotify", names: ["spotify"], domains: ["spotify.com"] },
    { id: "disney", label: "Disney+", names: ["disneyplus", "disney"], domains: ["disneyplus.com", "disney.com"] },
    { id: "hbo", label: "HBO Max", names: ["hbomax", "hbo"], domains: ["hbomax.com", "max.com", "hbo.com"] },
    { id: "dropbox", label: "Dropbox", names: ["dropbox"], domains: ["dropbox.com"] },
    { id: "adobe", label: "Adobe", names: ["adobe"], domains: ["adobe.com"] },
    { id: "binance", label: "Binance", names: ["binance"], domains: ["binance.com"] },
    { id: "coinbase", label: "Coinbase", names: ["coinbase"], domains: ["coinbase.com"] },
    { id: "ebay", label: "eBay", names: ["ebay"], domains: ["ebay.com", "ebay.es"] },
    { id: "aliexpress", label: "AliExpress", names: ["aliexpress"], domains: ["aliexpress.com"] },
    { id: "booking", label: "Booking.com", names: ["bookingcom"], domains: ["booking.com"] },
    { id: "airbnb", label: "Airbnb", names: ["airbnb"], domains: ["airbnb.com", "airbnb.es"] },
    { id: "dhl", label: "DHL", names: ["dhl"], domains: ["dhl.com", "dhl.de", "dhl.es"] },
    { id: "ups", label: "UPS", names: ["ups"], domains: ["ups.com"], common: true },
    { id: "fedex", label: "FedEx", names: ["fedex"], domains: ["fedex.com"] },
    { id: "correos", label: "Correos", names: ["correos"], domains: ["correos.es", "correos.com"] },
    { id: "seur", label: "SEUR", names: ["seur"], domains: ["seur.com", "seur.es"] },
    { id: "mrw", label: "MRW", names: ["mrw"], domains: ["mrw.es"] },
    { id: "glovo", label: "Glovo", names: ["glovo"], domains: ["glovoapp.com"] },
    { id: "santander", label: "Santander", names: ["santander"], domains: ["santander.es", "santander.com"] },
    { id: "bbva", label: "BBVA", names: ["bbva"], domains: ["bbva.es", "bbva.com"] },
    { id: "caixabank", label: "CaixaBank", names: ["caixabank", "lacaixa"], domains: ["caixabank.es", "caixabank.com"] },
    { id: "sabadell", label: "Banco Sabadell", names: ["bancosabadell", "sabadell"], domains: ["bancsabadell.com", "bancosabadell.com"] },
    { id: "bankinter", label: "Bankinter", names: ["bankinter"], domains: ["bankinter.com"] },
    { id: "openbank", label: "Openbank", names: ["openbank"], domains: ["openbank.es"] },
    { id: "revolut", label: "Revolut", names: ["revolut"], domains: ["revolut.com"] },
    { id: "n26", label: "N26", names: ["n26"], domains: ["n26.com"] },
    { id: "visa", label: "Visa", names: ["visa"], domains: ["visa.com", "visa.es"], common: true },
    { id: "mastercard", label: "Mastercard", names: ["mastercard"], domains: ["mastercard.com", "mastercard.es"] },
    {
        id: "aeat",
        label: "the Agencia Tributaria",
        names: ["agenciatributaria", "hacienda", "aeat"],
        domains: ["agenciatributaria.es", "agenciatributaria.gob.es"]
    },
    { id: "dgt", label: "the DGT", names: ["dgt"], domains: ["dgt.es", "sede.dgt.gob.es"] },
    {
        id: "segsocial",
        label: "the Seguridad Social",
        names: ["seguridadsocial"],
        domains: ["seg-social.es", "seg-social.gob.es"]
    },
    { id: "endesa", label: "Endesa", names: ["endesa"], domains: ["endesa.com", "endesa.es"] },
    { id: "iberdrola", label: "Iberdrola", names: ["iberdrola"], domains: ["iberdrola.es", "iberdrola.com"] },
    { id: "naturgy", label: "Naturgy", names: ["naturgy"], domains: ["naturgy.es", "naturgy.com"] },
    { id: "movistar", label: "Movistar", names: ["movistar", "telefonica"], domains: ["movistar.es", "telefonica.com"] },
    { id: "vodafone", label: "Vodafone", names: ["vodafone"], domains: ["vodafone.es", "vodafone.com"] },
    { id: "orange", label: "Orange", names: ["orange"], domains: ["orange.es", "orange.com"], common: true }
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

/** The name as written, and the name however it has been dressed up. Built once:
 *  this is a table of fifty names and a message is judged on arrival. */
const PATTERNS = new Map<string, { plain: RegExp; dressed: RegExp }>(
    IMPERSONATED_BRANDS.flatMap((brand) =>
        brand.names.map((name) => [
            name,
            {
                plain: new RegExp(`\\b${name}\\b`),
                dressed: new RegExp(`\\b${[...name].join(DRESSING)}\\b`)
            }
        ] as const)
    )
);

/** A registrable domain, near enough: the last two labels. The same rule the
 *  rest of the filter uses, and enough to compare against a table of well-known
 *  names. */
function baseDomain(host: string): string {
    const parts = host.trim().toLowerCase().replace(/\.$/, "").split(".");
    return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

/** What was found, and how badly it was dressed. */
export interface BrandClaim {
    readonly brand: ImpersonatedBrand;
    /** True when the name only reads as itself once the dressing is taken off -
     *  the hyphen in `Net-flix`, the spaces in `N e t f l i x`, the accent in
     *  `Netflíx`. Nobody writes their own name that way. */
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
    const linked = new Set(input.linkHosts.map((host) => baseDomain(host)));

    for (const brand of IMPERSONATED_BRANDS) {
        for (const name of brand.names) {
            const pattern = PATTERNS.get(name);
            if (!pattern) continue;
            const plain = pattern.plain.test(text);
            const dressed = plain || pattern.dressed.test(text);
            if (!dressed) continue;
            if (brand.common && !asksForAccount) continue;
            // Theirs. A message from the brand's own domain, or one that sends
            // the reader to it, is the brand talking about itself.
            if (brand.domains.includes(from)) return null;
            if (brand.domains.some((domain) => linked.has(domain))) return null;
            return { brand, obfuscated: !plain };
        }
    }
    return null;
}
