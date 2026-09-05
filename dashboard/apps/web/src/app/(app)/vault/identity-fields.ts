/**
 * The identity, in the groups it is actually made of.
 *
 * Seventeen fields two abreast is a wall, and it puts "Address 2" beside
 * "Passport number" as though they were the same kind of question. These are
 * four questions - who they are, how to reach them, where they live, and the
 * numbers a government gave them - and the address gets the shape an address has
 * rather than a share of the grid.
 *
 * Shared between the editor and the detail view on purpose. An identity that is
 * filled in under four headings and then read back as a flat list of seventeen
 * rows is the same wall, one screen later.
 */

import { IDENTITY_FIELDS } from "./vault-model";

export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export const IDENTITY_GROUPS: readonly {
    title: string;
    fields: readonly { field: IdentityField; span?: "full" }[];
}[] = [
    {
        title: "Name",
        fields: [
            { field: "title" },
            { field: "firstName" },
            { field: "middleName" },
            { field: "lastName" },
            { field: "company", span: "full" }
        ]
    },
    {
        title: "Getting hold of them",
        fields: [{ field: "email" }, { field: "phone" }, { field: "username" }]
    },
    {
        title: "Address",
        fields: [
            { field: "address1", span: "full" },
            { field: "address2", span: "full" },
            { field: "city" },
            { field: "state" },
            { field: "postalCode" },
            { field: "country" }
        ]
    },
    {
        title: "Numbers they were given",
        fields: [{ field: "ssn" }, { field: "passportNumber" }, { field: "licenseNumber" }]
    }
];

/** Where the derived label reads badly. `Address 1` is what the field is called
 *  and not what anybody would write on an envelope. */
export const IDENTITY_LABELS: Partial<Record<IdentityField, string>> = {
    address1: "Street",
    address2: "Flat, suite, building",
    state: "County or state",
    postalCode: "Postcode",
    ssn: "National insurance or social security number",
    licenseNumber: "Driving licence number",
    username: "Username on file"
};

/** A hint only where the field's own name does not say what goes in it. */
export const IDENTITY_HINTS: Partial<Record<IdentityField, string>> = {
    title: "Mr, Ms, Dr",
    address2: "Optional"
};

/** Turn a field key like `postalCode` into "Postal code". */
export function humanize(field: string): string {
    const spaced = field
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** What a field is called on screen. */
export function identityLabel(field: IdentityField): string {
    return IDENTITY_LABELS[field] ?? humanize(field);
}

/**
 * The address as it would be written down, from the fields that are filled in.
 *
 * Read as one block rather than as six rows, which is how an address is read
 * everywhere else - and it is the difference between a record somebody can copy
 * into a form and a table they have to reassemble in their head.
 */
export function addressLines(identity: Record<string, string>): string[] {
    const town = [identity.postalCode, identity.city].filter(Boolean).join(" ");
    return [
        identity.address1 ?? "",
        identity.address2 ?? "",
        town,
        identity.state ?? "",
        identity.country ?? ""
    ]
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
