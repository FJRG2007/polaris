"use client";

/**
 * Turning what the server holds into something a screen can draw, and back.
 *
 * Everything the server stores is a bag of encrypted strings; everything the
 * screens work with is a plain object. This module is the only place those two
 * meet, which is deliberate - a component that decrypted a field itself would be
 * a component that could forget to encrypt it again on the way out.
 *
 * A value that will not decrypt comes back as an empty string rather than
 * throwing. One corrupt field should cost that field, not the whole vault.
 */

import * as core from "@polaris/core";
import * as crypto from "@/lib/vault/crypto";

/** One item, open. */
export interface VaultItem {
    id: string;
    type: number;
    name: string;
    notes: string;
    favorite: boolean;
    folderId: string | null;
    organizationId: string | null;
    deleted: boolean;
    revisionDate: string;
    login: { username: string; password: string; totp: string; uris: string[] };
    card: {
        cardholderName: string;
        brand: string;
        number: string;
        expMonth: string;
        expYear: string;
        code: string;
    };
    identity: Record<string, string>;
    sshKey: { privateKey: string; publicKey: string; keyFingerprint: string };
    fields: { name: string; value: string; type: number }[];
}

/** One folder, open. */
export interface VaultFolder {
    id: string;
    name: string;
}

/** The fields an identity carries, in the order the form draws them. */
export const IDENTITY_FIELDS = [
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
    "country",
    "ssn",
    "passportNumber",
    "licenseNumber"
] as const;

/** Decrypt one value, or "" when it is absent or will not open. */
async function open(value: unknown, key: crypto.SymmetricKey): Promise<string> {
    if (typeof value !== "string" || value.length === 0) return "";
    return (await crypto.decrypt(value, key)) ?? "";
}

/** Encrypt a value, or null when there is nothing to store. */
async function seal(value: string, key: crypto.SymmetricKey): Promise<string | null> {
    return value.length === 0 ? null : crypto.encrypt(value, key);
}

/** An empty item of a given type, for the "new item" form. */
export function emptyItem(type: number): VaultItem {
    return {
        id: "",
        type,
        name: "",
        notes: "",
        favorite: false,
        folderId: null,
        organizationId: null,
        deleted: false,
        revisionDate: "",
        login: { username: "", password: "", totp: "", uris: [] },
        card: { cardholderName: "", brand: "", number: "", expMonth: "", expYear: "", code: "" },
        identity: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, ""])),
        sshKey: { privateKey: "", publicKey: "", keyFingerprint: "" },
        fields: []
    };
}

/** Open one item as the server sent it. */
export async function decryptItem(
    raw: Record<string, unknown>,
    key: crypto.SymmetricKey
): Promise<VaultItem> {
    const item = emptyItem(Number(raw.type ?? core.CIPHER_LOGIN));
    item.id = String(raw.id ?? "");
    item.name = await open(raw.name, key);
    item.notes = await open(raw.notes, key);
    item.favorite = raw.favorite === true;
    item.folderId = typeof raw.folderId === "string" ? raw.folderId : null;
    item.organizationId = typeof raw.organizationId === "string" ? raw.organizationId : null;
    item.deleted = raw.deletedDate !== null && raw.deletedDate !== undefined;
    item.revisionDate = typeof raw.revisionDate === "string" ? raw.revisionDate : "";

    const login = raw.login as Record<string, unknown> | null | undefined;
    if (login) {
        item.login.username = await open(login.username, key);
        item.login.password = await open(login.password, key);
        item.login.totp = await open(login.totp, key);
        const uris = Array.isArray(login.uris) ? login.uris : [];
        item.login.uris = [];
        for (const entry of uris) {
            const uri = await open((entry as Record<string, unknown>)?.uri, key);
            if (uri) item.login.uris.push(uri);
        }
    }

    const card = raw.card as Record<string, unknown> | null | undefined;
    if (card) {
        item.card = {
            cardholderName: await open(card.cardholderName, key),
            brand: await open(card.brand, key),
            number: await open(card.number, key),
            expMonth: await open(card.expMonth, key),
            expYear: await open(card.expYear, key),
            code: await open(card.code, key)
        };
    }

    const identity = raw.identity as Record<string, unknown> | null | undefined;
    if (identity) {
        for (const field of IDENTITY_FIELDS) {
            item.identity[field] = await open(identity[field], key);
        }
    }

    const sshKey = raw.sshKey as Record<string, unknown> | null | undefined;
    if (sshKey) {
        item.sshKey = {
            privateKey: await open(sshKey.privateKey, key),
            publicKey: await open(sshKey.publicKey, key),
            keyFingerprint: await open(sshKey.keyFingerprint, key)
        };
    }

    const fields = Array.isArray(raw.fields) ? raw.fields : [];
    for (const entry of fields) {
        const row = entry as Record<string, unknown>;
        item.fields.push({
            name: await open(row.name, key),
            value: await open(row.value, key),
            type: Number(row.type ?? core.FIELD_TEXT)
        });
    }
    return item;
}

