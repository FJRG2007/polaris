/**
 * The identities a sign-up form is filled with.
 *
 * A vault identity (Bitwarden's type 4) is somebody's name, addresses, phone
 * and the rest, kept like any other item. Each vault can mark one as the
 * default for the person reading it, and the sign-up menu offers the open
 * shelf's default first and the others after it. When the shelf holds none, the
 * account this extension is signed in as stands in, with what it knows: a name
 * and an email.
 *
 * Pure, and apart from the worker, so the order and the fallback can be checked
 * without a browser.
 */

import { PERSON_KEYS } from "@polaris/core/identity-person";
import { onShelf, type ShelfOrganization } from "@/lib/shelf";
import { autocompleteToken, type PageFields, type ProfilePart } from "@/lib/fields";
import {
    ACCOUNT_IDENTITY,
    type ExtensionAccount,
    type IdentityCard,
    type IdentityPreview,
    type IdentityValues
} from "@/lib/messages";

/** The identity's fields, in the order the vault stores and draws them. */
export const IDENTITY_KEYS = [
    "title",
    "firstName",
    "middleName",
    "lastName",
    "company",
    "email",
    "phone",
    "username",
    "address1",
    "address2",
    "city",
    "state",
    "postalCode",
    "country"
] as const satisfies readonly (keyof IdentityValues)[];

/** One identity the worker has opened. */
export interface OpenIdentity {
    readonly id: string;
    readonly name: string;
    readonly organizationId: string | null;
    readonly isDefault: boolean;
    readonly values: IdentityValues;
}

/** Every field empty, to start from. */
export function blankIdentity(): Record<keyof IdentityValues, string> {
    return Object.fromEntries(
        [...IDENTITY_KEYS, ...PERSON_KEYS].map((key) => [key, ""])
    ) as Record<keyof IdentityValues, string>;
}

/** The whole name an identity carries, in the order it is written. */
export function wholeName(values: IdentityValues): string {
    return [values.firstName, values.middleName, values.lastName]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" ");
}

/**
 * The identities the open shelf shows, best first: the defaults, the
 * account's own vault's before any other, then the rest by name.
 */
export function shelfIdentities(
    found: readonly OpenIdentity[],
    shelf: string | null,
    organizations: readonly ShelfOrganization[]
): OpenIdentity[] {
    const rank = (one: OpenIdentity): number =>
        one.isDefault ? (one.organizationId === null ? 0 : 1) : 2;
    return found
        .filter((one) => onShelf(one.organizationId, shelf, organizations))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** One identity as the menu draws it. */
export function cardOf(one: OpenIdentity, vaults: ReadonlyMap<string, string>): IdentityCard {
    return {
        id: one.id,
        name: one.name,
        detail: one.values.email || wholeName(one.values),
        isDefault: one.isDefault,
        vault: one.organizationId === null ? null : (vaults.get(one.organizationId) ?? null),
        preview: previewOf(one.values)
    };
}

/**
 * The signed-in account as an identity, for a shelf that holds none. Null when
 * the account has told this extension nothing to fill with.
 */
export function accountIdentity(account: ExtensionAccount | null): IdentityValues | null {
    const name = account?.name?.trim() ?? "";
    const email = account?.email?.trim() ?? "";
    if (name === "" && email === "") return null;
    const [given = "", ...rest] = name.split(/\s+/);
    return { ...blankIdentity(), firstName: given, lastName: rest.join(" "), email };
}

/** The card for the account's own identity. */
export function accountCard(values: IdentityValues, label: string): IdentityCard {
    return {
        id: ACCOUNT_IDENTITY,
        name: label,
        detail: values.email || wholeName(values),
        isDefault: false,
        vault: null,
        preview: previewOf(values)
    };
}

/**
 * The country as a box wants it. The vault keeps a country as its two-letter
 * code (`ES`): a box marked `autocomplete="country"` asks for that code, and any
 * other asks for the name, written in the page's language. Text that is not a
 * code the runtime can name goes in as it was stored.
 */
export function countryForBox(stored: string, autocomplete: string, locale: string): string {
    const value = stored.trim();
    const code = value.toUpperCase();
    if (
        !/^[A-Z]{2}$/.test(code) ||
        code === "ZZ" ||
        autocompleteToken(autocomplete) === "country"
    ) {
        return stored;
    }
    for (const one of [locale, "en"]) {
        try {
            const name = new Intl.DisplayNames([one], { type: "region", fallback: "none" }).of(
                code
            );
            if (name) return name;
        } catch {
            // A locale this runtime cannot name countries in.
        }
    }
    return stored;
}

/** The few values of an identity a menu row can lead with: never more than a
 *  sign-up box could show anyway. */
export function previewOf(values: IdentityValues): IdentityPreview {
    return {
        email: values.email.trim(),
        phone: values.phone.trim(),
        address: [values.address1, values.city]
            .map((part) => part.trim())
            .filter(Boolean)
            .join(", "),
        name: wholeName(values)
    };
}

/** Words of a Spanish surname that belong to the word after them: "de la
 *  Fuente" is one surname, not three. */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "san"]);

