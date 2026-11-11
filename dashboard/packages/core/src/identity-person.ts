/**
 * The parts of a person an identity carries beyond the names Bitwarden gave.
 *
 * Forms ask for an identity document, a date and country of birth, a
 * nationality and a marital status far more often than for a passport number,
 * and the cipher model has a box for none of them. They are kept the way the
 * other conventions in `vault-items.ts` are: custom fields with agreed names,
 * which a Bitwarden client shows as fields and Polaris draws as boxes of their
 * own. Values are stored in one shape whatever language the screen is in - a
 * date as `YYYY-MM-DD`, a country as its two-letter code, a status as one of
 * `MARITAL_STATUSES` - so a form in any language can be filled from them.
 */

import { withChangedField } from "./vault-items.js";

export const PERSON_KEYS = ["nationalId", "birthDate", "birthCountry", "nationality", "maritalStatus"] as const;
export type PersonKey = (typeof PERSON_KEYS)[number];
export type PersonValues = Record<PersonKey, string>;

/** The custom field each part lives in. Words, not codes: they are what an
 *  export or another client shows. */
export const PERSON_FIELDS: Readonly<Record<PersonKey, string>> = {
    nationalId: "National ID",
    birthDate: "Date of birth",
    birthCountry: "Country of birth",
    nationality: "Nationality",
    maritalStatus: "Marital status"
};

export const MARITAL_STATUSES = ["single", "married", "partnership", "divorced", "separated", "widowed"] as const;
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];

/** What a form's option for each status tends to say, in the languages forms
 *  are most often written in. Tried in this order, so "separado" is never read
 *  as part of anything else. */
const MARITAL_WORDS: readonly (readonly [MaritalStatus, RegExp])[] = [
    ["partnership", /pareja de hecho|uni[oó]n (?:de hecho|libre|civil)|civil partner|domestic partner|registered partner|partenariat|\bpacs?\b|lebenspartner|convivente|uni[aã]o est[aá]vel/i],
    ["separated", /separad|separated|s[eé]par[eé]|getrennt/i],
    ["divorced", /divorc|geschieden/i],
    ["widowed", /viud|widow|veuf|veuve|verwitwet|vedov|vi[uú]v/i],
    ["married", /casad|married|mari[eé]|verheiratet|sposat|coniugat/i],
    ["single", /solter|single|unmarried|never married|c[eé]libataire|ledig|nubile|celibe|nunca casad/i]
];

/** The status an option's text names, or null. */
export function maritalStatusOf(text: string): MaritalStatus | null {
    for (const [status, words] of MARITAL_WORDS) if (words.test(text)) return status;
    return null;
}

/** A stored date as its parts, or null when it is not a real `YYYY-MM-DD`. */
export function dateParts(value: string): { year: number; month: number; day: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day };
}

/** Normalise each part to the one shape it is stored in: trimmed, a document
 *  number without spaces and in capitals, a country code in capitals, a date
 *  that is not a real day dropped. */
export function normalizePerson(values: Partial<PersonValues>): PersonValues {
    const text = (key: PersonKey) => (values[key] ?? "").trim();
    const code = (key: PersonKey) => {
        const value = text(key).toUpperCase();
        return /^[A-Z]{2}$/.test(value) ? value : "";
    };
    const status = text("maritalStatus");
    return {
        nationalId: text("nationalId").replace(/[\s.]/g, "").toUpperCase(),
        birthDate: dateParts(text("birthDate")) ? text("birthDate") : "",
        birthCountry: code("birthCountry"),
        nationality: code("nationality"),
        maritalStatus: (MARITAL_STATUSES as readonly string[]).includes(status) ? status : ""
    };
}

/** The parts read off an item's custom fields; empty where it has none. */
export function readPerson(fields: readonly { name: string; value: string }[]): PersonValues {
    const out = {} as PersonValues;
    for (const key of PERSON_KEYS) {
        out[key] = fields.find((field) => field.name === PERSON_FIELDS[key])?.value.trim() ?? "";
    }
    return out;
}

/** The fields with the parts written in, each only where it changed, so an
 *  identity opened and saved again keeps its field list as it was. */
export function writePerson<T extends { name: string; value: string; type: number }>(
    fields: readonly T[],
    values: PersonValues
): T[] {
    const FIELD_TEXT = 0;
    let next = [...fields];
    for (const key of PERSON_KEYS) next = withChangedField(next, PERSON_FIELDS[key], values[key], FIELD_TEXT);
    return next;
}
