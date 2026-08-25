/**
 * Certificates an operator supplied for their own domains.
 *
 * Polaris manages TLS for everything it names, which is the right default and not
 * always the right answer: a company with a wildcard it already pays for, a name
 * Polaris cannot order for, an internal CA every device on the network already trusts.
 * So a domain can carry its own certificate, and the edge serves it for that hostname.
 *
 * The judgement of whether to serve it lives in core (`judgeCertificate`) and is
 * deliberately narrow: it is served while it parses, covers the name, and is inside
 * its validity window. A certificate that stops meeting that - the usual case being
 * one that quietly expired - is not served, and the managed certificate takes over
 * again. The upload is kept either way, because replacing it is the operator's move to
 * make and deleting their file for them helps nobody.
 *
 * The private key is encrypted at rest with the master key, like every other secret,
 * and only ever written out into the edge's own directory.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { dynamicDir, writeDynamicFile } from "@/lib/traefik-dynamic";
import { judgeCertificate, type CertificateVerdict } from "@polaris/core";

/** Prefix for every file this writes, so publishing can clear its own and never
 *  anything the local CA or the wildcard put there. */
const PREFIX = "polaris-domain-";
const TLS_FILE = "polaris-domain-certs.yml";

/** The names a certificate is valid for: its SANs, plus the subject CN for the older
 *  certificates that still lean on it. */
function namesOf(certificate: X509Certificate): string[] {
    const names: string[] = [];
    for (const entry of certificate.subjectAltName?.split(",") ?? []) {
        const value = entry.trim();
        if (value.startsWith("DNS:")) names.push(value.slice(4));
    }
    const cn = /CN=([^,\n]+)/.exec(certificate.subject)?.[1]?.trim();
    if (cn && !names.includes(cn)) names.push(cn);
    return names;
}

export interface CertificateReview {
    readonly verdict: CertificateVerdict;
    /** What it is valid for and until, for the panel to show back. */
    readonly names: string[];
    readonly expiresAt: Date | null;
}

/**
 * Parse and judge a supplied certificate and key against a hostname, without storing
 * anything. The same call the save path makes, so what the operator is told when they
 * paste it is exactly what decides whether it gets served.
 */
export function reviewCertificate(
    certPem: string,
    keyPem: string,
    hostname: string,
    now = new Date()
): CertificateReview {
    let certificate: X509Certificate;
    try {
        certificate = new X509Certificate(certPem);
    } catch {
        return {
            verdict: { usable: false, reason: "That does not read as a certificate in PEM form." },
            names: [],
            expiresAt: null
        };
    }
    // The pair has to match, or the edge would present a certificate it cannot prove.
    try {
        if (!certificate.checkPrivateKey(createPrivateKey(keyPem))) {
            return {
                verdict: {
                    usable: false,
                    reason: "That private key does not belong to that certificate."
                },
                names: namesOf(certificate),
                expiresAt: new Date(certificate.validTo)
            };
        }
    } catch {
        return {
            verdict: { usable: false, reason: "That does not read as a private key in PEM form." },
            names: namesOf(certificate),
            expiresAt: new Date(certificate.validTo)
        };
    }
    const names = namesOf(certificate);
    return {
        verdict: judgeCertificate(
            {
                names,
                validFrom: new Date(certificate.validFrom),
                validTo: new Date(certificate.validTo)
            },
            hostname,
            now
        ),
        names,
        expiresAt: new Date(certificate.validTo)
    };
}

/**
 * Store a certificate for a domain, or clear it when `certPem` is empty.
 *
 * Refuses one that would not be served: telling the operator now is the whole point,
 * since the alternative is accepting it and quietly falling back to the managed
 * certificate with nothing on screen to say why.
 */
export async function setDomainCertificate(
    domainId: string,
    ownerId: string,
    input: { certPem: string; keyPem: string } | null
): Promise<{ error?: string; warning?: string }> {
    const domain = await prisma.domain.findFirst({
        where: { id: domainId, application: { environment: { project: { ownerId } } } },
        select: { hostname: true }
    });
    if (!domain) return { error: "Domain not found" };

    if (!input || !input.certPem.trim()) {
        await prisma.domain.update({
            where: { id: domainId },
            data: { certPem: null, certKey: null }
        });
        await publishDomainCertificates();
        return {};
    }

    const review = reviewCertificate(input.certPem, input.keyPem, domain.hostname);
    if (!review.verdict.usable) return { error: review.verdict.reason };

    const sealed = encryptSecret(input.keyPem, loadEnv().POLARIS_MASTER_KEY);
    await prisma.domain.update({
        where: { id: domainId },
        data: {
            certPem: input.certPem,
            certKey: JSON.stringify({
                c: sealed.ciphertext.toString("base64"),
                n: sealed.nonce.toString("base64"),
                k: sealed.keyId
            })
        }
    });
    await publishDomainCertificates();
    return { warning: review.verdict.warning ?? undefined };
}

/** The stored key for a domain, decrypted, or null when it cannot be read. */
function openKey(stored: string): string | null {
    try {
        const { c, n, k } = JSON.parse(stored) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

/**
 * Write every domain certificate that is currently worth serving into the edge's
 * dynamic configuration, and take away the files for the ones that are not.
 *
 * Re-judged on every publish rather than trusted from when it was saved, because the
 * one thing that changes about a certificate without anybody touching it is that it
 * expires. A lapsed one drops out here and the managed certificate serves the name
 * again, which is the failure this is designed to absorb rather than pass on.
 */
export async function publishDomainCertificates(): Promise<void> {
    const rows = await prisma.domain.findMany({
        where: { certPem: { not: null } },
        select: { id: true, hostname: true, certPem: true, certKey: true }
    });

    const dyn = dynamicDir();
    await mkdir(dyn, { recursive: true });

    const entries: string[] = [];
    const written = new Set<string>();
    for (const row of rows) {
        if (!row.certPem || !row.certKey) continue;
        const key = openKey(row.certKey);
        if (!key) continue;
        if (!reviewCertificate(row.certPem, key, row.hostname).verdict.usable) continue;
        const crtName = `${PREFIX}${row.id}.crt`;
        const keyName = `${PREFIX}${row.id}.key`;
        await writeDynamicFile(crtName, row.certPem);
        await writeDynamicFile(keyName, key, { mode: 0o600 });
        written.add(crtName);
        written.add(keyName);
        entries.push(
            `    - certFile: ${join(dyn, crtName)}`,
            `      keyFile: ${join(dyn, keyName)}`
        );
    }

    // Only ever this module's own files: a certificate withdrawn, expired, or whose
    // domain was deleted must stop being served, and nothing else in that directory
    // is ours to remove.
    for (const name of await readdir(dyn).catch(() => [] as string[])) {
        if (!name.startsWith(PREFIX) || written.has(name)) continue;
        await unlink(join(dyn, name)).catch(() => undefined);
    }

    // No certificates means no file. Writing an empty `tls: {}` instead is what the
    // edge refuses outright - "tls cannot be a standalone element" - and it refuses it
    // by failing the whole reload, so every OTHER file in this directory stops being
    // applied too. An instance with no uploaded certificate (the usual one) would then
    // sit on whatever config was loaded at boot, and any router written afterwards
    // would exist on disk and never serve. The clean-up above already removed a stale
    // copy, since this file carries the same prefix as the certificates themselves.
    if (entries.length === 0) return;
    await writeDynamicFile(TLS_FILE, ["tls:", "  certificates:", ...entries, ""].join("\n"));
}
