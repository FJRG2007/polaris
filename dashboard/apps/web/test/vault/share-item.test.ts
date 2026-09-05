/**
 * What actually travels when an item is handed out as a link.
 *
 * The failure to guard against is a share that carries more than was asked for.
 * A copy sent to somebody cannot be taken back, so every assertion here is about
 * something NOT being in the text unless it was chosen.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { emptyItem, type VaultItem } from "@/app/(app)/vault/vault-model";
import {
    defaultParts,
    shareableParts,
    shareText,
    type SharedPart
} from "@/app/(app)/vault/share-item";

function login(): VaultItem {
    const item = emptyItem(core.CIPHER_LOGIN);
    return {
        ...item,
        id: "item-1",
        name: "GitHub",
        notes: "The work account",
        login: {
            ...item.login,
            username: "someone@example.com",
            password: "hunter2-and-then-some",
            totp: "JBSWY3DPEHPK3PXP",
            uris: [{ uri: "https://*.github.com", match: core.URI_MATCH_DOMAIN }]
        },
        fields: core.withField(
            item.fields,
            core.RECOVERY_CODES_FIELD,
            "-aaaa-1111\nbbbb-2222",
            core.FIELD_HIDDEN
        )
    };
}

const chosen = (...parts: SharedPart[]) => new Set(parts);

describe("what can be shared", () => {
    it("offers only the parts the item actually has", () => {
        const parts = shareableParts(login());
        expect(parts).toContain("password");
        expect(parts).toContain("recovery");
        // A login has no card and no identity, so neither is offered.
        expect(parts).not.toContain("card");
        expect(parts).not.toContain("identity");
    });

    it("starts with the smallest set that is any use", () => {
        const parts = defaultParts(login());
        expect(parts).toEqual(["username", "password", "uris"]);
        // The two that hand over the second factor are never on by default.
        expect(parts).not.toContain("totp");
        expect(parts).not.toContain("recovery");
    });
});

describe("what the text carries", () => {
    it("writes only the parts that were chosen", () => {
        const text = shareText(login(), chosen("username", "password"));
        expect(text).toContain("someone@example.com");
        expect(text).toContain("hunter2-and-then-some");
        // Everything else stayed behind.
        expect(text).not.toContain("JBSWY3DPEHPK3PXP");
        expect(text).not.toContain("aaaa-1111");
        expect(text).not.toContain("The work account");
        expect(text).not.toContain("github.com");
    });

    it("sends an address somebody can open rather than the starred form", () => {
        expect(shareText(login(), chosen("uris"))).toContain("Website: https://github.com");
        expect(shareText(login(), chosen("uris"))).not.toContain("*.");
    });

    it("drops the used-mark from recovery codes, which means nothing to a stranger", () => {
        const text = shareText(login(), chosen("recovery"));
        expect(text).toContain("aaaa-1111");
        expect(text).not.toContain("-aaaa-1111");
    });

    it("says nothing at all when nothing was chosen", () => {
        expect(shareText(login(), chosen())).toBe("");
    });

    it("leaves out a chosen part the item does not have", () => {
        const bare = { ...login(), notes: "" };
        expect(shareText(bare, chosen("notes"))).toBe("");
    });
});

describe("a card", () => {
    it("carries its own fields and not a login's", () => {
        const item = emptyItem(core.CIPHER_CARD);
        const card: VaultItem = {
            ...item,
            name: "Travel card",
            card: {
                ...item.card,
                cardholderName: "A Person",
                number: "4111111111111111",
                expMonth: "08",
                expYear: "2030",
                code: "123"
            }
        };
        const text = shareText(card, chosen("card"));
        expect(text).toContain("Card number: 4111111111111111");
        expect(text).toContain("Security code: 123");
        expect(text).toContain("Expires: 08/30");
    });
});
