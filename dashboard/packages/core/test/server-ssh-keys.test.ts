import { describe, expect, it } from "vitest";
import {
    addServerKeysSchema,
    generateServerKeySchema,
    removeServerKeySchema,
    serverLoginSchema,
    sshPublicKeySchema
} from "../src/index";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC6nfRyrF9ZLkhQiv1Ro3kMlqLi+nRMTsd23qHItoXrp you@laptop";
const HOST = "6f1c1f5e-5b7a-4c3e-9a51-0a2b3c4d5e6f";

describe("server key schemas", () => {
    it("accepts a pasted public key and normalizes its spacing", () => {
        expect(sshPublicKeySchema.parse(`  ${KEY.replace(" ", "\t ")}  `)).toBe(KEY);
    });

    it("refuses what is not one public key line", () => {
        expect(sshPublicKeySchema.safeParse("").success).toBe(false);
        expect(sshPublicKeySchema.safeParse("hello world").success).toBe(false);
        expect(sshPublicKeySchema.safeParse(`${KEY}\nssh-rsa AAAA evil`).success).toBe(false);
        expect(sshPublicKeySchema.safeParse(`command="rm -rf /" ${KEY}`).success).toBe(false);
        expect(sshPublicKeySchema.safeParse("-----BEGIN OPENSSH PRIVATE KEY-----").success).toBe(false);
    });

    it("holds the login to a POSIX name, so it cannot carry shell", () => {
        expect(serverLoginSchema.parse("deploy")).toBe("deploy");
        for (const bad of ["Root", "a b", "x;rm", "$(id)", "'q'", "-n", ""]) {
            expect(serverLoginSchema.safeParse(bad).success).toBe(false);
        }
    });

    it("checks the host, the fingerprint and the label", () => {
        expect(addServerKeysSchema.safeParse({ hostId: HOST, login: "root", keys: [KEY] }).success).toBe(true);
        expect(addServerKeysSchema.safeParse({ hostId: HOST, login: "root", keys: [] }).success).toBe(false);
        expect(addServerKeysSchema.safeParse({ hostId: "h1", login: "root", keys: [KEY] }).success).toBe(false);
        const fingerprint = "SHA256:ldyE9kHjXMW/ahlFok/HS1FocCoEh2wAhdwTchkT2Ik";
        expect(removeServerKeySchema.safeParse({ hostId: HOST, login: "root", fingerprint }).success).toBe(true);
        expect(removeServerKeySchema.safeParse({ hostId: HOST, login: "root", fingerprint: "MD5:aa" }).success).toBe(false);
        expect(generateServerKeySchema.parse({ hostId: HOST, login: "root" }).label).toBe("");
        expect(generateServerKeySchema.safeParse({ hostId: HOST, login: "root", label: "a'b" }).success).toBe(false);
    });
});
