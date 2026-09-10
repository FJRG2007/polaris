/**
 * References between services resolve inside the service's own environment.
 *
 * The case this exists for: a preview environment cloned from production must
 * talk to its own database. A copied literal carries production's address and
 * password; a reference is looked up again wherever it is deployed.
 */

import { describe, expect, it } from "vitest";
import {
    databaseReferenceKeys,
    hasReferences,
    referencesIn,
    resolveReferences
} from "./deploy-references.js";

describe("finding references", () => {
    it("reads the name and key, with or without spaces inside the braces", () => {
        expect(referencesIn("${{postgres.DATABASE_URL}} and ${{ shared.API_KEY }}")).toEqual([
            { name: "postgres", key: "DATABASE_URL", written: "${{postgres.DATABASE_URL}}" },
            { name: "shared", key: "API_KEY", written: "${{ shared.API_KEY }}" }
        ]);
    });

    it("leaves shell-style and single-brace values alone", () => {
        for (const value of ["${HOME}", "$PATH", "{{name}}", "${{}}", "${{.KEY}}", "plain"]) {
            expect(hasReferences(value), value).toBe(false);
        }
    });
});

describe("resolving them", () => {
    const lookup = (values: Record<string, string>) => (name: string, key: string) =>
        values[`${name}.${key}`];

    it("substitutes every reference it can, and keeps the rest of the value", () => {
        const { env, unresolved } = resolveReferences(
            { DATABASE_URL: "${{postgres.DATABASE_URL}}?sslmode=disable", PLAIN: "x" },
            lookup({ "postgres.DATABASE_URL": "postgresql://u:p@db:5432/app" })
        );
        expect(env).toEqual({ DATABASE_URL: "postgresql://u:p@db:5432/app?sslmode=disable", PLAIN: "x" });
        expect(unresolved).toEqual([]);
    });

    it("matches a service name in any case", () => {
        const { env } = resolveReferences({ A: "${{Postgres.HOST}}" }, lookup({ "postgres.HOST": "db" }));
        expect(env.A).toBe("db");
    });

    it("follows a reference to a value that is itself a reference", () => {
        const { env } = resolveReferences(
            { A: "${{api.PUBLIC_URL}}" },
            lookup({ "api.PUBLIC_URL": "https://${{shared.DOMAIN}}", "shared.DOMAIN": "example.test" })
        );
        expect(env.A).toBe("https://example.test");
    });

    it("reports what it could not resolve rather than guessing", () => {
        const { env, unresolved } = resolveReferences({ A: "${{missing.KEY}}" }, lookup({}));
        expect(env.A).toBe("${{missing.KEY}}");
        expect(unresolved).toEqual(["${{missing.KEY}}"]);
    });

    it("stops on a cycle instead of looping", () => {
        const { unresolved } = resolveReferences(
            { A: "${{one.X}}" },
            lookup({ "one.X": "${{two.X}}", "two.X": "${{one.X}}" })
        );
        expect(unresolved.length).toBe(1);
    });
});

describe("what a database answers to", () => {
    it("gives the generic names and the engine's own", () => {
        const keys = databaseReferenceKeys({
            engine: "postgres",
            host: "shop-db-1a2b",
            port: 5432,
            database: "shop",
            username: "polaris",
            password: "secret",
            uri: "postgresql://polaris:secret@shop-db-1a2b:5432/shop"
        });
        expect(keys.DATABASE_URL).toBe("postgresql://polaris:secret@shop-db-1a2b:5432/shop");
        expect(keys.HOST).toBe("shop-db-1a2b");
        expect(keys.PGPORT).toBe("5432");
        expect(keys.REDIS_URL).toBeUndefined();
    });
});
