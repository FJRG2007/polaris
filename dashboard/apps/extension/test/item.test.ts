import { describe, expect, it } from "vitest";
import { withNewPassword, type SyncedItem } from "../src/lib/item";

/**
 * Rewriting an item to change its password.
 *
 * These assertions exist because the failure they guard against is silent. The
 * vault takes an item whole, so a field left out of the rebuilt item is a field
 * deleted from somebody's vault - their notes, their custom fields, the recovery
 * codes they pasted in - with a successful save and nothing on screen to show it.
 * Every "is preserved" test below is one of those.
 */

/**
 * An item with something in every corner, including fields this extension has no
 * idea about, so that dropping any of them shows up here.
 */
const stored = (): SyncedItem => ({
    object: "cipherDetails",
    id: "8f14e45f-ceea-467a-9ae7-4a2c0b1e0f11",
    organizationId: null,
    folderId: "3c59dc04-8e88-4950-9d48-6a1f2e8f6d22",
    type: 1,
    name: "2.name==|ct|mac",
    notes: "2.notes==|ct|mac",
    favorite: true,
    reprompt: 1,
    login: {
        username: "2.user==|ct|mac",
        password: "2.old==|ct|mac",
        totp: "2.totp==|ct|mac",
        uris: [{ uri: "2.uri==|ct|mac", match: null }],
        autofillOnPageLoad: true
    },
    card: null,
    identity: null,
    secureNote: null,
    sshKey: null,
    fields: [{ type: 0, name: "2.f==|ct|mac", value: "2.v==|ct|mac", linkedId: null }],
    passwordHistory: [{ password: "2.older==|ct|mac", lastUsedDate: "2026-01-01T00:00:00.000Z" }],
    attachments: [{ id: "a1", fileName: "2.file==|ct|mac", key: "2.k==|ct|mac", size: "12" }],
    collectionIds: [],
    revisionDate: "2026-09-01T10:00:00.000Z",
    creationDate: "2025-01-01T00:00:00.000Z",
    deletedDate: null
});

const NOW = "2026-09-13T20:00:00.000Z";

describe("withNewPassword", () => {
    it("replaces the password and stamps when it changed", () => {
        const next = withNewPassword(stored(), "2.new==|ct|mac", NOW);
        const login = next["login"] as Record<string, unknown>;
        expect(login["password"]).toBe("2.new==|ct|mac");
        expect(login["passwordRevisionDate"]).toBe(NOW);
    });

    it("keeps every other field of the login", () => {
        const next = withNewPassword(stored(), "2.new==|ct|mac", NOW);
        const login = next["login"] as Record<string, unknown>;
        const was = stored()["login"] as Record<string, unknown>;
        expect(login["username"]).toBe(was["username"]);
        expect(login["totp"]).toBe(was["totp"]);
        expect(login["uris"]).toEqual(was["uris"]);
        expect(login["autofillOnPageLoad"]).toBe(true);
    });

    it("keeps every field of the item the extension does not model", () => {
        const was = stored();
        const next = withNewPassword(was, "2.new==|ct|mac", NOW);
        for (const field of [
            "name",
            "notes",
            "fields",
            "favorite",
            "reprompt",
            "folderId",
            "organizationId",
            "type",
            "card",
            "identity",
            "secureNote",
            "sshKey",
            "attachments",
            "collectionIds"
        ]) {
            expect(next[field]).toEqual(was[field]);
        }
    });

    it("moves the old password into the history, newest first", () => {
        const next = withNewPassword(stored(), "2.new==|ct|mac", NOW);
        expect(next["passwordHistory"]).toEqual([
            { password: "2.old==|ct|mac", lastUsedDate: NOW },
            { password: "2.older==|ct|mac", lastUsedDate: "2026-01-01T00:00:00.000Z" }
        ]);
    });

    it("keeps the old password as ciphertext, never in the clear", () => {
        const next = withNewPassword(stored(), "2.new==|ct|mac", NOW);
        const history = next["passwordHistory"] as { password: string }[];
        expect(history[0]?.password).toBe("2.old==|ct|mac");
    });

    it("adds no history entry for an item that had no password", () => {
        const was = stored();
        was["login"] = { username: "2.user==|ct|mac" };
        was["passwordHistory"] = [];
        const next = withNewPassword(was, "2.new==|ct|mac", NOW);
        expect(next["passwordHistory"]).toEqual([]);
    });

    it("starts a history for an item that had a password and no history", () => {
        const was = stored();
        delete was["passwordHistory"];
        const next = withNewPassword(was, "2.new==|ct|mac", NOW);
        expect(next["passwordHistory"]).toEqual([
            { password: "2.old==|ct|mac", lastUsedDate: NOW }
        ]);
    });

    it("sends the revision it last saw, so a stale write is refused", () => {
        const next = withNewPassword(stored(), "2.new==|ct|mac", NOW);
        expect(next["lastKnownRevisionDate"]).toBe("2026-09-01T10:00:00.000Z");
    });

    it("sends no revision it cannot source", () => {
        const was = stored();
        delete was["revisionDate"];
        expect(
            withNewPassword(was, "2.new==|ct|mac", NOW)["lastKnownRevisionDate"]
        ).toBeUndefined();
    });

    it("copes with an item carrying no login block at all", () => {
        const was = stored();
        delete was["login"];
        const next = withNewPassword(was, "2.new==|ct|mac", NOW);
        expect(next["login"]).toEqual({
            password: "2.new==|ct|mac",
            passwordRevisionDate: NOW
        });
        expect(next["passwordHistory"]).toEqual(stored()["passwordHistory"]);
    });

    it("does not touch what it was given, which is the worker's own copy", () => {
        const was = stored();
        withNewPassword(was, "2.new==|ct|mac", NOW);
        expect(was).toEqual(stored());
    });
});
