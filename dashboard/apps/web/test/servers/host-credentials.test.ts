/**
 * How a server's stored credential is read back.
 *
 * Enrollment wrote the bare private key where every reader expected a JSON
 * credential, so `JSON.parse` threw on the PEM's leading dash and every server
 * added by the enrollment command was unusable: Drive answered with the parse
 * error and the terminal turned it into "invalid ticket" and hung up. The writer
 * is fixed, but those rows still exist, so both shapes are pinned here.
 */

import { describe, expect, it } from "vitest";
import { readCredentials } from "../../src/lib/host-service";
import { encryptCredentials, encryptSecret } from "@polaris/storage";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const PEM = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
    "-----END OPENSSH PRIVATE KEY-----",
    ""
].join("\n");

describe("readCredentials", () => {
    it("reads a credential written in the shape every reader expects", () => {
        const blob = encryptCredentials({ method: "key", privateKey: PEM }, MASTER_KEY);
        expect(readCredentials(blob, MASTER_KEY)).toEqual({ method: "key", privateKey: PEM });
    });

    it("keeps a password credential intact", () => {
        const blob = encryptCredentials({ method: "password", password: "hunter2" }, MASTER_KEY);
        expect(readCredentials(blob, MASTER_KEY)).toEqual({ method: "password", password: "hunter2" });
    });

    // The rows enrollment already wrote. Reading one used to throw, which is the
    // whole outage: a server that enrolled fine could neither open a shell nor
    // show its files.
    it("reads a row that holds the bare private key as the key it is", () => {
        const blob = encryptSecret(PEM, MASTER_KEY);
        expect(readCredentials(blob, MASTER_KEY)).toEqual({ method: "key", privateKey: PEM });
    });

    // JSON that is not a credential is not one. Falling through to "it must be a
    // key" is what keeps a corrupt row from being reported as a parse error the
    // operator cannot act on.
    it("does not mistake unrelated JSON for a credential", () => {
        const blob = encryptSecret('{"method":"totp","secret":"x"}', MASTER_KEY);
        expect(readCredentials(blob, MASTER_KEY)).toEqual({
            method: "key",
            privateKey: '{"method":"totp","secret":"x"}'
        });
    });
});
