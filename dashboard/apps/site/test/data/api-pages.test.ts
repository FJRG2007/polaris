import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as api from "../../src/data/api-pages";
import { beforeAll, describe, expect, it } from "vitest";
import { apiOperations, bodyShapes, type ApiOperation } from "../../src/data/builders";

const web = join(__dirname, "..", "..", "..", "web");

/**
 * The OpenAPI document every Polaris serves, built from the dashboard's own
 * module the way the site generator does, so a call added there is checked
 * here without a generated file.
 */
async function realDocument(): Promise<Record<string, unknown>> {
    const out = join(web, "node_modules", ".cache", "polaris-site-test", "openapi.mjs");
    mkdirSync(dirname(out), { recursive: true });
    await build({
        stdin: {
            contents: 'export { buildOpenApi } from "@/lib/api-docs/openapi";',
            resolveDir: web,
            loader: "ts"
        },
        outfile: out,
        bundle: true,
        platform: "node",
        format: "esm",
        tsconfig: join(web, "tsconfig.json"),
        packages: "external",
        logLevel: "silent"
    });
    const mod = (await import(pathToFileURL(out).href)) as {
        buildOpenApi: (origin: string) => Record<string, unknown>;
    };
    return mod.buildOpenApi("https://polaris.example.com");
}

const METHODS = ["get", "post", "put", "patch", "delete"];

describe("the API reference pages, from the real document", () => {
    let doc: Record<string, unknown>;
    let groups: api.ApiGroup[];
    beforeAll(async () => {
        doc = await realDocument();
        groups = apiOperations(doc);
    }, 120_000);

    it("gives every operation in the document a page of its own", () => {
        const paths = doc.paths as Record<string, Record<string, { operationId?: string }>>;
        const ids = Object.values(paths).flatMap((item) =>
            METHODS.filter((method) => item[method]).map((method) => item[method]!.operationId)
        );
        const operationPages = api.apiPages(groups, 1).flatMap((page) =>
            page.kind === "operation" ? [page.operation.id] : []
        );
        expect(ids.length).toBeGreaterThan(0);
        expect(operationPages.sort()).toEqual([...ids].sort());
    });

    it("puts every operation in exactly one group, and every group has a page", () => {
        const pages = api.apiPages(groups, 0);
        const grouped = groups.flatMap((group) => group.operations.map((op) => op.id));
        expect(new Set(grouped).size).toBe(grouped.length);
        for (const group of groups)
            expect(pages.some((page) => page.kind === "group" && page.group === group)).toBe(true);
    });

    it("never gives two pages the same address, and no group takes the reserved one", () => {
        const paths = api.apiPages(groups, 1).map((page) => page.path);
        expect(new Set(paths).size).toBe(paths.length);
        expect(groups.map((group) => api.groupSlug(group.tag))).not.toContain(api.API_MORE_SLUG);
        for (const path of paths) expect(path).toMatch(/^docs\/api\/([a-z0-9-]+\/){0,2}$/);
    });

    it("documents the shared errors once and leaves each call only its own", () => {
        const operations = groups.flatMap((group) => group.operations);
        const common = api.commonResponses(operations);
        expect(common.map((response) => response.status)).toEqual(
            expect.arrayContaining(["400", "401", "403", "404"])
        );
        for (const op of operations) {
            const { own, shared } = api.splitResponses(op, common);
            expect(own.length + shared.length).toBe(op.responses.length);
            for (const response of own)
                expect(
                    common.some(
                        (one) =>
                            one.status === response.status &&
                            one.description === response.description
                    )
                ).toBe(false);
        }
    });

    it("turns every request body into at least one table of fields", () => {
        const withBody = groups.flatMap((group) => group.operations).filter((op) => op.body);
        expect(withBody.length).toBeGreaterThan(0);
        for (const op of withBody) expect(op.bodyShapes.length).toBeGreaterThan(0);
    });
});

describe("addresses and reading order", () => {
    const op = (id: string, tag: string) =>
        ({ id, tag, method: "GET", path: `/${id}`, responses: [] }) as unknown as ApiOperation;
    const groups: api.ApiGroup[] = [
        { tag: "Account", operations: [op("getMe", "Account")] },
        {
            tag: "Deploy",
            operations: [op("getDeployServicesById", "Deploy"), op("postMcp", "Deploy")]
        }
    ];

    it("names pages after the group and the operation id", () => {
        expect(api.groupSlug("Deploy")).toBe("deploy");
        expect(api.groupSlug("Mail & Calendar")).toBe("mail-calendar");
        expect(api.operationSlug({ id: "getDeployServicesById" })).toBe(
            "get-deploy-services-by-id"
        );
        expect(api.apiPath.operation({ id: "getMe", tag: "Account" })).toBe(
            "docs/api/account/get-me/"
        );
    });

    it("reads the overview, then each group followed by its calls, then the extra routes", () => {
        const pages = api.apiPages(groups, 3);
        expect(pages.map((page) => page.path)).toEqual([
            "docs/api/",
            "docs/api/account/",
            "docs/api/account/get-me/",
            "docs/api/deploy/",
            "docs/api/deploy/get-deploy-services-by-id/",
            "docs/api/deploy/post-mcp/",
            "docs/api/more/"
        ]);
        expect(api.apiNeighbors(pages, "docs/api/account/get-me/")).toMatchObject({
            previous: { path: "docs/api/account/" },
            next: { path: "docs/api/deploy/" }
        });
        expect(api.apiNeighbors(pages, "docs/api/").previous).toBeNull();
        expect(api.apiPages(groups, 0).at(-1)?.path).toBe("docs/api/deploy/post-mcp/");
    });
});

describe("request body fields", () => {
    const doc = {
        components: {
            schemas: {
                Port: { type: "integer", minimum: 1, maximum: 65535, description: "Port" }
            }
        }
    };

    it("lists fields with type, required and constraints, following references and nesting", () => {
        const [shape] = bodyShapes(doc, {
            type: "object",
            required: ["hostname"],
            properties: {
                hostname: { type: "string", pattern: "^[a-z]+$" },
                port: { $ref: "#/components/schemas/Port" },
                mode: { type: "string", enum: ["le", "none"], default: "le" },
                tags: { type: "array", items: { type: "string" } },
                params: { type: "object", properties: { cursor: { type: "string" } } }
            }
        });
        expect(shape!.fields.map((field) => [field.name, field.type, field.required])).toEqual([
            ["hostname", "string", true],
            ["port", "integer", false],
            ["mode", "string", false],
            ["tags", "string[]", false],
            ["params", "object", false],
            ["params.cursor", "string", false]
        ]);
        expect(shape!.fields[1]).toMatchObject({
            description: "Port",
            constraints: [
                { kind: "minimum", value: "1" },
                { kind: "maximum", value: "65535" }
            ]
        });
        expect(shape!.fields[2]!.constraints).toEqual([
            { kind: "default", value: "le" },
            { kind: "enum", value: "le, none" }
        ]);
    });

    it("gives a body that is one of several shapes a table per shape", () => {
        const shapes = bodyShapes(doc, {
            anyOf: [
                {
                    type: "object",
                    properties: { id: { anyOf: [{ type: "string" }, { type: "number" }] } }
                },
                { type: "array", items: { type: "object" } }
            ]
        });
        expect(shapes.map((shape) => shape.type)).toEqual(["object", "object[]"]);
        expect(shapes[0]!.fields[0]).toMatchObject({ name: "id", type: "string | number" });
        expect(shapes[1]!.fields).toEqual([]);
        expect(bodyShapes(doc, undefined)).toEqual([]);
    });
});
