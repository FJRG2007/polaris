/**
 * What publishing certificates leaves in the edge's dynamic directory.
 *
 * The interesting case is the empty one, and it is interesting because of how the edge
 * fails on it: a file holding nothing but `tls: {}` is refused outright ("tls cannot be
 * a standalone element"), and it is refused by failing the reload for the WHOLE
 * directory. So an instance with no uploaded certificate - which is most of them - kept
 * serving whatever config was loaded at boot, and every router written afterwards sat on
 * disk doing nothing. Nothing about the certificates themselves looked wrong; the file
 * that broke the edge was the one saying there were none.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "polaris-cert-publish-"));
const dynamic = mkdtempSync(join(tmpdir(), "polaris-dynamic-"));
process.env.POLARIS_TRAEFIK_DYNAMIC_DIR = dynamic;

/** A self-signed certificate for `cn`. Generated rather than committed, like the
 *  review tests next door: no private key in the repository, nothing to expire. */
function issue(cn: string): { certPem: string; keyPem: string } {
    const keyPath = join(dir, "cert.key");
    const crtPath = join(dir, "cert.crt");
    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", crtPath,
        "-days", "90", "-subj", `/CN=${cn}`,
        "-addext", `subjectAltName=DNS:${cn}`
    ]);
    return { certPem: readFileSync(crtPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
}

const mine = issue("app.example.com");

interface DomainRow {
    id: string;
    hostname: string;
    certPem: string | null;
    certKey: string | null;
}

let rows: DomainRow[] = [];

vi.mock("@polaris/db", () => ({
    prisma: { domain: { findMany: async () => rows } }
}));

// The key travels sealed in the database; here it is stored as itself, so the test
// asserts what gets written rather than re-testing the secret box.
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({ ciphertext: Buffer.from(""), nonce: Buffer.from(""), keyId: "k" }),
    decryptSecret: ({ ciphertext }: { ciphertext: Buffer }) => ciphertext.toString("utf8")
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-master-key" }) }));

const sealed = (keyPem: string): string =>
    JSON.stringify({ c: Buffer.from(keyPem, "utf8").toString("base64"), n: "", k: "k" });

const TLS_FILE = join(dynamic, "polaris-domain-certs.yml");

const { publishDomainCertificates } = await import("@/lib/domain-cert-service");

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dynamic, { recursive: true, force: true });
});

beforeEach(() => {
    rows = [];
});

describe("publishing domain certificates", () => {
    it("writes no file at all when there is nothing to serve", async () => {
        await publishDomainCertificates();
        expect(existsSync(TLS_FILE)).toBe(false);
    });

    it("takes away the file it left behind when the last certificate goes", async () => {
        // A stale `tls: {}` is not merely useless: while it is there the edge applies
        // no dynamic config from this directory at all.
        writeFileSync(TLS_FILE, "tls: {}\n", "utf8");
        await publishDomainCertificates();
        expect(existsSync(TLS_FILE)).toBe(false);
    });

    it("writes the certificate list when there is one to serve", async () => {
        rows = [
            { id: "dom-1", hostname: "app.example.com", certPem: mine.certPem, certKey: sealed(mine.keyPem) }
        ];
        await publishDomainCertificates();
        const written = readFileSync(TLS_FILE, "utf8");
        expect(written).toContain("tls:");
        expect(written).toContain("  certificates:");
        expect(written).toContain("polaris-domain-dom-1.crt");
        expect(written).toContain("polaris-domain-dom-1.key");
        expect(existsSync(join(dynamic, "polaris-domain-dom-1.crt"))).toBe(true);
    });

    it("drops a certificate that no longer parses, and the file with it", async () => {
        rows = [{ id: "dom-2", hostname: "app.example.com", certPem: "not a certificate", certKey: sealed("x") }];
        await publishDomainCertificates();
        expect(existsSync(TLS_FILE)).toBe(false);
        // The previous test's files belong to a domain that is no longer listed.
        expect(existsSync(join(dynamic, "polaris-domain-dom-1.crt"))).toBe(false);
    });
});
