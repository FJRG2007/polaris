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
import type { NamespaceKey } from "@/lib/i18n/types";

export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** The four questions, by id; each is headed `vault.identity.groups.<id>`. */
export const IDENTITY_GROUPS: readonly {
    id: "name" | "contact" | "address" | "numbers";
    fields: readonly { field: IdentityField; span?: "full" }[];
}[] = [
    {
        id: "name",
        fields: [
            { field: "title" },
            { field: "firstName" },
            { field: "middleName" },
            { field: "lastName" },
            { field: "company", span: "full" }
        ]
    },
    {
        id: "contact",
        fields: [{ field: "email" }, { field: "phone" }, { field: "username" }]
    },
    {
        id: "address",
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
        id: "numbers",
        fields: [{ field: "ssn" }, { field: "passportNumber" }, { field: "licenseNumber" }]
    }
];

/** What a field is called on screen: `vault.identity.fields.<field>`. `Address 1`
 *  is what the field is called and not what anybody would write on an envelope,
 *  so the catalog names each one rather than deriving it from the key. */
export function identityLabelKey(field: IdentityField): NamespaceKey<"vault"> {
    return `identity.fields.${field}`;
}

/** A hint only where the field's own name does not say what goes in it. */
const HINTED: Partial<Record<IdentityField, NamespaceKey<"vault">>> = {
    title: "identity.hints.title",
    address2: "identity.hints.address2"
};

export function identityHintKey(field: IdentityField): NamespaceKey<"vault"> | undefined {
    return HINTED[field];
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
