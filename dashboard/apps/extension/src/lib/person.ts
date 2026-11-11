/**
 * The personal details a form asks for beyond a name and an address: an
 * identity document, the date of birth - whole, or one box or dropdown each
 * for the day, the month and the year - the country of birth, the nationality
 * and the marital status.
 *
 * Pure, so what each box is taken for and what goes into it can be checked
 * without a browser. The page is read the way the rest of the extension reads
 * it (`FieldFacts`), plus `context`: the words of the group the box sits in,
 * because a box labelled "Día" says nothing about birth until its group says
 * "Fecha de nacimiento".
 */

import { autocompleteToken, type FieldFacts } from "@/lib/fields";
import { isPlaceholder, normalizePlace, type PlaceOption } from "@/lib/place-match";
import { dateParts, maritalStatusOf, MARITAL_STATUSES, type MaritalStatus } from "@polaris/core/identity-person";

export type PersonSlot =
    | "nationalId"
    | "birthDate"
    | "birthDay"
    | "birthMonth"
    | "birthYear"
    | "birthCountry"
    | "nationality"
    | "maritalStatus";

const BIRTH = /nacimiento|naci(?:do|da)|birth|\bdob\b|\bbday\b|naissance|geburt|nascita|nascimento/i;
const DATE = /fecha|\bdate\b|datum|\bdata\b/i;
const DAY = /\bd[ií]a\b|\bday\b|\bdd\b|\bjour\b|\btag\b|\bgiorno\b/i;
const MONTH = /\bmes\b|\bmonth\b|\bmm\b|\bmois\b|\bmonat\b|\bmese\b|\bm[eê]s\b/i;
const YEAR = /\ba[nñ]o\b|\byear\b|\byyyy\b|\baaaa\b|\byy\b|\bann[eé]e\b|\bjahr\b|\banno\b|\bano\b/i;
const NATIONAL_ID =
    /\bdni\b|\bnie\b|\btie\b|\bnif\b|documento de identidad|n[uú]m(?:ero|\.)? (?:de )?documento|document number|national id|identity (?:card|number|document)|\bid number\b|\bcpf\b|\bcurp\b|\brut\b|carte d.identit|personalausweis|codice fiscale|\bdocumento\b/i;
// A document's type, its expiry, or where it was issued is a different question.
const NOT_THE_NUMBER = /tipo|type|caducidad|expir|validez|valid|emisi[oó]n|issue|fecha|date|pa[ií]s/i;
const BIRTH_COUNTRY =
    /pa[ií]s de nacimiento|country of birth|birth ?country|pays de naissance|geburtsland|paese di nascita|pa[ií]s natal|lugar de nacimiento|place of birth/i;
const NATIONALITY = /nacionalidad|nationality|citizenship|nationalit[eé]|staatsangeh|cittadinanza|nazionalit/i;
const MARITAL = /estado civil|marital|civil status|situation (?:familiale|matrimoniale)|familienstand|stato civile/i;

/** Which detail a box or dropdown asks for, or null. Its own token first, then
 *  its words, then - for the parts of a date - the words of its group. */
export function personSlot(field: FieldFacts, context: string): PersonSlot | null {
    if (!field.usable) return null;
    const token = autocompleteToken(field.autocomplete);
    if (token === "bday") return "birthDate";
    if (token === "bday-day") return "birthDay";
    if (token === "bday-month") return "birthMonth";
    if (token === "bday-year") return "birthYear";
    const select = field.type === "select-one";
    const words = field.words;
    if (MARITAL.test(words)) return select || field.type === "text" ? "maritalStatus" : null;
    if (BIRTH_COUNTRY.test(words)) return "birthCountry";
    if (NATIONALITY.test(words)) return "nationality";
    if (!select && NATIONAL_ID.test(words) && !NOT_THE_NUMBER.test(words)) return "nationalId";
    const birth = BIRTH.test(words) || BIRTH.test(context);
    if (!birth) return null;
    // The parts before the whole: "día de nacimiento" says "nacimiento" too.
    if (DAY.test(words)) return "birthDay";
    if (MONTH.test(words)) return "birthMonth";
    if (YEAR.test(words)) return "birthYear";
    if (select) return null;
    if (field.type === "date" || DATE.test(words) || /birthday|cumplea|\bdob\b/i.test(words)) {
        return BIRTH.test(words) || field.type === "date" ? "birthDate" : null;
    }
    return null;
}

