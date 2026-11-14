/**
 * The street line of an identity in its parts, and the extra emails and phones.
 *
 * Bitwarden's identity has one free street line (`address1`) and one email and
 * one phone. Sign-up forms - Spanish ones above all - ask for the street type,
 * the street name and the house number apart, and people have more than one
 * address to be reached at. Both are kept the way `identity-person.ts` keeps
 * its details: custom fields with agreed names. `address1`, the email and the
 * phone stay what another Bitwarden client reads: the street line composed from
 * the parts, the primary email and the primary phone.
 */

import { withChangedField } from "./vault-items.js";

export const ADDRESS_KEYS = ["streetType", "streetName", "houseNumber", "floor", "door"] as const;
export type AddressKey = (typeof ADDRESS_KEYS)[number];
export type AddressParts = Record<AddressKey, string>;

/** The custom field each part lives in. */
export const ADDRESS_FIELDS: Readonly<Record<AddressKey, string>> = {
    streetType: "Street type",
    streetName: "Street name",
    houseNumber: "House number",
    floor: "Floor",
    door: "Door"
};

/**
 * The street types offered for a country, as they are written there.
 *
 * Sources: Spain - the street types of the INE "Callejero del Censo Electoral"
 * (its tipos de via file); United States - USPS Publication 28, Appendix C1
 * (street suffixes, with their standard abbreviations); the others - the common
 * types of each country only, not a complete list. Free text is always allowed,
 * so a type missing here can still be typed.
 */
const STREET_TYPES: Readonly<Record<string, readonly string[]>> = {
    ES: [
        "Calle",
        "Avenida",
        "Camino",
        "Carretera",
        "Plaza",
        "Paseo",
        "Ronda",
        "Travesía",
        "Urbanización",
        "Caserío",
        "Barrio",
        "Polígono",
        "Glorieta",
        "Pasaje",
        "Callejón"
    ],
    US: ["St", "Ave", "Blvd", "Rd", "Dr", "Ln", "Ct", "Pl", "Way", "Pkwy", "Hwy", "Cir", "Ter", "Trl"],
    GB: ["Road", "Street", "Lane", "Avenue", "Close", "Drive", "Way", "Crescent", "Place", "Square", "Gardens", "Terrace"],
    FR: ["Rue", "Avenue", "Boulevard", "Chemin", "Impasse", "Place", "Allée", "Quai", "Route", "Cours"],
    DE: ["Straße", "Weg", "Platz", "Allee", "Gasse", "Ring", "Damm"],
    IT: ["Via", "Viale", "Piazza", "Corso", "Vicolo", "Largo", "Strada"],
    PT: ["Rua", "Avenida", "Travessa", "Largo", "Praça", "Estrada", "Alameda"]
};

/** Countries written like another one's list. */
const SAME_AS: Readonly<Record<string, string>> = { AT: "DE", BR: "PT", IE: "GB" };

/** The English words a country with no list of its own is offered. */
const GENERIC_TYPES = ["Street", "Road", "Avenue", "Lane", "Boulevard", "Drive", "Square"] as const;

function listKey(country: string): string | null {
    const code = country.trim().toUpperCase();
    const key = SAME_AS[code] ?? code;
    return STREET_TYPES[key] ? key : null;
}

/** The street types to offer for an address in `country` (a two-letter code). */
export function streetTypesFor(country: string): readonly string[] {
    const key = listKey(country);
    return key ? (STREET_TYPES[key] ?? GENERIC_TYPES) : GENERIC_TYPES;
}

/** How a street line is written: where the number goes and where the type. */
type StreetOrder = "typeNameNumber" | "numberNameType" | "numberTypeName" | "german";

function orderOf(country: string): StreetOrder {
    const key = listKey(country);
    if (key === "US" || key === "GB") return "numberNameType";
    if (key === "FR") return "numberTypeName";
    if (key === "DE") return "german";
    if (key === null) return "numberNameType";
    return "typeNameNumber";
}

const join = (...parts: readonly string[]): string =>
    parts.map((part) => part.trim()).filter(Boolean).join(" ");

/**
 * A German street name with its type: one word joined ("Hauptstraße"), several
 * hyphenated ("Albert-Schweitzer-Straße"), and a name ending in "-er" - a place
 * made an adjective, "Berliner" - written apart ("Berliner Straße"), as German
 * spelling writes street names. A name that already ends in the type is kept.
 */
function germanStreet(name: string, type: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const kind = type.trim();
    if (kind === "") return words.join(" ");
    if (words.length === 0) return kind;
    const whole = words.join(" ");
    if (whole.toLowerCase().endsWith(kind.toLowerCase())) return whole;
    if (words.length > 1) return `${words.join("-")}-${kind}`;
    if (/er$/i.test(whole)) return `${whole} ${kind}`;
    return `${whole}${kind.toLowerCase()}`;
}

/** The street line written the way `country` writes it: "Calle Mayor 6",
 *  "6 Main St", "6 rue de la Paix", "Hauptstraße 6". */
export function composeStreet(parts: Pick<AddressParts, "streetType" | "streetName" | "houseNumber">, country: string): string {
    const { streetType: type, streetName: name, houseNumber: number } = parts;
    switch (orderOf(country)) {
        case "numberNameType":
            return join(number, name, type);
        case "numberTypeName":
            return join(number, type.trim().toLowerCase(), name);
        case "german":
            return join(germanStreet(name, type), number);
        default:
            return join(type, name, number);
    }
}

/** The floor and door as one line: "2º B" where the floor is a number in
 *  Spain, the two side by side anywhere else. */
export function composeFloorDoor(parts: Pick<AddressParts, "floor" | "door">, country: string): string {
    const floor = parts.floor.trim();
    const spanish = listKey(country) === "ES" && /^\d+$/.test(floor);
    return join(spanish ? `${floor}º` : floor, parts.door);
}

