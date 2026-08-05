/**
 * The fingerprint that notices one secret being stored twice.
 *
 * It has to be stable for the same secret and unmistakable for a different one,
 * or the duplicate check either never fires or refuses a key somebody is
 * entitled to add. Keyed under the master key, so the same secret fingerprints
 * differently on two deployments and a stolen dump cannot be tested against a
 * list of known keys.
 */

import { describe, expect, it } from "vitest";
import { secretFingerprint } from "../src/crypto.js";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("secretFingerprint", () => {
    it("is the same every time for the same secret and scope", () => {
        expect(secretFingerprint("sk-abc", "model-key:openai", MASTER_KEY)).toBe(
            secretFingerprint("sk-abc", "model-key:openai", MASTER_KEY)
        );
    });

    it("differs for a different secret", () => {
        expect(secretFingerprint("sk-abc", "model-key:openai", MASTER_KEY)).not.toBe(
            secretFingerprint("sk-abd", "model-key:openai", MASTER_KEY)
        );
    });

    it("differs across scopes, so one secret stored for two things does not collide", () => {
        expect(secretFingerprint("sk-abc", "model-key:openai", MASTER_KEY)).not.toBe(
            secretFingerprint("sk-abc", "model-key:groq", MASTER_KEY)
        );
    });

    it("differs under a different master key", () => {
        expect(secretFingerprint("sk-abc", "model-key:openai", MASTER_KEY)).not.toBe(
            secretFingerprint("sk-abc", "model-key:openai", OTHER_KEY)
        );
    });

    it("does not leak the secret", () => {
        const secret = "sk-super-secret-value";
        expect(secretFingerprint(secret, "model-key:openai", MASTER_KEY)).not.toContain(secret);
    });

    it("cannot be separated by moving the boundary between scope and secret", () => {
        // The two parts are joined, so a scope ending where a secret begins must
        // not produce the same digest as the other split of the same characters.
        expect(secretFingerprint("b", "a", MASTER_KEY)).not.toBe(secretFingerprint("", "a b", MASTER_KEY));
    });
});
