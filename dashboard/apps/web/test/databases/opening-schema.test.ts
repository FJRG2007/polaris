/**
 * Which schema a database opens on, and why only one place may decide it.
 *
 * The regression this exists for was not the mislabel it looked like. The screen
 * chose `public` for its selector while the server had read its relations from
 * whichever schema sorted first - so the box named one schema and listed
 * another's tables, and opening one of those tables asked for it under the name
 * in the box. Where a table of that name existed in both, that is rows from the
 * wrong schema with nothing on screen saying so.
 *
 * So the choice lives here, the server makes it, and `browse` returns the schema
 * it actually read from. The test that matters most is the last one: the answer
 * that comes back has to be the answer the relations came from, whatever was
 * asked for.
 */

import { describe, expect, it, vi } from "vitest";
import { openingNamespace, type DataNamespace } from "@/lib/data/driver";

function schemas(...names: string[]): DataNamespace[] {
    return names.map((name) => ({ name, count: null }) as DataNamespace);
}

describe("choosing a schema to open on", () => {
    it("prefers public, wherever it sorts", () => {
        // The whole case: Postgres hands back information_schema first, and it
        // is never what anybody came to look at.
        expect(openingNamespace(schemas("information_schema", "pg_catalog", "public"))).toBe("public");
    });

    it("skips the engine's own bookkeeping when there is no public", () => {
        expect(openingNamespace(schemas("information_schema", "pg_catalog", "shop"))).toBe("shop");
        expect(openingNamespace(schemas("mysql", "performance_schema", "sys", "app"))).toBe("app");
    });

    it("takes the first one rather than nothing when they are all the engine's", () => {
        // A role that can only see the catalogues still gets a list to look at,
        // which is better than an empty pane with no way to tell why.
        expect(openingNamespace(schemas("information_schema", "pg_catalog"))).toBe("information_schema");
    });

    it("answers null for a database with no schemas at all", () => {
        expect(openingNamespace([])).toBeNull();
    });
});

describe("what browse hands back", () => {
    it("names the schema the relations actually came from", async () => {
        // The regression, stated as a test: whatever it picked, the name it
        // returns and the relations it returns have to be the same schema.
        const relations = vi.fn(async (namespace: string) => [
            { name: `${namespace}_table`, namespace, rows: null } as never
        ]);
        vi.doMock("@/lib/data/open", () => ({
            withDriver: async (_address: unknown, work: (driver: unknown) => Promise<unknown>) =>
                work({
                    shape: "sql",
                    namespaces: async () => schemas("information_schema", "public"),
                    relations
                })
        }));
        vi.doMock("@/lib/data/connections", () => ({
            addressOf: async () => ({ engine: "postgres", readOnly: false })
        }));

        const { browse } = await import("@/lib/data/browser");
        const result = await browse("user-1", "connection-1", null);

        expect(result.namespace).toBe("public");
        expect(relations).toHaveBeenCalledWith("public");
        expect(result.relations[0]?.name).toBe("public_table");
        vi.doUnmock("@/lib/data/open");
        vi.doUnmock("@/lib/data/connections");
    });
});
