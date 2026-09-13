import { describe, expect, it } from "vitest";
import { DEVICE_TYPE_LABEL, VAULT_CLIENT_KIND, vaultClientKind } from "../src/vault";

/**
 * Naming and grouping the clients signed in to a vault.
 *
 * The grouping is what lets somebody pick their browser extension out of a list
 * that also holds a phone, a desktop app and a CLI. It is tested mostly for one
 * reason: it is a second table over the same numbers as the labels, so the way it
 * goes wrong is by drifting from them - a type gains a name and no kind, or the
 * other way round, and neither shows up as an error anywhere.
 */

describe("vaultClientKind", () => {
    it("calls every browser extension an extension", () => {
        // 2/3/4/5 are what the Polaris extension reports for Chrome, Firefox, Opera
        // and Edge; 19/20 are Vivaldi's and Safari's.
        for (const type of [2, 3, 4, 5, 19, 20]) {
            expect(vaultClientKind(type)).toBe("extension");
        }
    });

    it("does not confuse a browser with an extension running inside it", () => {
        // 9 is Chrome itself - the web vault in a tab - and 2 is an extension in it.
        expect(vaultClientKind(9)).toBe("browser");
        expect(vaultClientKind(2)).toBe("extension");
    });

    it("groups the rest the way their names read", () => {
        expect(vaultClientKind(0)).toBe("mobile");
        expect(vaultClientKind(1)).toBe("mobile");
        expect(vaultClientKind(6)).toBe("desktop");
        expect(vaultClientKind(8)).toBe("desktop");
        expect(vaultClientKind(23)).toBe("cli");
        expect(vaultClientKind(25)).toBe("cli");
    });

    it("answers for a type it has never heard of, rather than throwing", () => {
        expect(vaultClientKind(9999)).toBe("other");
        expect(vaultClientKind(-1)).toBe("other");
        expect(vaultClientKind(null)).toBe("other");
        expect(vaultClientKind(undefined)).toBe("other");
    });

    it("has an entry for exactly the types that have a label", () => {
        // The drift this file exists to catch, put as the two tables covering the
        // same numbers. Asserting "no labelled type is other" would be wrong rather
        // than strict: 21 (SDK) and 22 (Server) are deliberately other, so that
        // check would have to be weakened the first time somebody read it, and a
        // check that gets weakened stops being one.
        expect(Object.keys(VAULT_CLIENT_KIND).sort()).toEqual(
            Object.keys(DEVICE_TYPE_LABEL).sort()
        );
    });
});
