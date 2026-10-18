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

import { onShelf, type ShelfOrganization } from "@/lib/shelf";
import {
    ACCOUNT_IDENTITY,
    type ExtensionAccount,
    type IdentityCard,
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
    return Object.fromEntries(IDENTITY_KEYS.map((key) => [key, ""])) as Record<
        keyof IdentityValues,
        string
    >;
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
        vault: one.organizationId === null ? null : (vaults.get(one.organizationId) ?? null)
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
        vault: null
    };
}
