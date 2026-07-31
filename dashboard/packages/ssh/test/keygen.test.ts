/**
 * The generated key has to be readable by two different parsers that Polaris does
 * not control: ssh2 (which authenticates with the private half) and sshd (which
 * matches the authorized_keys line). Hand-encoding OpenSSH's container is exactly
 * the kind of thing that looks right and fails at 2am on a remote box, so the
 * round trip is asserted rather than assumed.
 */

import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { generateSshKeyPair, publicKeyBlob } from "../src/keygen.js";

describe("generateSshKeyPair", () => {
    it("produces a private key ssh2 can parse", () => {
        const pair = generateSshKeyPair("polaris");
        const parsed = utils.parseKey(pair.privateKey);
        expect(parsed).not.toBeInstanceOf(Error);
        expect((parsed as ReturnType<typeof utils.parseKey> & { type: string }).type).toBe("ssh-ed25519");
    });

    it("emits a public line whose key matches the private half", () => {
        const pair = generateSshKeyPair("polaris");
        const parsed = utils.parseKey(pair.privateKey);
        if (parsed instanceof Error) throw parsed;
        const key = Array.isArray(parsed) ? parsed[0]! : parsed;
        expect(key.getPublicSSH().toString("base64")).toBe(publicKeyBlob(pair.publicKey));
    });

    it("writes an authorized_keys line in the shape sshd expects", () => {
        const pair = generateSshKeyPair("polaris-server-1");
        expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} polaris-server-1$/);
        expect(pair.publicKey).not.toContain("\n");
    });

    it("never repeats a key", () => {
        expect(generateSshKeyPair("a").publicKey).not.toBe(generateSshKeyPair("a").publicKey);
    });
});

describe("publicKeyBlob", () => {
    const line = generateSshKeyPair("root@box").publicKey;
    const blob = line.split(" ")[1]!;

    it("reads the blob out of a host-key line, comment or not", () => {
        expect(publicKeyBlob(line)).toBe(blob);
        expect(publicKeyBlob(`  ssh-ed25519 ${blob}  `)).toBe(blob);
    });

    it("refuses anything that is not a public key line", () => {
        expect(publicKeyBlob("")).toBeNull();
        expect(publicKeyBlob("ssh-ed25519")).toBeNull();
        expect(publicKeyBlob(`not-a-key ${blob}`)).toBeNull();
        expect(publicKeyBlob("ssh-ed25519 not base64!")).toBeNull();
    });

    it("refuses a blob whose algorithm disagrees with the line", () => {
        expect(publicKeyBlob(`ssh-rsa ${blob}`)).toBeNull();
    });

    it("refuses a blob too short to carry an algorithm name", () => {
        expect(publicKeyBlob("ssh-ed25519 AAAA")).toBeNull();
        expect(publicKeyBlob("ssh-ed25519 AA")).toBeNull();
    });
});
