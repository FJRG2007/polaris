/**
 * The two things Polaris keeps that Bitwarden's cipher model has no column for:
 * an API key, and a login's email apart from its username.
 *
 * Both are custom fields to every other client. What is pinned here is that
 * they survive the trip through the encrypted cipher shape the server stores
 * and through a Bitwarden JSON export, that a Bitwarden client would see a
 * usable secure note and an untouched `login.username`, and that search finds
 * an item by either the username or the email.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as crypto from "../../src/lib/vault/crypto";
import * as portability from "../../src/lib/vault/portability";
import {
    ITEM_API_KEY,
    decryptItem,
    emptyItem,
    encryptItem,
    itemKind,
    loginEmail,
    managedFieldNames,
    matchesSearch,
    type VaultItem
} from "../../src/app/(app)/vault/vault-model";

const PARTS = {
    key: "pk_live_0123456789",
    secret: "sk_live_abcdefghijklmnop",
    endpoint: "https://api.example.com/v1"
};

/** An API key as the editor hands it over on save: a secure note with its
 *  parts written into fields. */
function apiKeyItem(): VaultItem {
    const item = emptyItem(core.CIPHER_SECURE_NOTE);
    item.name = "Payments";
    item.fields = core.writeApiKey([{ name: "Region", value: "eu", type: core.FIELD_TEXT }], PARTS);
    return item;
}

/** A login with a username and, apart from it, an email. */
function loginItem(): VaultItem {
    const item = emptyItem(core.CIPHER_LOGIN);
    item.name = "Forum";
    item.login.username = "ada_l";
    item.login.password = "hunter2";
    item.fields = core.withChangedField([], core.EMAIL_FIELD, "ada@example.com", core.FIELD_TEXT);
    return item;
}

describe("an API key through the Bitwarden cipher shape", () => {
    it("is stored as a secure note carrying its parts as fields", async () => {
        const key = crypto.generateSymmetricKey();
        const body = await encryptItem(apiKeyItem(), key);

        expect(body.type).toBe(core.CIPHER_SECURE_NOTE);
        expect(body.secureNote).toEqual({ type: 0 });
        expect(body.login).toBeUndefined();

        const fields = body.fields as { name: string; value: string; type: number }[];
        const open = await Promise.all(
            fields.map(async (field) => ({
                name: await crypto.decrypt(field.name, key),
                value: await crypto.decrypt(field.value, key),
                type: field.type
            }))
        );
        // What a Bitwarden client lists: the marker, then readable fields, with
        // the secret hidden.
        expect(open).toEqual(
            expect.arrayContaining([
                { name: "Region", value: "eu", type: core.FIELD_TEXT },
                { name: core.ITEM_KIND_FIELD, value: core.API_KEY_KIND, type: core.FIELD_TEXT },
                { name: core.API_KEY_FIELD, value: PARTS.key, type: core.FIELD_TEXT },
                { name: core.API_SECRET_FIELD, value: PARTS.secret, type: core.FIELD_HIDDEN },
                { name: core.API_ENDPOINT_FIELD, value: PARTS.endpoint, type: core.FIELD_TEXT }
            ])
        );
        expect(open).toHaveLength(5);
    });

    it("comes back as an API key with the same parts", async () => {
        const key = crypto.generateSymmetricKey();
        const raw = { id: "c1", ...(await encryptItem(apiKeyItem(), key)) };
        const item = await decryptItem(raw, key);

        expect(item.type).toBe(core.CIPHER_SECURE_NOTE);
        expect(itemKind(item)).toBe(ITEM_API_KEY);
        expect(core.readApiKey(item.fields)).toEqual(PARTS);
        // The parts have boxes of their own; the other field is still listed.
        const managed = managedFieldNames(item);
        expect(
            item.fields.filter((field) => !managed.has(field.name)).map((field) => field.name)
        ).toEqual(["Region"]);
    });

    it("is never sent as Polaris's own kind number", async () => {
        const item = apiKeyItem();
        item.type = ITEM_API_KEY;
        const body = await encryptItem(item, crypto.generateSymmetricKey());
        expect(body.type).toBe(core.CIPHER_SECURE_NOTE);
    });

    it("survives a Bitwarden JSON export and import", () => {
        const file = portability.writeExport("json", [apiKeyItem()], []);
        const written = JSON.parse(file.text).items[0];
        expect(written.type).toBe(core.CIPHER_SECURE_NOTE);
        expect(written.secureNote).toEqual({ type: 0 });

        const [back] = portability.readImportFile("vault.json", file.text).items;
        expect(back && itemKind(back)).toBe(ITEM_API_KEY);
        expect(back && core.readApiKey(back.fields)).toEqual(PARTS);
    });

    it("is an ordinary note without the marker", () => {
        const item = emptyItem(core.CIPHER_SECURE_NOTE);
        item.fields = [{ name: core.API_KEY_FIELD, value: "x", type: core.FIELD_TEXT }];
        expect(itemKind(item)).toBe(core.CIPHER_SECURE_NOTE);
        expect(managedFieldNames(item).has(core.API_KEY_FIELD)).toBe(false);
        // The marker on any other kind of item means nothing either.
        const login = emptyItem(core.CIPHER_LOGIN);
        login.fields = [
            { name: core.ITEM_KIND_FIELD, value: core.API_KEY_KIND, type: core.FIELD_TEXT }
        ];
        expect(itemKind(login)).toBe(core.CIPHER_LOGIN);
    });
});

