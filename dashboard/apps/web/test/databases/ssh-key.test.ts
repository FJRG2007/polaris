/**
 * A private key as people actually have one: OpenSSH, old PEM, PKCS#8 from a
 * cloud console, PuTTY - locked or not - or the public key by mistake. Each is
 * either turned into a key ssh2 signs with, whose public half is the original's,
 * or refused in a sentence.
 *
 * Keys are generated per run; the PuTTY ones are ssh2's own test fixtures.
 */

import { utils } from "ssh2";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { sshKeyShape } from "@/lib/data/connection-schema";
import { readPrivateKey, SSH_KEY_REFUSALS } from "@/lib/data/ssh-key";

const fixtures = join(
    dirname(createRequire(import.meta.url).resolve("ssh2/package.json")),
    "test/fixtures/keyParser"
);

/** OpenSSH's fingerprint of a public key blob. */
function fingerprintOf(blob: Buffer): string {
    return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** SSH wire string: a length, then the bytes. */
function wire(value: Buffer | string): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

/** An unsigned big integer as an SSH mpint. */
function mpint(value: Buffer): Buffer {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const trimmed = value.subarray(start);
    return wire(
        (trimmed[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed
    );
}

/** The SSH public blob of a Node key object, built from its JWK - independently
 *  of the conversion under test. */
function blobOf(publicKey: crypto.KeyObject): Buffer {
    const jwk = publicKey.export({ format: "jwk" });
    const b = (value: string | undefined) => Buffer.from(value ?? "", "base64url");
    if (jwk.kty === "OKP") return Buffer.concat([wire("ssh-ed25519"), wire(b(jwk.x))]);
    if (jwk.kty === "RSA")
        return Buffer.concat([wire("ssh-rsa"), mpint(b(jwk.e)), mpint(b(jwk.n))]);
    const curve = { "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" }[
        jwk.crv as string
    ] as string;
    return Buffer.concat([
        wire(`ecdsa-sha2-${curve}`),
        wire(curve),
        wire(Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]))
    ]);
}

describe("keys ssh2 reads as they are", () => {
    it("takes an OpenSSH Ed25519 key", () => {
        const pair = utils.generateKeyPairSync("ed25519");
        const read = readPrivateKey(pair.private, null);
        expect(read.type).toBe("ssh-ed25519");
        expect(read.converted).toBe(false);
        expect(read.privateKey).toBe(pair.private.trim());
    });

    it("unlocks an encrypted OpenSSH key, and refuses the wrong passphrase", () => {
        const pair = utils.generateKeyPairSync("ecdsa", {
            bits: 256,
            passphrase: "correct horse",
            cipher: "aes256-ctr",
            rounds: 16
        });
        expect(sshKeyShape(pair.private)).toMatchObject({ kind: "private", encrypted: true });
        expect(readPrivateKey(pair.private, "correct horse").passphrase).toBe("correct horse");
        expect(() => readPrivateKey(pair.private, "wrong")).toThrow(
            SSH_KEY_REFUSALS.wrongPassphrase
        );
        expect(() => readPrivateKey(pair.private, null)).toThrow(SSH_KEY_REFUSALS.locked);
    });

    it("refuses an OpenSSH key whose KDF would tie this server up", () => {
        // Made with 16 rounds, then told it needs 101, one over the cap: the rounds live in
        // the clear header, which is all an attacker has to write.
        const pair = utils.generateKeyPairSync("ed25519", {
            passphrase: "p",
            cipher: "aes256-ctr",
            rounds: 16
        });
        const body = Buffer.from(
            pair.private.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""),
            "base64"
        );
        const at = body.indexOf(Buffer.from("bcrypt")) + "bcrypt".length;
        // kdfoptions: uint32 length, then the salt as a string, then the rounds.
        const saltLength = body.readUInt32BE(at + 4);
        body.writeUInt32BE(101, at + 8 + saltLength);
        const forged = `-----BEGIN OPENSSH PRIVATE KEY-----
${body.toString("base64")}
-----END OPENSSH PRIVATE KEY-----`;
        expect(() => readPrivateKey(forged, "p")).toThrow(SSH_KEY_REFUSALS.tooCostly);
    });

    it("takes an old PEM RSA key", () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048
        });
        const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
        expect(readPrivateKey(pem, null).fingerprint).toBe(fingerprintOf(blobOf(publicKey)));
    });
});

