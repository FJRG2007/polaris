/**
 * Wildcard certificates over DNS-01: which ones Polaris holds, when each is due,
 * which edge gets which, and the order that proves them.
 *
 * The order is the part with history. A wildcard certificate names two things -
 * `*.example.com` and `example.com` - and both are proven by an answer published
 * at `_acme-challenge.example.com`, at the same time, with different values. The
 * deploy base's wildcard used to rewrite that one record in place, so the second
 * answer replaced the first and the first validation read the wrong value; and it
 * cleared every record at the name when one validation finished, taking the other
 * answer away mid-check. Both are pinned here against a client that behaves the
 * way the real one does: every authorization at once.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => "account-key-pem",
    setSetting: async () => undefined
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_ACME_EMAIL: "" }) }));

vi.mock("acme-client", () => ({
    directory: { letsencrypt: { production: "https://acme.example.test/directory" } },
    crypto: {
        createCsr: async () => [Buffer.from("key-pem"), Buffer.from("csr")],
        createPrivateKey: async () => Buffer.from("account-key-pem")
    },
    Client: class {
        async auto(options: {
            challengeCreateFn: (
                authz: unknown,
                challenge: unknown,
                keyAuthorization: string
            ) => Promise<void>;
            challengeRemoveFn: (
                authz: unknown,
                challenge: unknown,
                keyAuthorization: string
            ) => Promise<void>;
        }) {
            const authorizations = [
                {
                    identifier: { value: "example.test" },
                    wildcard: true,
                    answer: "answer-for-wildcard"
                },
                {
                    identifier: { value: "example.test" },
                    wildcard: false,
                    answer: "answer-for-base"
                }
            ];
            // As the real client does: every authorization in parallel, each one
            // published, validated against what is live, then removed.
            await Promise.all(
                authorizations.map(async (authz) => {
                    const challenge = { type: "dns-01" };
                    await options.challengeCreateFn(authz, challenge, authz.answer);
                    live.push(
                        `checked ${authz.answer}: ${[...records.values()].includes(authz.answer)}`
                    );
                    await options.challengeRemoveFn(authz, challenge, authz.answer);
                })
            );
            return Buffer.from("certificate-pem");
        }
    }
}));

const records = new Map<string, string>();
const live: string[] = [];

const { challengeRecordName, orderDns01Certificate } = await import("@/lib/tls/acme-dns01");
const { remoteCertificatesScript } = await import("@/lib/deploy/router-remote");
const { covers, isDue, plannedCertificates, retryDelayMs, RENEW_BEFORE_MS } = await import(
    "@/lib/tls/managed-cert-plan"
);

describe("the DNS-01 order", () => {
    it("publishes each answer as its own record and removes only its own", async () => {
        records.clear();
        live.length = 0;
        const names: string[] = [];
        let next = 0;
        const provider = {
            kind: "cloudflare" as const,
            present: async (name: string, value: string) => {
                names.push(name);
                const handle = `record-${(next += 1)}`;
                records.set(handle, value);
                return handle;
            },
            cleanup: async (handle: string) => {
                records.delete(handle);
            }
        };
        const issued = await orderDns01Certificate({
            names: ["*.example.test", "example.test"],
            provider,
            settleMs: 0
        });
        expect(issued).toEqual({ certificate: "certificate-pem", key: "key-pem" });
        // Both halves answer at the one name, as two records.
        expect(names).toEqual(["_acme-challenge.example.test", "_acme-challenge.example.test"]);
        // Each validation found its own answer still published.
        expect(live.sort()).toEqual([
            "checked answer-for-base: true",
            "checked answer-for-wildcard: true"
        ]);
        // And nothing is left behind.
        expect(records.size).toBe(0);
    });

    it("puts a wildcard's answer at its base", () => {
        expect(challengeRecordName("*.shop.example.test")).toBe(
            "_acme-challenge.shop.example.test"
        );
        expect(challengeRecordName("example.test")).toBe("_acme-challenge.example.test");
    });
});

describe("which certificates Polaris holds", () => {
    const owner = { userId: "user-1", orgId: null };
    const ownerDomains = [
        { id: "od-1", domain: "example.test", verified: true, ...owner },
        { id: "od-2", domain: "unproven.test", verified: false, ...owner },
        { id: "od-3", domain: "acme.test", verified: true, userId: null, orgId: "org-1" }
    ];

    it("holds one for every verified owner domain, and none for an unproven one", () => {
        const wanted = plannedCertificates({
            ownerDomains,
            wildcardHosts: [],
            deployBase: "plr.example.org"
        });
        expect(wanted).toEqual([
            { domain: "example.test", source: "owner", ownerDomainId: "od-1" },
            { domain: "acme.test", source: "owner", ownerDomainId: "od-3" }
        ]);
    });

    it("leaves the deploy base to its own service", () => {
        const wanted = plannedCertificates({
            ownerDomains: [{ id: "od-9", domain: "plr.example.org", verified: true, ...owner }],
            wildcardHosts: [
                {
                    hostname: "*.plr.example.org",
                    hasUpload: false,
                    ownerId: "user-1",
                    orgId: null,
                    ownerIsAdmin: true
                }
            ],
            deployBase: "plr.example.org"
        });
        expect(wanted).toEqual([]);
    });

    it("covers a wildcard hostname under the service owner's own domain, with that domain's token", () => {
        const wanted = plannedCertificates({
            ownerDomains,
            wildcardHosts: [
                {
                    hostname: "*.shop.example.test",
                    hasUpload: false,
                    ownerId: "user-1",
                    orgId: null,
                    ownerIsAdmin: false
                },
                {
                    hostname: "*.store.acme.test",
                    hasUpload: false,
                    ownerId: "user-2",
                    orgId: "org-1",
                    ownerIsAdmin: false
                }
            ],
            deployBase: null
        });
        expect(wanted).toContainEqual({
            domain: "shop.example.test",
            source: "hostname",
            ownerDomainId: "od-1"
        });
        expect(wanted).toContainEqual({
            domain: "store.acme.test",
            source: "hostname",
            ownerDomainId: "od-3"
        });
    });

    it("never orders in a zone the service owner has no standing over", () => {
        const wanted = plannedCertificates({
            ownerDomains,
            wildcardHosts: [
                // Somebody else's domain.
                {
                    hostname: "*.shop.example.test",
                    hasUpload: false,
                    ownerId: "user-2",
                    orgId: null,
                    ownerIsAdmin: false
                },
                // Nobody's.
                {
                    hostname: "*.elsewhere.test",
                    hasUpload: false,
                    ownerId: "user-2",
                    orgId: null,
                    ownerIsAdmin: false
                },
                // Covered by an upload.
                {
                    hostname: "*.mine.example.test",
                    hasUpload: true,
                    ownerId: "user-1",
                    orgId: null,
                    ownerIsAdmin: false
                }
            ],
            deployBase: null
        });
        expect(wanted.map((entry) => entry.domain)).toEqual(["example.test", "acme.test"]);
    });

    it("lets whoever runs this Polaris cover a wildcard hostname on the instance's own token", () => {
        const wanted = plannedCertificates({
            ownerDomains: [],
            wildcardHosts: [
                {
                    hostname: "*.Apps.Operator.test",
                    hasUpload: false,
                    ownerId: "admin",
                    orgId: null,
                    ownerIsAdmin: true
                }
            ],
            deployBase: null
        });
        expect(wanted).toEqual([
            { domain: "apps.operator.test", source: "hostname", ownerDomainId: null }
        ]);
    });
});

describe("when a certificate is due", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const DAY = 24 * 60 * 60 * 1000;

    it("orders one never issued, and renews one inside its last 30 days", () => {
        expect(isDue({ certPem: null, expiresAt: null, nextAttemptAt: null }, now)).toBe(true);
        const fresh = new Date(now.getTime() + 60 * DAY);
        expect(isDue({ certPem: "pem", expiresAt: fresh, nextAttemptAt: null }, now)).toBe(false);
        const closing = new Date(now.getTime() + RENEW_BEFORE_MS - DAY);
        expect(isDue({ certPem: "pem", expiresAt: closing, nextAttemptAt: null }, now)).toBe(true);
    });

    it("waits out a failure before trying again", () => {
        const later = new Date(now.getTime() + 60_000);
        expect(isDue({ certPem: null, expiresAt: null, nextAttemptAt: later }, now)).toBe(false);
        expect(isDue({ certPem: null, expiresAt: null, nextAttemptAt: now }, now)).toBe(true);
    });

    it("backs off from a quarter of an hour, doubling, to at most a day", () => {
        expect(retryDelayMs(1)).toBe(15 * 60 * 1000);
        expect(retryDelayMs(2)).toBe(30 * 60 * 1000);
        expect(retryDelayMs(3)).toBe(60 * 60 * 1000);
        expect(retryDelayMs(40)).toBe(DAY);
    });
});

describe("which edge gets which certificate", () => {
    it("covers the domain, its wildcard, and exactly one label under it", () => {
        expect(covers("example.test", "example.test")).toBe(true);
        expect(covers("example.test", "*.example.test")).toBe(true);
        expect(covers("example.test", "shop.example.test")).toBe(true);
        expect(covers("example.test", "a.shop.example.test")).toBe(false);
        expect(covers("example.test", "badexample.test")).toBe(false);
    });

    it("writes the files before the list that names them, and removes the rest of its own", () => {
        const script = remoteCertificatesScript(
            [{ id: "c1", certPem: "CERT", keyPem: "KEY" }],
            "n0nce"
        );
        const list = script.indexOf("polaris-managed-certs.yml");
        expect(script.indexOf("polaris-managed-c1.crt")).toBeLessThan(list);
        expect(script.indexOf("polaris-managed-c1.key")).toBeLessThan(list);
        expect(script).toContain(
            "chmod 600 /var/lib/polaris/traefik/dynamic/.polaris-managed-c1.key.n0nce"
        );
        // The payload travels encoded, never as raw text a shell could change.
        expect(script).not.toContain("KEY\n");
        expect(script).toContain(Buffer.from("KEY").toString("base64"));
        expect(script).toContain(
            'case "$(basename "$f")" in polaris-managed-c1.crt|polaris-managed-c1.key|polaris-managed-certs.yml) ;; *) rm -f "$f" ;; esac'
        );
        // The list names the files where that server's edge sees them.
        const yml = Buffer.from(
            [
                "tls:",
                "  certificates:",
                "    - certFile: /dynamic/polaris-managed-c1.crt",
                "      keyFile: /dynamic/polaris-managed-c1.key",
                ""
            ].join("\n")
        ).toString("base64");
        expect(script).toContain(yml);
    });

    it("takes every file of its own away when a server holds none", () => {
        const script = remoteCertificatesScript([], "n0nce");
        expect(script).not.toContain("base64 -d");
        expect(script).toContain("in '') ;; *) rm -f \"$f\" ;; esac");
    });
});
