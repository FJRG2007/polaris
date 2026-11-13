import en from "../../src/messages/en.json";
import { describe, expect, it } from "vitest";
import * as api from "../../src/data/api-pages";
import { requestSamples } from "../../src/data/docs";
import type { ApiOperation } from "../../src/data/builders";

const ORIGIN = "https://polaris.example.com";
const SITE = "https://fjrg2007.github.io/polaris/en";

const shared = [
    { status: "401", description: "The key is missing" },
    { status: "404", description: "Not found" }
];
const op = (id: string, extra: Partial<ApiOperation> = {}): ApiOperation => ({
    id,
    method: "GET",
    path: `/api/v1/${id}`,
    tag: "Deploy",
    summary: `Summary of ${id}`,
    description: "",
    parameters: [],
    body: null,
    bodyShapes: [],
    responses: [{ status: "200", description: "OK" }, ...shared],
    ...extra
});

const addDomain = op("addDomain", {
    method: "POST",
    summary: "Add a domain",
    parameters: [
        {
            name: "id",
            in: "path",
            required: true,
            type: "string",
            description: "A service | id",
            constraints: []
        }
    ],
    body: '{\n  "type": "object"\n}',
    bodyShapes: [
        {
            type: "object",
            fields: [
                {
                    name: "targetPort",
                    type: "integer",
                    required: true,
                    description: "",
                    constraints: [{ kind: "minimum", value: "1" }]
                }
            ]
        }
    ],
    responses: [{ status: "201", description: "Created" }, ...shared]
});
const groups: api.ApiGroup[] = [{ tag: "Deploy", operations: [op("listProjects"), addDomain] }];

const input: api.ApiMarkdownInput = {
    groups,
    undocumented: [{ method: "GET", path: "/api/v1/other" }],
    words: en.api,
    origin: ORIGIN,
    samples: (one) => requestSamples(one, ORIGIN),
    link: (path) => `${SITE}/${path}`
};
const pages = api.apiPages(groups, 1);
const markdown = (path: string) => api.apiMarkdown(pages.find((page) => page.path === path)!, input);

describe("the Markdown beside each API page", () => {
    it("is served at the page's path as .md", () => {
        expect(api.markdownPath("docs/api/")).toBe("docs/api.md");
        expect(api.markdownPath("docs/api/deploy/add-domain/")).toBe("docs/api/deploy/add-domain.md");
        expect(api.markdownPath("docs/chat/")).toBe("docs/chat.md");
    });

    it("gives the overview the shared errors once and a link to every call", () => {
        const text = markdown("docs/api/");
        expect(text.startsWith("# API reference\n")).toBe(true);
        expect(text).toContain("| 401 | The key is missing |");
        expect(text).toContain(`[\`POST /api/v1/addDomain\`](${SITE}/docs/api/deploy/add-domain/): Add a domain`);
        expect(text).toContain(`${ORIGIN}/api/v1`);
    });

    it("writes a call out in full: parameters, body fields, examples and its own responses", () => {
        const text = markdown("docs/api/deploy/add-domain/");
        expect(text).toContain("# Add a domain\n\n`POST /api/v1/addDomain`");
        expect(text).toContain("| `id` (required) | path | `string` | A service \\| id |");
        expect(text).toContain("| `targetPort` (required) | `integer` | min: `1` |");
        expect(text).toContain(`curl -X POST "${ORIGIN}/api/v1/addDomain"`);
        expect(text).toContain("| 201 | Created |");
        expect(text).not.toContain("| 401 |");
        expect(text).toContain(`401, 404. (${SITE}/docs/api/#errors)`);
        expect(text.endsWith("\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
    });

    it("lists a group's calls and the routes not documented yet", () => {
        expect(markdown("docs/api/deploy/")).toContain(
            `## [Summary of listProjects](${SITE}/docs/api/deploy/list-projects/)`
        );
        expect(markdown("docs/api/more/")).toContain("- `GET /api/v1/other`");
    });
});
