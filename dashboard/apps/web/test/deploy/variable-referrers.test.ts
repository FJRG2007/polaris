import { describe, expect, it } from "vitest";
import { referrers, type ReferrerService } from "@/lib/deploy/variable-referrers";

const service = (id: string, variables: Record<string, string>): ReferrerService => ({
    id,
    names: [id],
    variables
});

describe("the services a rotated value has to reach", () => {
    it("finds a service reading the changed key, and not one reading another", () => {
        const found = referrers(
            [
                service("api", { API_KEY: "k1" }),
                service("web", { KEY: "${{api.API_KEY}}" }),
                service("worker", { OTHER: "${{api.PORT}}" })
            ],
            {},
            [{ name: "api", key: "API_KEY" }]
        );
        expect(found).toEqual({ ids: ["web"], everyone: false });
    });

    it("follows a reference of a reference", () => {
        const found = referrers(
            [
                service("db", { PASSWORD: "p" }),
                service("api", { URL: "postgres://u:${{db.PASSWORD}}@db/app" }),
                service("web", { API: "${{api.URL}}" })
            ],
            {},
            [{ name: "db", key: "PASSWORD" }]
        );
        expect(found.ids.sort()).toEqual(["api", "web"]);
    });

    it("reaches every service when a shared variable reads it", () => {
        const found = referrers(
            [service("api", { API_KEY: "k" }), service("web", {}), service("cron", {})],
            { KEY: "${{api.API_KEY}}" },
            [{ name: "api", key: "API_KEY" }]
        );
        expect(found.everyone).toBe(true);
        expect(found.ids.sort()).toEqual(["api", "cron", "web"]);
    });

    it("finds nothing when nothing reads it", () => {
        expect(
            referrers([service("web", { PLAIN: "x" })], { ALSO: "y" }, [
                { name: "api", key: "API_KEY" }
            ])
        ).toEqual({ ids: [], everyone: false });
    });

    it("stops on a cycle", () => {
        const found = referrers(
            [service("a", { X: "${{b.Y}}" }), service("b", { Y: "${{a.X}}" })],
            {},
            [{ name: "a", key: "X" }]
        );
        expect(found.ids.sort()).toEqual(["a", "b"]);
    });
});
