/**
 * The two ways of writing somebody who never gave a name.
 *
 * A header carries an address and, if the sending client bothered, a name. Where
 * only one spelling of a person is ever on screen - a list row, a notification -
 * the part before the `@` reads better than the whole address, and that is what
 * `addressLabel` is for. Where the address is in view as well it is the opposite:
 * the sender line said "ana" while the chip under it said "ana@example.test", and
 * one person read as two.
 *
 * So the second rule is a function rather than an expression copied into every
 * pane that needs it, and what is pinned here is that the two disagree on purpose
 * and agree wherever a name exists.
 */

import { describe, expect, it } from "vitest";
import { addressLabel, addressName } from "../src/mailbox.js";

const UNNAMED = { name: "", address: "ana@example.test" };
const NAMED = { name: "Ana Quintero", address: "ana@example.test" };

describe("what to call somebody beside their address", () => {
    it("is the name they gave", () => {
        expect(addressName(NAMED)).toBe("Ana Quintero");
    });

    it("is the whole address where nobody ever said", () => {
        expect(addressName(UNNAMED)).toBe("ana@example.test");
    });

    it("is never the part before the @, which the list rule shortens to", () => {
        // The defect itself: both spellings of the same person, on one screen.
        expect(addressLabel(UNNAMED)).toBe("ana");
        expect(addressName(UNNAMED)).not.toBe(addressLabel(UNNAMED));
    });

    it("treats a name that is only spacing as no name at all", () => {
        expect(addressName({ name: "   ", address: "ana@example.test" })).toBe("ana@example.test");
    });

    it("trims the name it does use, so the chip and the sender line match", () => {
        expect(addressName({ name: "  Ana Quintero  ", address: "ana@example.test" })).toBe(
            "Ana Quintero"
        );
    });

    it("agrees with the list rule wherever a name exists", () => {
        expect(addressName(NAMED)).toBe(addressLabel(NAMED));
    });
});