describe("a login's email, apart from its username", () => {
    it("leaves login.username exactly the username", async () => {
        const key = crypto.generateSymmetricKey();
        const body = await encryptItem(loginItem(), key);
        const login = body.login as { username: string };
        expect(await crypto.decrypt(login.username, key)).toBe("ada_l");

        const fields = body.fields as { name: string; value: string; type: number }[];
        expect(fields).toHaveLength(1);
        expect(await crypto.decrypt(fields[0]!.name, key)).toBe(core.EMAIL_FIELD);
        expect(await crypto.decrypt(fields[0]!.value, key)).toBe("ada@example.com");
        expect(fields[0]!.type).toBe(core.FIELD_TEXT);
    });

    it("reads back apart, and is kept out of the custom-field list", async () => {
        const key = crypto.generateSymmetricKey();
        const item = await decryptItem({ id: "l1", ...(await encryptItem(loginItem(), key)) }, key);
        expect(item.login.username).toBe("ada_l");
        expect(loginEmail(item)).toBe("ada@example.com");
        expect(managedFieldNames(item).has(core.EMAIL_FIELD)).toBe(true);
    });

    it("is only a login's: an Email field on a card stays a custom field", () => {
        const card = emptyItem(core.CIPHER_CARD);
        card.fields = [
            { name: core.EMAIL_FIELD, value: "billing@example.com", type: core.FIELD_TEXT }
        ];
        expect(loginEmail(card)).toBe("");
        expect(managedFieldNames(card).has(core.EMAIL_FIELD)).toBe(false);
    });

    it("is found by search, as is the username", () => {
        const item = loginItem();
        expect(matchesSearch(item, "ada@exa")).toBe(true);
        expect(matchesSearch(item, "ADA_L")).toBe(true);
        expect(matchesSearch(item, "nobody")).toBe(false);
        expect(matchesSearch(item, "  ")).toBe(true);
    });

    it("finds a login by its website, which search used to print as [object Object]", () => {
        const item = loginItem();
        item.login.uris = [{ uri: "https://forum.example.org", match: null }];
        expect(matchesSearch(item, "forum.example")).toBe(true);
        expect(matchesSearch(item, "object")).toBe(false);
    });

    it("leaves an existing login's fields as they were when saved unchanged", () => {
        const fields = [
            { name: core.EMAIL_FIELD, value: "old@example.com", type: core.FIELD_HIDDEN }
        ];
        expect(
            core.withChangedField(fields, core.EMAIL_FIELD, "old@example.com", core.FIELD_TEXT)
        ).toEqual(fields);
        // Nothing typed, nothing stored.
        expect(core.withChangedField([], core.EMAIL_FIELD, "", core.FIELD_TEXT)).toEqual([]);
    });
});
