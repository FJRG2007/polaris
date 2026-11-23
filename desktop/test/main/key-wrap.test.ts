/**
 * The chat key's device lock under safeStorage: sealed values are bound to the
 * server that sealed them, malformed input and an unusable store are refused
 * with null, and a Linux desktop with no secret service never pretends to seal.
 */

import { describe, expect, it } from "vitest";
import { canWrapKeys, openKey, sealKey, type SafeStorageLike } from "../../src/main/key-wrap";

/** A reversible stand-in for the OS store, keyed so a different "account" cannot open it. */
function storage(secret = 7, backend = "gnome_libsecret", available = true): SafeStorageLike {
    const flip = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ secret));
    return {
        isEncryptionAvailable: () => available,
        getSelectedStorageBackend: () => backend,
        encryptString: (plain) => Buffer.concat([Buffer.from("OS"), flip(Buffer.from(plain, "utf8"))]),
        decryptString: (sealed) => {
            if (sealed.subarray(0, 2).toString() !== "OS") throw new Error("not ours");
            return flip(sealed.subarray(2)).toString("utf8");
        }
    };
}

const ORIGIN = "https://polaris.example.com";
const PAGE = `${ORIGIN}/oauth/login?x=1`;
const DATA = "AAECAwQFBgcICQ_-";

describe("desktop key wrap", () => {
    it("round-trips for the same server, from any page of it", () => {
        const sealed = sealKey(storage(), PAGE, DATA, "win32");
        expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(sealed).not.toContain(DATA);
        expect(openKey(storage(), `${ORIGIN}/chat`, sealed, "win32")).toBe(DATA);
    });

    it("never opens a value sealed for another server", () => {
        const sealed = sealKey(storage(), PAGE, DATA, "win32");
        expect(openKey(storage(), "https://other.example.com/chat", sealed, "win32")).toBeNull();
        expect(openKey(storage(), "https://polaris.example.com:8443/", sealed, "win32")).toBeNull();
    });

    it("answers null when the store cannot open it (another OS account, a reset keychain, garbage)", () => {
        const sealed = sealKey(storage(7), PAGE, DATA, "darwin");
        expect(openKey(storage(9), PAGE, sealed, "darwin")).toBeNull();
        expect(openKey(storage(), PAGE, "bm90LXNlYWxlZA", "darwin")).toBeNull();
    });

    it("refuses malformed input instead of sealing it", () => {
        for (const data of ["", "has space", "a+b/c=", "x".repeat(4097), 42, null, { a: 1 }])
            expect(sealKey(storage(), PAGE, data, "win32")).toBeNull();
        for (const origin of [undefined, "", "file:///C:/x", "javascript:alert(1)", 7])
            expect(sealKey(storage(), origin, DATA, "win32")).toBeNull();
        expect(openKey(storage(), PAGE, "a+b", "win32")).toBeNull();
    });

    it("refuses a store that protects nothing: unavailable, or Linux without a secret service", () => {
        expect(canWrapKeys(storage(7, "basic_text"), "linux")).toBe(false);
        expect(sealKey(storage(7, "basic_text"), PAGE, DATA, "linux")).toBeNull();
        expect(canWrapKeys(storage(7, "gnome_libsecret", false), "win32")).toBe(false);
        expect(canWrapKeys(storage(7, "gnome_libsecret"), "linux")).toBe(true);
        const throwing = { ...storage(), isEncryptionAvailable: () => { throw new Error("not ready"); } };
        expect(canWrapKeys(throwing, "win32")).toBe(false);
    });

    it("refuses a decrypted value that is not a well-formed envelope for this server", () => {
        const tampered = storage();
        const sealed = tampered.encryptString(`${ORIGIN}\nnot base64!`).toString("base64url");
        expect(openKey(storage(), PAGE, sealed, "win32")).toBeNull();
        const noSeparator = tampered.encryptString(`${ORIGIN}${DATA}`).toString("base64url");
        expect(openKey(storage(), PAGE, noSeparator, "win32")).toBeNull();
    });
});