const fold = (text: string): string =>
    text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();

/**
 * An old one-line street read into its parts, or null when it cannot be read
 * with certainty. Only where the country writes the type first: the line must
 * start with one of its known types and end in a number - "6", "N6", "nº 6",
 * "num. 6", after an optional comma. Nothing is stored from this until saved.
 */
export function parseStreet(line: string, country: string): AddressParts | null {
    if (orderOf(country) !== "typeNameNumber") return null;
    const text = line.trim();
    const number = /^(.*?)[,\s]+(?:(?:n|nº|n°|no|num|núm|numero|número)\.?\s*)?(\d+[a-z]?)$/i.exec(text);
    if (!number) return null;
    const rest = number[1]?.trim() ?? "";
    const type = streetTypesFor(country)
        .filter((one) => fold(rest).startsWith(`${fold(one)} `))
        .sort((a, b) => b.length - a.length)[0];
    if (!type) return null;
    const name = rest.slice(type.length).trim();
    if (name === "") return null;
    return { streetType: type, streetName: name, houseNumber: number[2] ?? "", floor: "", door: "" };
}

/** The parts read off an item's custom fields; empty where it has none. */
export function readAddress(fields: readonly { name: string; value: string }[]): AddressParts {
    const out = {} as AddressParts;
    for (const key of ADDRESS_KEYS) {
        out[key] = fields.find((field) => field.name === ADDRESS_FIELDS[key])?.value.trim() ?? "";
    }
    return out;
}

/**
 * The parts an identity's street is shown and filled with. The stored parts
 * while they still compose to its street line; otherwise - parts never stored,
 * or the line changed since by a client that does not know them - the line
 * read again: into parts where `parseStreet` is certain, else whole as the
 * street name, so composing it gives the same line back.
 */
export function streetParts(stored: AddressParts, address1: string, country: string): AddressParts {
    const line = address1.trim();
    const kept = stored.streetType || stored.streetName || stored.houseNumber;
    if (kept && composeStreet(stored, country) === line) return stored;
    if (line === "") return kept ? { ...stored, streetType: "", streetName: "", houseNumber: "" } : stored;
    const parsed = parseStreet(line, country);
    const street = parsed ?? { streetType: "", streetName: line, houseNumber: "" };
    return { ...stored, streetType: street.streetType, streetName: street.streetName, houseNumber: street.houseNumber };
}

/** Each part trimmed. */
export function normalizeAddress(parts: Partial<AddressParts>): AddressParts {
    const out = {} as AddressParts;
    for (const key of ADDRESS_KEYS) out[key] = (parts[key] ?? "").trim().replace(/\s+/g, " ");
    return out;
}

/** The fields with the parts written in, each only where it changed. */
export function writeAddress<T extends { name: string; value: string; type: number }>(
    fields: readonly T[],
    parts: AddressParts
): T[] {
    const FIELD_TEXT = 0;
    let next = [...fields];
    for (const key of ADDRESS_KEYS) next = withChangedField(next, ADDRESS_FIELDS[key], parts[key], FIELD_TEXT);
    return next;
}

/** How many extra emails, and extra phones, an identity keeps. */
export const MAX_EXTRA_CONTACTS = 9;

/** The custom field the `n`th email or phone lives in, counting the primary
 *  (Bitwarden's own field) as the first: "Email 2", "Phone 3". */
export function contactField(kind: "email" | "phone", n: number): string {
    return `${kind === "email" ? "Email" : "Phone"} ${n}`;
}

/** Whether a custom field is one of the extra emails or phones. */
export function isContactField(name: string): boolean {
    return /^(?:Email|Phone) (?:[2-9]|10)$/.test(name);
}

export interface ExtraContacts {
    readonly emails: readonly string[];
    readonly phones: readonly string[];
}

/** An email as it is stored: trimmed, lowercase. */
export function normalizeContactEmail(value: string): string {
    return value.trim().toLowerCase();
}

/** A phone as it is stored: trimmed, inner runs of space made one. */
export function normalizeContactPhone(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

/** Whether a stored phone has the shape of one: digits, an optional leading
 *  `+`, and the spaces, dots, dashes and brackets numbers are written with. */
export function looksLikePhone(value: string): boolean {
    const text = value.trim();
    return /^\+?[\d\s().-]+$/.test(text) && (text.match(/\d/g)?.length ?? 0) >= 3;
}

/** The extra emails and phones read off an item's custom fields, in order. */
export function readContacts(fields: readonly { name: string; value: string }[]): ExtraContacts {
    const read = (kind: "email" | "phone"): string[] => {
        const out: string[] = [];
        for (let n = 2; n <= MAX_EXTRA_CONTACTS + 1; n++) {
            const value = fields.find((field) => field.name === contactField(kind, n))?.value.trim() ?? "";
            if (value) out.push(value);
        }
        return out;
    };
    return { emails: read("email"), phones: read("phone") };
}

/** The fields with the extras written in, numbered from 2 with no gaps, each
 *  only where it changed; a slot no longer used is removed. */
export function writeContacts<T extends { name: string; value: string; type: number }>(
    fields: readonly T[],
    extras: ExtraContacts
): T[] {
    const FIELD_TEXT = 0;
    let next = [...fields];
    for (const kind of ["email", "phone"] as const) {
        const list = (kind === "email" ? extras.emails : extras.phones).filter((one) => one.trim() !== "");
        for (let n = 2; n <= MAX_EXTRA_CONTACTS + 1; n++) {
            next = withChangedField(next, contactField(kind, n), list[n - 2] ?? "", FIELD_TEXT);
        }
    }
    return next;
}
