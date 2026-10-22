import { describe, expect, it } from "vitest";
import type { ApiOperation } from "../../src/data/builders";
import { apiInventory, routeGroup, routeMethods, routePath } from "../../src/data/api-inventory";

describe("a route's address", () => {
    it("drops route groups and names its parameters", () => {
        expect(routePath("(public)/api/v1/projects/[id]/route.ts")).toBe("/api/v1/projects/{id}");
    });

    it("names a catch-all and an optional catch-all by their parameter", () => {
        expect(routePath("api/files/[...path]/route.ts")).toBe("/api/files/{path}");
        expect(routePath("api/files/[[...path]]/route.tsx")).toBe("/api/files/{path}");
    });

    it("is grouped by its first segment after /api and /v1", () => {
        expect(routeGroup("/api/v1/projects/{id}")).toBe("projects");
        expect(routeGroup("/api/deck/state")).toBe("deck");
        expect(routeGroup("/api/{id}")).toBe("other");
    });
});

describe("a route's methods", () => {
    it("reads functions, constants and re-exported handlers", () => {
        const source = [
            "export async function GET() {}",
            "export const POST = handler;",
            "export { handler as PUT, other as DELETE };"
        ].join("\n");
        expect(routeMethods(source).sort()).toEqual(["DELETE", "GET", "POST", "PUT"]);
    });

    it("ignores a method name that is not exported", () => {
        expect(routeMethods("function GET() {}\nconst POST = 1;")).toEqual([]);
    });
});

describe("the public API", () => {
    const keyed =
        "import { authenticateApiKey } from '@/lib/api-keys';\nexport async function GET(req) { await authenticateApiKey(req); }";
    const viaModule =
        'import { deckAuth } from "@/lib/deck/auth";\nexport async function POST() {}';
    const internal =
        'import { auth } from "@/lib/auth";\nexport async function GET() {}\nexport async function DELETE() {}';
    const modules = [
        {
            app: "web",
            specifier: "@/lib/deck/auth",
            source: "export const deckAuth = (r) => requireApiKey(r);"
        },
        { app: "web", specifier: "@/lib/auth", source: "export const auth = () => session();" }
    ];
    const documented: ApiOperation[] = [
        { method: "GET", path: "/api/v1/projects/{id}" } as ApiOperation
    ];

    const { routes, internal: hidden } = apiInventory(
        [
            { app: "web", file: "api/v1/projects/[id]/route.ts", source: keyed },
            { app: "web", file: "api/deck/state/route.ts", source: viaModule },
            { app: "web", file: "api/session/route.ts", source: internal },
            { app: "chat", file: "api/deck/other/route.ts", source: viaModule }
        ],
        modules,
        documented
    );

    it("lists a route that checks a key itself or through a module it imports", () => {
        expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
            "POST /api/deck/state",
            "GET /api/v1/projects/{id}"
        ]);
    });

    it("leaves out a signed-in route, and a module of the same name in another app", () => {
        expect(routes.some((route) => route.path === "/api/session")).toBe(false);
        expect(routes.some((route) => route.path === "/api/deck/other")).toBe(false);
        expect(hidden).toBe(3);
    });

    it("attaches the documented operation when there is one", () => {
        expect(routes.find((route) => route.method === "GET")?.operation).toBe(documented[0]);
        expect(routes.find((route) => route.method === "POST")?.operation).toBeNull();
    });
});
