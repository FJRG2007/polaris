import { describe, expect, it } from "vitest";
import {
    accountCard,
    accountIdentity,
    blankIdentity,
    cardOf,
    shelfIdentities,
    type OpenIdentity
} from "../src/lib/identity";
import { ACCOUNT_IDENTITY } from "../src/lib/messages";

const ORG = { id: "org-1", vaultId: "vault-org" };
const PERSONAL_SECOND = "vault-mine";

function one(over: Partial<OpenIdentity> & { email?: string }): OpenIdentity {
    const { email = "", ...rest } = over;
    return {
        id: "id",
        name: "Name",
        organizationId: null,
        isDefault: false,
        values: { ...blankIdentity(), email },
        ...rest
    };
}

describe("the identities a sign-up menu offers", () => {
    const found = [
        one({ id: "b", name: "Bravo" }),
        one({ id: "a", name: "Alpha" }),
        one({ id: "second", name: "Zulu", organizationId: PERSONAL_SECOND, isDefault: true }),
        one({ id: "own", name: "Yankee", isDefault: true }),
        one({ id: "org", name: "Work", organizationId: "vault-org", isDefault: true }),
        one({ id: "org-other", name: "Another", organizationId: "vault-org" })
    ];

    it("puts the personal default first, then other defaults, then the rest by name", () => {
        const ids = shelfIdentities(found, null, [ORG]).map((entry) => entry.id);
        expect(ids).toEqual(["own", "second", "a", "b"]);
    });

    it("shows an organization's shelf only its own vault, default first", () => {
        const ids = shelfIdentities(found, ORG.id, [ORG]).map((entry) => entry.id);
        expect(ids).toEqual(["org", "org-other"]);
    });

    it("names the vault and the email on each card", () => {
        const work = one({
            id: "org",
            organizationId: "vault-org",
            isDefault: true,
            email: "w@x.test"
        });
        const card = cardOf(work, new Map([["vault-org", "Acme"]]));
        expect(card).toMatchObject({
            id: "org",
            detail: "w@x.test",
            vault: "Acme",
            isDefault: true
        });
    });

    it("falls back to the name when an identity has no email", () => {
        const named = one({
            id: "n",
            values: { ...blankIdentity(), firstName: "Ada", lastName: "King" }
        });
        expect(cardOf(named, new Map()).detail).toBe("Ada King");
    });
});

describe("the account as an identity", () => {
    it("splits the account's name and keeps its email", () => {
        const values = accountIdentity({ name: "Ada Byron King", email: "ada@x.test" });
        expect(values).toMatchObject({
            firstName: "Ada",
            lastName: "Byron King",
            email: "ada@x.test"
        });
        expect(accountCard(values!, "Me")).toMatchObject({
            id: ACCOUNT_IDENTITY,
            detail: "ada@x.test"
        });
    });

    it("offers nothing for an account that said nothing", () => {
        expect(accountIdentity(null)).toBeNull();
        expect(accountIdentity({ name: " ", email: null })).toBeNull();
    });
});