/**
 * Seal an item for the server.
 *
 * Only the sub-object matching the type is sent. An item that used to be a login
 * and is now a note should not keep a password nobody can see any more - which
 * is exactly the sort of thing that survives forever when everything is written
 * out every time.
 */
export async function encryptItem(
    item: VaultItem,
    key: crypto.SymmetricKey
): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
        type: item.type,
        name: (await seal(item.name || "Untitled", key)) ?? "",
        notes: await seal(item.notes, key),
        favorite: item.favorite,
        folderId: item.folderId,
        organizationId: item.organizationId,
        reprompt: 0,
        fields: await Promise.all(
            item.fields
                .filter((field) => field.name.length > 0 || field.value.length > 0)
                .map(async (field) => ({
                    type: field.type,
                    name: await seal(field.name, key),
                    value: await seal(field.value, key)
                }))
        ),
        ...(item.revisionDate ? { lastKnownRevisionDate: item.revisionDate } : {})
    };

    if (item.type === core.CIPHER_LOGIN) {
        body.login = {
            username: await seal(item.login.username, key),
            password: await seal(item.login.password, key),
            totp: await seal(item.login.totp, key),
            uris: await Promise.all(
                item.login.uris
                    .filter((uri) => uri.trim().length > 0)
                    .map(async (uri) => ({ uri: await seal(uri.trim(), key), match: null }))
            )
        };
    } else if (item.type === core.CIPHER_CARD) {
        body.card = {
            cardholderName: await seal(item.card.cardholderName, key),
            brand: await seal(item.card.brand, key),
            number: await seal(item.card.number, key),
            expMonth: await seal(item.card.expMonth, key),
            expYear: await seal(item.card.expYear, key),
            code: await seal(item.card.code, key)
        };
    } else if (item.type === core.CIPHER_IDENTITY) {
        const identity: Record<string, string | null> = {};
        for (const field of IDENTITY_FIELDS) {
            identity[field] = await seal(item.identity[field] ?? "", key);
        }
        body.identity = identity;
    } else if (item.type === core.CIPHER_SSH_KEY) {
        body.sshKey = {
            privateKey: await seal(item.sshKey.privateKey, key),
            publicKey: await seal(item.sshKey.publicKey, key),
            keyFingerprint: await seal(item.sshKey.keyFingerprint, key)
        };
    } else {
        body.secureNote = { type: 0 };
    }
    return body;
}

/** Open the folder names, which are encrypted like everything else. */
export async function decryptFolders(
    raw: Record<string, unknown>[],
    key: crypto.SymmetricKey
): Promise<VaultFolder[]> {
    const folders: VaultFolder[] = [];
    for (const row of raw) {
        folders.push({ id: String(row.id ?? ""), name: await open(row.name, key) });
    }
    return folders.sort((left, right) => left.name.localeCompare(right.name));
}
