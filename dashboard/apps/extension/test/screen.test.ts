/**
 * The order the popup's screens come in: which Polaris, then the account, then a
 * vault. The case this exists for is the browser that was already signed in to
 * a vault before connections existed, which used to skip the account entirely.
 */

import { describe, expect, it } from "vitest";
import { screenFor } from "../src/lib/screen";

const OPEN = {
    server: "https://polaris.example",
    linked: true,
    connected: true,
    polarisSession: true,
    unlocked: true
};

describe("the popup's first screen", () => {
    it("asks which Polaris before anything else", () => {
        expect(screenFor({ ...OPEN, server: null })).toBe("server");
    });

    it("asks to connect to the account before offering a vault", () => {
        expect(
            screenFor({
                ...OPEN,
                linked: false,
                connected: false,
                polarisSession: false,
                unlocked: false
            })
        ).toBe("link");
    });

    it("asks a browser already inside a vault to connect first, rather than showing the vault", () => {
        expect(screenFor({ ...OPEN, linked: false })).toBe("link");
    });

    it("offers the vault only once connected", () => {
        expect(screenFor({ ...OPEN, connected: false, polarisSession: false })).toBe("signIn");
    });

    it("sends a vault opened with the master password alone back through the approval", () => {
        expect(screenFor({ ...OPEN, polarisSession: false })).toBe("signIn");
    });

    it("asks for the master password on a locked vault, and lists it once open", () => {
        expect(screenFor({ ...OPEN, unlocked: false })).toBe("unlock");
        expect(screenFor(OPEN)).toBe("items");
    });
});
