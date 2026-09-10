/**
 * A set of evidence readings for an invented instance, with every field set, so
 * a test changes only the one it is about.
 */

import type { EvidenceReadings } from "@/lib/compliance/evidence";

export const NOW = new Date("2026-09-10T12:00:00.000Z");

export function readings(overrides: Partial<EvidenceReadings> = {}): EvidenceReadings {
    return {
        now: NOW,
        instance: { url: "https://polaris.example.com", build: "abc123def456" },
        authentication: {
            policy: {
                requireSecondFactor: true,
                acceptedFactors: ["totp", "email"],
                challengeConnectionSignIn: false
            },
            mailReady: true,
            accounts: 12,
            withSecondFactor: 12,
            withPasskey: 3,
            minPasswordLength: 10
        },
        sessions: {
            maxAgeSeconds: 604_800,
            updateAgeSeconds: 86_400,
            accounts: 12,
            shorterLifetime: 2,
            idleLock: 1,
            clientBindingOff: 1,
            addressPinned: 4,
            loginApproval: 0,
            open: 17
        },
        administrators: [
            { id: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", secondFactor: true },
            { id: "00000000-0000-4000-8000-000000000002", name: "Bo Operator", secondFactor: true }
        ],
        audit: {
            retention: { notifications: 30, activity: 365, audit: 365 },
            sealed: 5000,
            pending: 0,
            head: { seq: "5000", hash: "f".repeat(64) },
            lastVerification: {
                at: "2026-09-10T03:00:00.000Z",
                ok: true,
                checked: 5000,
                broken: null
            }
        },
        backups: {
            total: 1,
            scheduled: 1,
            failing: 0,
            withCopy: 1,
            encrypted: 1,
            activeKeys: 1,
            items: [
                {
                    id: "00000000-0000-4000-8000-0000000000b1",
                    name: "Polaris database",
                    kind: "polaris-database",
                    status: "active",
                    every: "daily",
                    lastSuccessAt: "2026-09-10T02:00:00.000Z",
                    lastStatus: "ok",
                    sealed: 2,
                    clear: 0
                }
            ]
        },
        secrets: { secretEncrypted: 40, secretClear: 0, plainVariables: 90, runnerSecrets: 5 },
        tls: {
            domains: 10,
            letsEncrypt: 8,
            internalCa: 2,
            plainHttp: 0,
            uploaded: 1,
            managed: {
                issued: 2,
                pending: 0,
                failed: 0,
                expiries: ["2026-12-01T00:00:00.000Z", "2026-11-20T00:00:00.000Z"]
            }
        },
        firewall: {
            instancePacks: 6,
            instanceDefaults: true,
            polarisPacks: 9,
            polarisDefaults: false,
            scopes: 3,
            customRules: 4,
            denyEntries: 12,
            allowScopes: 1,
            loginScopes: 1,
            injectionOffScopes: 0,
            activeBans: 7
        },
        edge: {
            services: 10,
            rateLimited: 3,
            rateRules: 5,
            concurrencyCapped: 1,
            challenged: 2,
            headers: { off: 5, recommended: 4, strict: 1 },
            customHeaders: 2
        },
        changes: {
            authentication: {
                at: "2026-09-01T09:30:00.000Z",
                action: "instance.security.updated",
                actorId: "00000000-0000-4000-8000-000000000001",
                actorName: "Ada Admin",
                actorExists: true
            },
            sessions: null,
            administrators: null,
            audit: null,
            backups: null,
            secrets: null,
            tls: null,
            firewall: null,
            "rate-limits": null,
            headers: null
        },
        ...overrides
    };
}
