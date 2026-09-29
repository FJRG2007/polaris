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

/** The parts where the consequence is not obvious from the name, and a warning is
 *  said beside them on the form (`vault.share.warnings.<part>`). Each part's name
 *  is `vault.share.parts.<part>`. */
export const WARNED_PARTS: ReadonlySet<SharedPart> = new Set<SharedPart>(["totp", "recovery", "sshKey"]);

/** The labels the shared text is written with. The form hands in the sender's
 *  language; the English ones are the default for anything with no reader. */
export interface ShareTextLabels {
    username: string;
    password: string;
    totp: string;
    recovery: string;
    website: string;
    cardholder: string;
    cardNumber: string;
    expires: string;
    securityCode: string;
    publicKey: string;
    privateKey: string;
    notes: string;
    identityField: (field: string) => string;
}

const ENGLISH_LABELS: ShareTextLabels = {
    username: "Username",
    password: "Password",
    totp: "Authenticator key",
    recovery: "Recovery codes",
    website: "Website",
    cardholder: "Cardholder",
    cardNumber: "Card number",
    expires: "Expires",
    securityCode: "Security code",
    publicKey: "Public key",
    privateKey: "Private key",
    notes: "Notes",
    identityField: humanField
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
export function shareText(
    item: VaultItem,
    parts: ReadonlySet<SharedPart>,
    labels: ShareTextLabels = ENGLISH_LABELS
): string {
    const lines: string[] = [];
    const add = (label: string, value: string) => {
        if (value.trim()) lines.push(`${label}: ${value.trim()}`);
    };

    if (parts.has("username")) add(labels.username, item.login.username);
    if (parts.has("password")) add(labels.password, item.login.password);
    if (parts.has("totp")) add(labels.totp, item.login.totp);
    if (parts.has("recovery")) {
        // The mark that says which are spent is a Polaris convention, so it comes
        // off on the way out - the person receiving these has no vault to read it
        // in, and a leading dash would look like part of the code.
        const codes = core
            .readRecoveryCodes(core.fieldValue(item.fields, core.RECOVERY_CODES_FIELD))
            .map((code) => (code.startsWith("-") ? code.slice(1) : code));
        if (codes.length > 0) lines.push(`${labels.recovery}:\n${codes.join("\n")}`);
    }
    if (parts.has("uris")) {
        for (const entry of item.login.uris) add(labels.website, core.withoutWildcard(entry.uri));
    }
    if (parts.has("card")) {
        add(labels.cardholder, item.card.cardholderName);
        add(labels.cardNumber, item.card.number);
        add(
            labels.expires,
            core.writeCardExpiry({ month: item.card.expMonth, year: item.card.expYear })
        );
        add(labels.securityCode, item.card.code);
    }
    if (parts.has("identity")) {
        for (const [field, value] of Object.entries(item.identity)) {
            add(labels.identityField(field), value);
        }
    }
    if (parts.has("sshKey")) {
        add(labels.publicKey, item.sshKey.publicKey);
        if (item.sshKey.privateKey) lines.push(`${labels.privateKey}:\n${item.sshKey.privateKey.trim()}`);
    }
    if (parts.has("fields")) {
        for (const field of item.fields) {
            if (!field.name || field.name === core.RECOVERY_CODES_FIELD) continue;
            if (field.name === core.ICON_FIELD) continue;
            add(field.name, field.value);
        }
    }
    if (parts.has("notes") && item.notes.trim()) lines.push(`${labels.notes}:\n${item.notes.trim()}`);

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