/**
 * A family name split into the two surnames a Spanish form asks for apart.
 *
 * Split on spaces, each particle kept with the word after it, the first
 * surname being the first of what is left and the second the rest: "Romero
 * González" is "Romero" and "González", "de la Fuente García" is "de la
 * Fuente" and "García". A family name of one word is the first surname whole.
 */
export function splitSurnames(lastName: string): readonly [string, string] {
    const groups: string[] = [];
    let held: string[] = [];
    for (const word of lastName.trim().split(/\s+/).filter(Boolean)) {
        held.push(word);
        if (PARTICLES.has(word.toLowerCase())) continue;
        groups.push(held.join(" "));
        held = [];
    }
    // Particles with nothing after them stay with the surname before them.
    if (held.length > 0) {
        const last = groups.pop();
        groups.push([last, ...held].filter(Boolean).join(" "));
    }
    const [first = "", ...rest] = groups;
    return [first, rest.join(" ")];
}

/** Every box an identity can be typed into, by what it asks for. `login` is
 *  the username box of the form, which asks for whatever `usernameAsks` says. */
export type FillSlot =
    | "login"
    | "fullName"
    | "givenName"
    | "middleName"
    | "familyName"
    | "firstSurname"
    | "secondSurname"
    | ProfilePart;

/** The parts of a name, replaced together. */
export const NAME_SLOTS = [
    "fullName",
    "givenName",
    "middleName",
    "familyName",
    "firstSurname",
    "secondSurname"
] as const satisfies readonly FillSlot[];

/** The parts of an address, replaced together. */
export const ADDRESS_SLOTS = [
    "address1",
    "address2",
    "city",
    "state",
    "postalCode",
    "country"
] as const satisfies readonly FillSlot[];

/**
 * The boxes a pick replaces even where they already hold something, given the
 * box the menu was opened on. That box always; and the whole of its name or
 * address with it, so choosing a second address does not leave the street of
 * one and the city of the other. A contact box - email, phone, username,
 * company - is replaced alone.
 */
export function replacedSlots(opened: FillSlot | null): ReadonlySet<FillSlot> {
    if (opened === null) return new Set();
    for (const group of [NAME_SLOTS, ADDRESS_SLOTS] as readonly (readonly FillSlot[])[]) {
        if (group.includes(opened)) return new Set(group);
    }
    return new Set([opened]);
}

/** What an identity types into one box. The country as stored: a text box
 *  gets it in the page's language at fill time. */
export function slotValue(
    values: IdentityValues,
    slot: FillSlot,
    asks: PageFields["usernameAsks"]
): string {
    switch (slot) {
        case "login":
            // A box that says nothing is, on a sign-up, most often an email.
            return asks === "phone"
                ? values.phone
                : asks === "username"
                  ? values.username || values.email
                  : values.email || values.username;
        case "fullName":
            return wholeName(values);
        case "givenName":
            return values.firstName;
        case "middleName":
            return values.middleName;
        case "familyName":
            return values.lastName;
        case "firstSurname":
            return splitSurnames(values.lastName)[0];
        case "secondSurname":
            return splitSurnames(values.lastName)[1];
        default:
            return values[slot];
    }
}

/** Which preview value a menu opened on this box leads each row with, or null
 *  for a box no preview covers. */
export function previewKey(
    slot: FillSlot | null,
    asks: PageFields["usernameAsks"]
): keyof IdentityPreview | null {
    if (slot === null) return null;
    if (slot === "login") return asks === "phone" ? "phone" : asks === "username" ? null : "email";
    if (slot === "email" || slot === "phone") return slot;
    if ((ADDRESS_SLOTS as readonly FillSlot[]).includes(slot)) return "address";
    if ((NAME_SLOTS as readonly FillSlot[]).includes(slot)) return "name";
    return null;
}

/** One identity row of the menu. */
export interface IdentityRow {
    readonly card: IdentityCard;
    /** The main line: the value for the box, or the identity's name. */
    readonly label: string;
    /** The line under it. */
    readonly detail: string;
}

/**
 * The identity rows for a menu opened on one box, the way a browser offers its
 * saved addresses: each row leads with what that identity would type into the
 * box, and says under it which identity that is. Identities that would type the
 * same thing are one row - the first, which is the best ranked. An identity with
 * nothing for the box is drawn as before, by its name and its usual detail.
 */
export function identityRows(
    cards: readonly IdentityCard[],
    key: keyof IdentityPreview | null,
    defaultLabel: string
): IdentityRow[] {
    const seen = new Set<string>();
    const rows: IdentityRow[] = [];
    for (const card of cards) {
        const where = card.isDefault ? defaultLabel : card.vault;
        const value = key === null ? "" : (card.preview?.[key] ?? "").trim();
        if (value === "") {
            rows.push({
                card,
                label: card.name,
                detail: [card.detail, where].filter(Boolean).join(" - ")
            });
            continue;
        }
        const same = value.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(same)) continue;
        seen.add(same);
        rows.push({ card, label: value, detail: [card.name, where].filter(Boolean).join(" - ") });
    }
    return rows;
}
