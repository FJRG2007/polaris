/**
 * The passkey wrap: a fixed PRF output opens what it wrapped, and nothing else
 * does - a different output, a different salt or a tampered wrap all open to
 * null rather than to some other key.
 */

import { describe, expect, it } from "vitest";
import {
    generateSymmetricKey,
    symmetricKeyBytes,
    unwrapVaultKeyWithPasskey,
    wrapVaultKeyWithPasskey
} from "../src/index";

const PRF = new Uint8Array(32).fill(7);
const SALT = new Uint8Array(32).fill(3);

describe("passkey wrap", () => {
    it("opens with the PRF output it was wrapped under", async () => {
        const key = generateSymmetricKey();
        const wrapped = await wrapVaultKeyWithPasskey(key, PRF, SALT);
        expect(wrapped.startsWith("2.")).toBe(true);
        const opened = await unwrapVaultKeyWithPasskey(wrapped, PRF, SALT);
        expect(opened && Array.from(symmetricKeyBytes(opened))).toEqual(
            Array.from(symmetricKeyBytes(key))
        );
    });

    it("fails closed on another PRF output, another salt, or a tampered wrap", async () => {
        const wrapped = await wrapVaultKeyWithPasskey(generateSymmetricKey(), PRF, SALT);
        expect(
            await unwrapVaultKeyWithPasskey(wrapped, new Uint8Array(32).fill(8), SALT)
        ).toBeNull();
        expect(
            await unwrapVaultKeyWithPasskey(wrapped, PRF, new Uint8Array(32).fill(4))
        ).toBeNull();
        expect(await unwrapVaultKeyWithPasskey(wrapped, new Uint8Array(16), SALT)).toBeNull();
        const [head, body, mac] = wrapped.split("|");
        // The first character carries six real bits; the one before "=" holds
        // padding bits atob ignores, so changing it may not change the bytes.
        const flipped = `${head}|${body!.startsWith("A") ? "B" : "A"}${body!.slice(1)}|${mac}`;
        expect(await unwrapVaultKeyWithPasskey(flipped, PRF, SALT)).toBeNull();
    });

    it("never writes the PRF output into the wrap", async () => {
        const wrapped = await wrapVaultKeyWithPasskey(generateSymmetricKey(), PRF, SALT);
        expect(wrapped).not.toContain(btoa(String.fromCharCode(...PRF)));
    });
});
