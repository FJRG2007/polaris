/**
 * Which logins the popup lists on the shelf that is open - the same rule the
 * dashboard's vault screen follows.
 */

import { describe, expect, it } from "vitest";
import { onShelf } from "../src/lib/shelf";

const ORGS = [
    { id: "org-acme", vaultId: "vault-acme" },
    { id: "org-empty", vaultId: null }
];

describe("the personal shelf", () => {
    it("lists the account's own logins", () => {
        expect(onShelf(null, null, ORGS)).toBe(true);
    });

    it("lists a personal vault somebody shared, which is no organization's", () => {
        expect(onShelf("vault-shared-by-a-friend", null, ORGS)).toBe(true);
    });

    it("leaves an organization's vault to that organization's shelf", () => {
        expect(onShelf("vault-acme", null, ORGS)).toBe(false);
    });
});

describe("an organization's shelf", () => {
    it("lists that organization's vault and nothing else", () => {
        expect(onShelf("vault-acme", "org-acme", ORGS)).toBe(true);
        expect(onShelf(null, "org-acme", ORGS)).toBe(false);
        expect(onShelf("vault-shared-by-a-friend", "org-acme", ORGS)).toBe(false);
    });

    it("lists nothing for an organization with no vault", () => {
        expect(onShelf(null, "org-empty", ORGS)).toBe(false);
    });

    it("lists nothing for an organization the account has left", () => {
        expect(onShelf("vault-acme", "org-gone", ORGS)).toBe(false);
    });
});
