/**
 * Handing one saved item to somebody who does not have a vault.
 *
 * The thing being shared is text, and that is deliberate rather than a
 * shortcoming. A Send is opened by a stranger in a browser with no vault, no
 * account and no client - so whatever arrives has to be readable as it stands,
 * and a structured payload would only be a structure nothing on the other end
 * knows how to read.
 *
 * What goes into that text is chosen a part at a time, because "share this
 * login" almost never means "share everything about this login". The default is
 * the smallest thing that is any use - who you are and the password - and every
 * other part is an explicit decision, which is the shape this needs: a share is
 * a copy nobody can take back, and the moment to think about that is while it is
 * being made.
 *
 * The authenticator key is the one that carries a warning of its own. Sending it
 * does not share a code, it shares the ability to make every future code, which
 * is the whole of the second factor - so it is off, it says what it is, and it
 * has to be turned on by somebody who means it.
 */

import * as core from "@polaris/core";
import type { VaultItem } from "./vault-model";

/** A part of an item that can travel on its own. */
export type SharedPart =
    | "username"
    | "password"
    | "totp"
    | "recovery"
    | "uris"
    | "card"
    | "identity"
    | "sshKey"
    | "fields"
    | "notes";

/** How each part is named on the form, and what it is worth saying about it. */
export const PART_LABELS: Record<SharedPart, string> = {
    username: "Username or email",
    password: "Password",
    totp: "Authenticator key",
    recovery: "Recovery codes",
    uris: "Websites",
    card: "Card details",
    identity: "Identity",
    sshKey: "Private key",
    fields: "Custom fields",
    notes: "Notes"
};

/** Said beside the parts where the consequence is not obvious from the name. */
export const PART_WARNINGS: Partial<Record<SharedPart, string>> = {
    totp: "This is not a code - it is what makes every future code. Sending it hands over the second factor.",
    recovery: "Each of these gets past the second factor once.",
    sshKey: "The private half. Whoever has it can sign as this key."
};

/** The parts turned on unless somebody says otherwise: the smallest set that is
 *  any use to the person receiving it. */
const BY_DEFAULT: readonly SharedPart[] = ["username", "password", "uris"];

/** Which parts this item actually has, in the order they read. */
export function shareableParts(item: VaultItem): SharedPart[] {
    const has: [SharedPart, boolean][] = [
        ["username", Boolean(item.login.username)],
        ["password", Boolean(item.login.password)],
        ["totp", Boolean(item.login.totp)],
        ["recovery", Boolean(core.fieldValue(item.fields, core.RECOVERY_CODES_FIELD))],
        ["uris", item.login.uris.length > 0],
        ["card", Boolean(item.card.number || item.card.cardholderName)],
        ["identity", Object.values(item.identity).some(Boolean)],
        ["sshKey", Boolean(item.sshKey.privateKey || item.sshKey.publicKey)],
        [
            "fields",
            item.fields.some(
                (field) =>
                    field.name &&
                    field.name !== core.RECOVERY_CODES_FIELD &&
                    field.name !== core.ICON_FIELD
            )
        ],
        ["notes", Boolean(item.notes)]
    ];
    return has.filter(([, present]) => present).map(([part]) => part);
}

/** The parts a fresh share starts with: the safe ones this item happens to have. */
export function defaultParts(item: VaultItem): SharedPart[] {
    const available = new Set(shareableParts(item));
    return BY_DEFAULT.filter((part) => available.has(part));
}

/**
 * The item written out, with only the parts that were chosen.
 *
 * Plain lines with a label in front of each, which is what somebody can read on
 * a phone and paste into a form. Nothing is included that was not asked for, and
 * a part with nothing in it prints nothing rather than an empty heading.
 */
export function shareText(item: VaultItem, parts: ReadonlySet<SharedPart>): string {
    const lines: string[] = [];
    const add = (label: string, value: string) => {
        if (value.trim()) lines.push(`${label}: ${value.trim()}`);
    };

    if (parts.has("username")) add("Username", item.login.username);
    if (parts.has("password")) add("Password", item.login.password);
    if (parts.has("totp")) add("Authenticator key", item.login.totp);
    if (parts.has("recovery")) {
        // The mark that says which are spent is a Polaris convention, so it comes
        // off on the way out - the person receiving these has no vault to read it
        // in, and a leading dash would look like part of the code.
        const codes = core
            .readRecoveryCodes(core.fieldValue(item.fields, core.RECOVERY_CODES_FIELD))
            .map((code) => (code.startsWith("-") ? code.slice(1) : code));
        if (codes.length > 0) lines.push(`Recovery codes:\n${codes.join("\n")}`);
    }
    if (parts.has("uris")) {
        for (const entry of item.login.uris) add("Website", core.withoutWildcard(entry.uri));
    }
    if (parts.has("card")) {
        add("Cardholder", item.card.cardholderName);
        add("Card number", item.card.number);
        add(
            "Expires",
            core.writeCardExpiry({ month: item.card.expMonth, year: item.card.expYear })
        );
        add("Security code", item.card.code);
    }
    if (parts.has("identity")) {
        for (const [field, value] of Object.entries(item.identity)) {
            add(humanField(field), value);
        }
    }
    if (parts.has("sshKey")) {
        add("Public key", item.sshKey.publicKey);
        if (item.sshKey.privateKey) lines.push(`Private key:\n${item.sshKey.privateKey.trim()}`);
    }
    if (parts.has("fields")) {
        for (const field of item.fields) {
            if (!field.name || field.name === core.RECOVERY_CODES_FIELD) continue;
            if (field.name === core.ICON_FIELD) continue;
            add(field.name, field.value);
        }
    }
    if (parts.has("notes") && item.notes.trim()) lines.push(`Notes:\n${item.notes.trim()}`);

    return lines.join("\n");
}

/** `postalCode` as "Postal code". Kept here rather than shared with the editor
 *  because this is prose in a text file, not a form label. */
function humanField(field: string): string {
    const spaced = field
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
