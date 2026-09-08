/**
 * Reading an address against the ones already there, while it is being typed.
 *
 * The rule that matters is the one that was missing: a duplicate has to be
 * answered by the browser, off the list it already drew, rather than after a
 * server lookup and a password - or, for a send-as address, by a unique index
 * whose complaint reached the screen as "that could not be saved".
 */

import { describe, expect, it } from "vitest";
import { addressState } from "@/app/(app)/mail/address-state";

const HELD = ["ana@example.com", "team@example.org"];

describe("an address being typed", () => {
    it("says nothing at all about an empty field", () => {
        // A field that turns red before anything is in it is a field shouting at
        // somebody for starting.
        expect(addressState("", HELD)).toBe("empty");
        expect(addressState("   ", HELD)).toBe("empty");
    });

    it("is not an address until it is one", () => {
        expect(addressState("ana", HELD)).toBe("invalid");
        expect(addressState("ana@", HELD)).toBe("invalid");
    });

    it("catches the one already here", () => {
        expect(addressState("ana@example.com", HELD)).toBe("taken");
    });

    it("catches it however it was capitalised, as the server would", () => {
        // The two must not disagree: a form that allowed `Ana@` and a server that
        // refused it is the same duplicate reported later and worse.
        expect(addressState("  Ana@Example.COM ", HELD)).toBe("taken");
    });

    it("keeps sub-addressing apart, because the mailbox does", () => {
        // `ana+news@` is how somebody finds out who sold their address, and it is
        // a different mailbox to add.
        expect(addressState("ana+news@example.com", HELD)).toBe("ok");
    });

    it("lets a new one through", () => {
        expect(addressState("bo@example.com", HELD)).toBe("ok");
        expect(addressState("bo@example.com", [])).toBe("ok");
    });
});
