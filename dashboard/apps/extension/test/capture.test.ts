/**
 * What a submitted login is worth, against what the vault already holds.
 *
 * The cases that cost something are all here: an offer to save a password that is
 * already saved is the one that teaches people to dismiss the bar, and the
 * dismissal then costs them the offer that mattered - the password they have just
 * changed. And an update aimed at the wrong item is a password replaced in
 * somebody's vault by a bar they pressed without reading.
 */

import { describe, expect, it } from "vitest";
import { offerFor, type SavedLogin } from "../src/lib/capture";

/** A saved login, with the shape a vault row reduces to. */
function saved(over: Partial<SavedLogin> = {}): SavedLogin {
    return { id: "1", name: "Example", username: "ana@example.com", password: "old", ...over };
}

describe("what to offer for a submitted login", () => {
    it("offers to save a login for a site with nothing on it", () => {
        expect(offerFor({ username: "ana@example.com", password: "s3cret" }, [])).toEqual({
            kind: "save",
            username: "ana@example.com",
            password: "s3cret"
        });
    });

    it("says nothing when the password is already exactly what is stored", () => {
        const offer = offerFor({ username: "ana@example.com", password: "old" }, [saved()]);
        expect(offer.kind).toBe("none");
    });

    it("offers to replace the password when the same account has a new one", () => {
        const offer = offerFor({ username: "ana@example.com", password: "new" }, [saved()]);
        expect(offer).toEqual({
            kind: "update",
            id: "1",
            name: "Example",
            username: "ana@example.com",
            password: "new"
        });
    });

    it("reads the same address typed differently as the same account", () => {
        const offer = offerFor({ username: "  Ana@Example.com ", password: "new" }, [saved()]);
        expect(offer.kind).toBe("update");
    });

    it("saves rather than replaces when the username is one the vault has not seen", () => {
        const offer = offerFor({ username: "luis@example.com", password: "new" }, [saved()]);
        expect(offer).toEqual({
            kind: "save",
            username: "luis@example.com",
            password: "new"
        });
    });

    it("takes a change form with no username as being about the site's one login", () => {
        // A change-password form usually has no name in it at all. One saved login
        // for the page is the only case where that cannot be the wrong item.
        const offer = offerFor({ username: "", password: "new" }, [saved()]);
        expect(offer).toEqual({
            kind: "update",
            id: "1",
            name: "Example",
            username: "ana@example.com",
            password: "new"
        });
    });

    it("says nothing rather than guess between two logins for the same site", () => {
        // A personal vault and an organization's holding the same account is
        // ordinary here, and nothing in a form says which was just used.
        const offer = offerFor({ username: "ana@example.com", password: "new" }, [
            saved(),
            saved({ id: "2", name: "Example (work)" })
        ]);
        expect(offer.kind).toBe("none");
    });

    it("says nothing when one of several already has that password", () => {
        const offer = offerFor({ username: "", password: "old" }, [
            saved(),
            saved({ id: "2", password: "other" })
        ]);
        expect(offer.kind).toBe("none");
    });

    it("has nothing to say about an empty password", () => {
        expect(offerFor({ username: "ana@example.com", password: "" }, []).kind).toBe("none");
    });

    it("keeps a password's spaces, which are part of it", () => {
        const offer = offerFor({ username: "ana@example.com", password: " s3cret " }, []);
        expect(offer.kind === "save" && offer.password).toBe(" s3cret ");
    });
});
