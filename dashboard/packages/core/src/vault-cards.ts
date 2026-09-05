/**
 * Reading a payment card the way the form somebody is copying it from does.
 *
 * A vault that takes sixteen digits and says nothing is a vault where a typo
 * sits until the day the card is needed. Everything here is what a checkout page
 * already does and what a password manager, oddly, usually does not: name the
 * brand from the number as it is typed, refuse a number whose own check digit
 * disagrees with it, and read `0830` as August 2030 because that is how it is
 * printed on the card.
 *
 * Pure and offline. No number is sent anywhere to be recognised - the ranges
 * below are published by the networks themselves and the check digit is
 * arithmetic - which matters rather more here than elsewhere, since this is a
 * vault whose server is not supposed to learn anything.
 */

/** The brands worth telling apart, in the spelling Bitwarden stores so an item
 *  written here reads correctly in another client. */
export const CARD_BRANDS = [
    "Visa",
    "Mastercard",
    "Amex",
    "Discover",
    "Diners Club",
    "JCB",
    "UnionPay",
    "Maestro"
] as const;

export type CardBrand = (typeof CARD_BRANDS)[number];

/**
 * Which brand a number belongs to, from its opening digits.
 *
 * The ranges are the networks' own, and the order matters: Maestro and Discover
 * both claim prefixes inside ranges another brand also claims, so the more
 * specific test has to run first. Null while there is not enough typed to tell,
 * which is most of the time somebody is typing.
 */
export function cardBrand(number: string): CardBrand | null {
    const digits = onlyDigits(number);
    if (digits.length < 2) return null;

    if (/^4/.test(digits)) return "Visa";
    if (/^3[47]/.test(digits)) return "Amex";
    if (/^3(?:0[0-5]|[68])/.test(digits)) return "Diners Club";
    if (/^35(?:2[89]|[3-8])/.test(digits) || /^35$/.test(digits)) return "JCB";
    if (/^62/.test(digits)) return "UnionPay";
    if (/^6(?:011|4[4-9]|5)/.test(digits)) return "Discover";
    if (/^(?:5[06-9]|6[37])/.test(digits)) return "Maestro";
    if (/^5[1-5]/.test(digits) || /^2(?:2[2-9]|[3-6]|7[01]|720)/.test(digits)) return "Mastercard";
    return null;
}

/** How many digits each brand's numbers have. Anything not listed is judged by
 *  the general range, since the networks do issue lengths outside the famous
 *  sixteen. */
const BRAND_LENGTHS: Partial<Record<CardBrand, number[]>> = {
    Visa: [13, 16, 19],
    Mastercard: [16],
    Amex: [15],
    Discover: [16, 19],
    "Diners Club": [14, 16, 19],
    JCB: [16, 17, 18, 19],
    UnionPay: [16, 17, 18, 19],
    Maestro: [12, 13, 14, 15, 16, 17, 18, 19]
};

function onlyDigits(value: string): string {
    return value.replace(/\D/g, "");
}

/**
 * The Luhn check, which is what the last digit of a card number is for.
 *
 * It catches a single mistyped digit and most transpositions, which between them
 * are nearly every way a number gets copied wrong. It says nothing about whether
 * the card exists - only that the number is not one nobody could have been
 * issued.
 */
export function luhnValid(number: string): boolean {
    const digits = onlyDigits(number);
    if (digits.length < 12) return false;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index]);
        if (double) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        double = !double;
    }
    return sum % 10 === 0;
}

/**
 * What is wrong with a card number, or null.
 *
 * Nothing is said while it is too short to judge: a number is wrong for most of
 * the time it is being typed, and a form that says so is a form shouting at
 * somebody halfway through a word.
 */
export function cardNumberProblem(number: string): string | null {
    const digits = onlyDigits(number);
    if (digits.length === 0) return null;
    const brand = cardBrand(digits);
    const lengths = brand ? BRAND_LENGTHS[brand] : undefined;
    const longest = lengths ? Math.max(...lengths) : 19;
    if (digits.length < (lengths ? Math.min(...lengths) : 12)) return null;
    if (lengths && !lengths.includes(digits.length)) {
        return digits.length > longest ? "That is more digits than a card number has." : null;
    }
    return luhnValid(digits) ? null : "Those digits do not add up - one of them is probably wrong.";
}

/** The number in the groups it is printed in, so it can be read back against
 *  the card. Amex prints 4-6-5; everybody else prints fours. */
export function groupCardNumber(number: string): string {
    const digits = onlyDigits(number);
    const groups = cardBrand(digits) === "Amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
    const parts: string[] = [];
    let at = 0;
    for (const size of groups) {
        if (at >= digits.length) break;
        parts.push(digits.slice(at, at + size));
        at += size;
    }
    return parts.join(" ");
}

/** An expiry as it is stored: two fields, because that is what the cipher model
 *  has and what other clients read. */
export interface CardExpiry {
    month: string;
    year: string;
}

/**
 * The expiry out of whatever somebody typed into one box.
 *
 * One box rather than two, because a card prints one: `08/30`, and people type
 * `0830`, `08/30`, `08 / 2030`. All of them mean the same August. Null for
 * anything that is not a month and a year - including `13/30`, which is the
 * transposition this is most likely to catch.
 *
 * A two-digit year is this century. A card expiring in 2099 is a card nobody
 * reading this will have to worry about.
 */
export function readCardExpiry(typed: string): CardExpiry | null {
    const digits = onlyDigits(typed);
    if (digits.length !== 4 && digits.length !== 6) return null;
    const month = Number(digits.slice(0, 2));
    if (month < 1 || month > 12) return null;
    const yearDigits = digits.slice(2);
    const year = yearDigits.length === 2 ? 2000 + Number(yearDigits) : Number(yearDigits);
    if (year < 2000 || year > 2099) return null;
    return { month: String(month).padStart(2, "0"), year: String(year) };
}

/** The expiry written the way the card prints it, for the one box. */
export function writeCardExpiry(expiry: CardExpiry): string {
    const month = expiry.month.padStart(2, "0");
    const year = expiry.year.length === 4 ? expiry.year.slice(2) : expiry.year;
    return month && year ? `${month}/${year}` : "";
}

/**
 * Whether a card has expired, as of a given day.
 *
 * A card is good through the last day of the month it names, which is what the
 * date on the front means and is a month more than "before that month" would
 * give. `now` is passed in rather than read, so this is a function of its
 * arguments and can be tested on a day that is not today.
 */
export function cardExpired(expiry: CardExpiry, now: Date): boolean {
    const month = Number(expiry.month);
    const year = Number(expiry.year);
    if (!month || !year) return false;
    // The first instant of the month after it: anything from there on is past.
    return now.getTime() >= new Date(year, month, 1).getTime();
}

/** Whether it expires within the next few months, which is worth saying before
 *  the day it stops working rather than after. */
export function cardExpiringSoon(expiry: CardExpiry, now: Date, months = 2): boolean {
    if (cardExpired(expiry, now)) return false;
    const month = Number(expiry.month);
    const year = Number(expiry.year);
    if (!month || !year) return false;
    const warnFrom = new Date(now.getFullYear(), now.getMonth() + months, 1);
    return new Date(year, month, 1).getTime() <= warnFrom.getTime();
}