describe("keys converted to OpenSSH", () => {
    for (const [label, make] of [
        ["Ed25519", () => crypto.generateKeyPairSync("ed25519")],
        ["RSA", () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })],
        ["ECDSA P-256", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })],
        ["ECDSA P-384", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-384" })]
    ] as const) {
        it(`turns a PKCS#8 ${label} key into one with the same public half`, () => {
            const { privateKey, publicKey } = make();
            const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
            const read = readPrivateKey(pem, null);
            expect(read.converted).toBe(true);
            expect(read.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
            expect(read.fingerprint).toBe(fingerprintOf(blobOf(publicKey)));
        });
    }

    it("unlocks an encrypted PKCS#8 key and stores it unlocked", () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
        const pem = privateKey
            .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "s3cret" })
            .toString();
        expect(sshKeyShape(pem)).toMatchObject({
            kind: "private",
            format: "pkcs8",
            encrypted: true
        });
        const read = readPrivateKey(pem, "s3cret");
        expect(read.passphrase).toBeNull();
        expect(read.fingerprint).toBe(fingerprintOf(blobOf(publicKey)));
        expect(() => readPrivateKey(pem, "nope")).toThrow(SSH_KEY_REFUSALS.wrongPassphrase);
    });

    it("calls a wrong passphrase wrong even when OpenSSL calls it unsupported", () => {
        const { privateKey } = crypto.generateKeyPairSync("ed25519");
        const pem = privateKey
            .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "s3cret" })
            .toString();
        // About one wrong passphrase in 256 decrypts to valid padding, and OpenSSL
        // then reports an unsupported key rather than a bad decrypt.
        let unpadded: string | null = null;
        for (let i = 0; i < 10_000 && unpadded === null; i++) {
            try {
                crypto.createPrivateKey({ key: pem, passphrase: `nope${i}` });
            } catch (error) {
                if ((error as { code?: string }).code !== "ERR_OSSL_BAD_DECRYPT")
                    unpadded = `nope${i}`;
            }
        }
        expect(unpadded).not.toBeNull();
        expect(() => readPrivateKey(pem, unpadded)).toThrow(SSH_KEY_REFUSALS.wrongPassphrase);
    });

    it("converts PuTTY's own RSA files, locked and not", () => {
        const plain = readFileSync(join(fixtures, "ppk_rsa"), "utf8");
        const locked = readFileSync(join(fixtures, "ppk_rsa_enc"), "utf8");
        const expected = utils.parseKey(plain);
        if (expected instanceof Error) throw expected;
        const blob = (Array.isArray(expected) ? expected[0] : expected).getPublicSSH();

        expect(readPrivateKey(plain, null).fingerprint).toBe(fingerprintOf(blob));
        expect(readPrivateKey(locked, "node.js").type).toBe("ssh-rsa");
        expect(() => readPrivateKey(locked, "wrong")).toThrow(SSH_KEY_REFUSALS.wrongPassphrase);
        expect(() => readPrivateKey(locked, null)).toThrow(SSH_KEY_REFUSALS.locked);
    });

    it("converts a PuTTY Ed25519 file, which ssh2 cannot read itself", () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
        const jwk = privateKey.export({ format: "jwk" });
        const ppk = puttyV2(
            "ssh-ed25519",
            [Buffer.from(jwk.x!, "base64url")],
            [Buffer.from(jwk.d!, "base64url")]
        );
        expect(utils.parseKey(ppk)).toBeInstanceOf(Error);
        expect(readPrivateKey(ppk, null).fingerprint).toBe(fingerprintOf(blobOf(publicKey)));
    });
});

describe("what is refused", () => {
    it("says a public key is the wrong half", () => {
        const pair = utils.generateKeyPairSync("ed25519");
        expect(() => readPrivateKey(pair.public, null)).toThrow(SSH_KEY_REFUSALS.publicKey);
    });

    it("says a file that is not a key is not one", () => {
        expect(() => readPrivateKey("hello", null)).toThrow(SSH_KEY_REFUSALS.unknown);
        expect(() =>
            readPrivateKey(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
                null
            )
        ).toThrow();
    });

    it("refuses a PuTTY file whose MAC does not match", () => {
        const plain = readFileSync(join(fixtures, "ppk_rsa"), "utf8");
        const tampered = plain.replace(
            /Private-MAC: ([0-9a-f])/,
            (_all, first: string) => `Private-MAC: ${first === "0" ? "1" : "0"}`
        );
        expect(() => readPrivateKey(tampered, null)).toThrow(SSH_KEY_REFUSALS.unknown);
    });
});

/** An unencrypted PuTTY v2 file, MAC and all, as PuTTYgen writes one. */
function puttyV2(algorithm: string, publicParts: Buffer[], privateParts: Buffer[]): string {
    const string = (value: Buffer | string) => {
        const bytes = typeof value === "string" ? Buffer.from(value) : value;
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return Buffer.concat([length, bytes]);
    };
    const publicBlob = Buffer.concat([string(algorithm), ...publicParts.map(string)]);
    const privateBlob = Buffer.concat(privateParts.map(string));
    const comment = "fixture";
    const macKey = crypto.createHash("sha1").update("putty-private-key-file-mac-key").digest();
    const mac = crypto
        .createHmac("sha1", macKey)
        .update(
            Buffer.concat([
                string(algorithm),
                string("none"),
                string(comment),
                string(publicBlob),
                string(privateBlob)
            ])
        )
        .digest("hex");
    const lines = (blob: Buffer) => blob.toString("base64").match(/.{1,64}/g) ?? [];
    return [
        `PuTTY-User-Key-File-2: ${algorithm}`,
        "Encryption: none",
        `Comment: ${comment}`,
        `Public-Lines: ${lines(publicBlob).length}`,
        ...lines(publicBlob),
        `Private-Lines: ${lines(privateBlob).length}`,
        ...lines(privateBlob),
        `Private-MAC: ${mac}`
    ].join("\n");
}