/** The stored marital status, read whatever shape another client left it in. */
export function storedStatus(stored: string): MaritalStatus | null {
    const value = stored.trim();
    if ((MARITAL_STATUSES as readonly string[]).includes(value)) return value as MaritalStatus;
    return maritalStatusOf(value);
}

/**
 * A date of birth typed into one box: `YYYY-MM-DD` where the box is a date
 * picker or says so, else in the order its placeholder spells, else in the
 * page language's usual order.
 */
export function dateForBox(
    stored: string,
    box: { type: string; hint: string; lang: string }
): string {
    const parts = dateParts(stored);
    if (!parts) return "";
    const dd = String(parts.day).padStart(2, "0");
    const mm = String(parts.month).padStart(2, "0");
    const yyyy = String(parts.year);
    if (box.type === "date") return `${yyyy}-${mm}-${dd}`;
    const hint = box.hint.toLowerCase();
    const shape = /(dd|mm|yyyy|aaaa|jj|tt|gg)([./\- ])(dd|mm|jj|tt|gg)\2(yyyy|aaaa|jjjj|aa|yy)/.exec(hint);
    if (shape) {
        const sep = shape[2] ?? "/";
        const first = shape[1] === "mm" ? mm : dd;
        const second = shape[1] === "mm" ? dd : mm;
        return `${first}${sep}${second}${sep}${yyyy}`;
    }
    if (/(yyyy|aaaa)-mm-dd/.test(hint)) return `${yyyy}-${mm}-${dd}`;
    const lang = box.lang.toLowerCase();
    if (lang === "en-us" || lang === "en") return `${mm}/${dd}/${yyyy}`;
    if (lang.startsWith("de")) return `${dd}.${mm}.${yyyy}`;
    return `${dd}/${mm}/${yyyy}`;
}

/** One part of the date typed into a box of its own. */
export function datePartForBox(
    stored: string,
    part: "birthDay" | "birthMonth" | "birthYear",
    maxLength: number | null
): string {
    const parts = dateParts(stored);
    if (!parts) return "";
    if (part === "birthYear") return maxLength === 2 ? String(parts.year).slice(2) : String(parts.year);
    const number = part === "birthDay" ? parts.day : parts.month;
    return maxLength === 1 ? String(number) : String(number).padStart(2, "0");
}

/** Month names in a language, long and short, January first. */
function monthNames(locale: string): string[][] {
    const out: string[][] = [];
    for (const style of ["long", "short"] as const) {
        try {
            const format = new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" });
            out.push(Array.from({ length: 12 }, (_, at) => normalizePlace(format.format(new Date(Date.UTC(2000, at, 1))))));
        } catch {
            // A language this runtime cannot name months in.
        }
    }
    return out;
}

/**
 * The option of a day, month or year dropdown that is the stored date's, or -1.
 * By number - value or text, so `05` and `5` both match - and for the month by
 * its name in any of `locales`.
 */
export function pickDatePart(
    options: readonly PlaceOption[],
    stored: string,
    part: "birthDay" | "birthMonth" | "birthYear",
    locales: readonly string[]
): number {
    const parts = dateParts(stored);
    if (!parts) return -1;
    const wanted = part === "birthDay" ? parts.day : part === "birthMonth" ? parts.month : parts.year;
    const number = (raw: string): number | null => {
        const text = raw.trim();
        return /^\d{1,4}$/.test(text) ? Number(text) : null;
    };
    const byNumber = options.findIndex(
        (option) => !isPlaceholder(option) && (number(option.value) === wanted || number(option.text) === wanted)
    );
    if (byNumber !== -1 || part !== "birthMonth") return byNumber;
    for (const locale of locales) {
        for (const names of monthNames(locale)) {
            const name = names[wanted - 1];
            if (!name) continue;
            const index = options.findIndex((option) => normalizePlace(option.text).replace(/\.$/, "") === name.replace(/\.$/, ""));
            if (index !== -1) return index;
        }
    }
    return -1;
}

/** The option of a marital status dropdown that is the stored status, or -1. */
export function pickStatus(options: readonly PlaceOption[], stored: string): number {
    const status = storedStatus(stored);
    if (!status) return -1;
    return options.findIndex(
        (option) => !isPlaceholder(option) && (maritalStatusOf(option.text) === status || maritalStatusOf(option.value) === status)
    );
}

/** Whether a box asks for an email or phone typed a second time. */
export const CONFIRM_WORDS = /confirm|repite|repetir|repeat|re-?enter|verif|vuelve a|otra vez|again|wiederhol|ressaisi/i;
