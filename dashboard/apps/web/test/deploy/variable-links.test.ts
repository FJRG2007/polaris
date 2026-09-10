/**
 * What a reference variable points at: resolved the way a deploy resolves it,
 * warned about when nothing in the environment answers to it, and read out of a
 * secret without the secret's own text coming back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const envVarFindMany = vi.fn();
const applicationFindMany = vi.fn();
const applicationFindUnique = vi.fn();
const databaseFindMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        envVar: { findMany: envVarFindMany },
        application: { findMany: applicationFindMany, findUnique: applicationFindUnique },
        managedDatabase: { findMany: databaseFindMany }
    }
}));
// Secrets are "encrypted" here by being kept in the value column behind a flag.
vi.mock("@/lib/deploy/env-values", () => ({
    decryptedValue: (row: { value: string | null; secretText?: string }) => row.secretText ?? row.value
}));

const { variableLinks } = await import("@/lib/deploy/variable-links");

describe("variableLinks", () => {
    beforeEach(() => {
        applicationFindUnique.mockResolvedValue({ environmentId: "env-1" });
        applicationFindMany.mockResolvedValue([
            { id: "api", slug: "api", name: "API" },
            { id: "web", slug: "web", name: "Web" }
        ]);
        databaseFindMany.mockResolvedValue([{ slug: "postgres", name: "Postgres", engine: "postgres" }]);
    });

    it("says what each reference points at, and whether the target has the key", async () => {
        envVarFindMany.mockImplementation(async (query: { where: { scopeType: string; scopeId: unknown } }) => {
            if (query.where.scopeType === "environment") return [{ key: "SENTRY_DSN" }];
            if (typeof query.where.scopeId === "object") return [{ scopeId: "api", key: "API_KEY" }];
            return [
                { id: "v1", isSecret: false, value: "${{postgres.DATABASE_URL}}" },
                { id: "v2", isSecret: true, value: null, secretText: "Bearer ${{api.API_KEY}} sk_live_secret" },
                { id: "v3", isSecret: false, value: "${{shared.MISSING}}" },
                { id: "v4", isSecret: false, value: "${{redis.URL}}" },
                { id: "v5", isSecret: false, value: "plain" }
            ];
        });

        const links = await variableLinks("application", "web");

        expect(links.v1).toEqual([
            {
                written: "${{postgres.DATABASE_URL}}",
                name: "postgres",
                key: "DATABASE_URL",
                target: { kind: "database", label: "Postgres" },
                keyKnown: true
            }
        ]);
        expect(links.v2).toEqual([
            {
                written: "${{api.API_KEY}}",
                name: "api",
                key: "API_KEY",
                target: { kind: "service", label: "API" },
                keyKnown: true
            }
        ]);
        expect(JSON.stringify(links.v2)).not.toContain("sk_live_secret");
        expect(links.v3?.[0]).toMatchObject({ target: { kind: "shared" }, keyKnown: false });
        expect(links.v4?.[0]).toMatchObject({ target: null, keyKnown: false });
        expect(links.v5).toBeUndefined();
    });

    it("reads nothing else when no variable holds a reference", async () => {
        envVarFindMany.mockReset().mockResolvedValue([{ id: "v1", isSecret: false, value: "plain" }]);
        applicationFindMany.mockClear();
        expect(await variableLinks("environment", "env-1")).toEqual({});
        expect(applicationFindMany).not.toHaveBeenCalled();
    });
});
