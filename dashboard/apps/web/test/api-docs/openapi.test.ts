import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DOCUMENTED_ROUTES, matchDocumentedRoute } from "@/lib/api-docs/routes";
import { PLACEHOLDER_KEY, buildOpenApi, curlExample, operationId, pathParams } from "@/lib/api-docs/openapi";

const APP = join(__dirname, "../../src/app");
/** What a route file does to accept a key: authenticate one itself, or go through a wrapper that does. */
const KEYED = /requireApiKey\(|authenticateApiKey\(|deployRoute\(|variableRoutes\(|importRoute\(/;

function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return routeFiles(path);
        return name === "route.ts" ? [relative(APP, path).split(sep).join("/")] : [];
    });
}

describe("the API reference", () => {
    const doc = buildOpenApi("https://polaris.example.test");

    it("documents only routes that accept an API key, with the method the file exports", () => {
        for (const route of DOCUMENTED_ROUTES) {
            const source = readFileSync(join(APP, route.file), "utf8");
            expect(source, route.file).toMatch(KEYED);
            const exported = [...source.matchAll(/export (?:const|async function) (\{[^}]*\}|[A-Z]+)/g)].map((m) => m[1]!);
            expect(exported.join(" "), `${route.method} ${route.file}`).toContain(route.method);
        }
    });

    it("documents every route under /api/v1", () => {
        const documented = new Set(DOCUMENTED_ROUTES.map((route) => route.file));
        for (const file of routeFiles(join(APP, "api/v1"))) expect(documented, file).toContain(file);
    });

    it("maps each path template onto the route file's folders", () => {
        for (const route of DOCUMENTED_ROUTES) {
            const folders = route.path.replace(/^\//, "").replace(/\{([^}]+)\}/g, "[$1]");
            expect(route.file).toBe(`${folders}/route.ts`);
        }
    });

    it("is an OpenAPI 3.1 document with unique operation ids and every path parameter declared", () => {
        expect(doc.openapi).toBe("3.1.0");
        expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
        const ids = DOCUMENTED_ROUTES.map(operationId);
        expect(new Set(ids).size).toBe(ids.length);
        const paths = doc.paths as Record<string, Record<string, { parameters: { name: string; in: string }[]; responses: object; security: unknown }>>;
        for (const route of DOCUMENTED_ROUTES) {
            const op = paths[route.path]![route.method.toLowerCase()]!;
            const declared = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
            expect(declared).toEqual(pathParams(route.path));
            expect(Object.keys(op.responses)).toContain("401");
            expect(op.security).toEqual([{ apiKey: [] }]);
        }
    });

    it("carries the request schemas the routes parse with", () => {
        const paths = doc.paths as Record<string, Record<string, any>>;
        const body = paths["/api/v1/deploy/services/{id}/variables"]!.post.requestBody.content["application/json"].schema;
        expect(body.required).toEqual(["key", "value"]);
        expect(body.properties.secret).toMatchObject({ type: "boolean", default: true });
        expect(body.properties.key.pattern).toBe("^[A-Za-z_][A-Za-z0-9_]*$");
        const tail = paths["/api/v1/deploy/services/{id}/logs"]!.get.parameters.find((p: any) => p.name === "tail");
        expect(tail).toMatchObject({ required: false, schema: { type: "integer", minimum: 1, maximum: 5000, default: 500 } });
    });

    it("uses the placeholder key in every example, never anything resembling a real one", () => {
        for (const route of DOCUMENTED_ROUTES) {
            const curl = curlExample(route, "https://polaris.example.test");
            expect(curl).toContain(`Bearer ${PLACEHOLDER_KEY}`);
            expect(curl).toContain(`-X ${route.method}`);
        }
    });

    it("files a request under its template, a literal segment before a parameter", () => {
        expect(matchDocumentedRoute("get", "/api/v1/deploy/services/abc/env")?.path).toBe("/api/v1/deploy/services/{id}/env");
        expect(matchDocumentedRoute("GET", "/api/v1/deploy/services")?.path).toBe("/api/v1/deploy/services");
        expect(matchDocumentedRoute("PUT", "/api/v1/deploy/services/a/env/KEY")?.path).toBe("/api/v1/deploy/services/{id}/env/{name}");
        expect(matchDocumentedRoute("GET", "/api/v1/nothing")).toBeNull();
    });
});
