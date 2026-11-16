/**
 * Discovery does not depend on the person's language. A question in Spanish,
 * German or Japanese reaches the right tool - one of Polaris's or one of an
 * outside connector's - by a path that reads no words: the search that finds
 * nothing lists the areas, the area lists its tools, and the tool is loaded by
 * its exact name. The English query the tool's description asks the model to
 * write reaches it in one call.
 */

import { describe, expect, it, vi } from "vitest";
import { toolCategory } from "@/lib/mcp/protocol";
import * as relevance from "@/lib/polar/tool-relevance";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/docker-service", () => ({}));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");

/** Core's real tools, and an outside server's, as the chat's catalog holds
 *  them: a connector's tools sit under the connector's name. */
const catalog: relevance.CatalogEntry[] = [
    ...MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: toolCategory(tool)
    })),
    ...Array.from({ length: 150 }, (_, index) => ({
        name: `mcp_acme__report_${index}`,
        description: `Builds report number ${index}.`,
        category: "Acme Billing"
    })),
    {
        name: "mcp_acme__create_invoice",
        description: "Create invoice. Creates a draft invoice for a customer.",
        category: "Acme Billing"
    }
];

type Answer = {
    tools: { name: string }[];
    areas?: { area: string; count: number; tools: string[] }[];
    listed?: { name: string }[];
    pages?: number;
};

const findTools = relevance.findToolsTool(catalog)[relevance.FIND_TOOLS] as {
    execute: (input: unknown, options: unknown) => Promise<Answer>;
};
const ask = (input: object) => findTools.execute(input, { toolCallId: "f", messages: [] });

/** The word-free path: search, then the area, then the name. */
async function reach(query: string, area: string, target: string): Promise<string[]> {
    const first = await ask({ query });
    if (first.tools.some((entry) => entry.name === target)) {
        expect(first.areas?.map((entry) => entry.area)).toContain(area);
        return relevance.loadedBy(relevance.FIND_TOOLS, first);
    }
    expect(first.areas?.map((entry) => entry.area)).toContain(area);
    const seen: string[] = [];
    for (let page = 0, pages = 1; page < pages; page += 1) {
        const listed = await ask({ area, page });
        expect(listed.tools).toEqual([]);
        pages = listed.pages ?? 1;
        seen.push(...(listed.listed ?? []).map((entry) => entry.name));
    }
    expect(seen).toContain(target);
    return relevance.loadedBy(relevance.FIND_TOOLS, await ask({ names: [target] }));
}

describe("discovery in any language", () => {
    const cases = [
        { lang: "es", query: "créame una tarea para mañana", area: "productivity", target: "tasks_create" },
        { lang: "de", query: "Erstelle eine Aufgabe für morgen", area: "productivity", target: "tasks_create" },
        { lang: "ja", query: "明日のタスクを作って", area: "productivity", target: "tasks_create" },
        { lang: "es", query: "hazle una factura al cliente", area: "Acme Billing", target: "mcp_acme__create_invoice" },
        { lang: "de", query: "Schreib dem Kunden eine Rechnung", area: "Acme Billing", target: "mcp_acme__create_invoice" },
        { lang: "ja", query: "顧客に請求書を作成して", area: "Acme Billing", target: "mcp_acme__create_invoice" }
    ];

    for (const { lang, query, area, target } of cases) {
        it(`reaches ${target} from a question in ${lang}`, async () => {
            expect(await reach(query, area, target)).toContain(target);
        });
    }

    it("reaches both in one call from the English query the model is told to write", async () => {
        const tasks = await ask({ query: "create a task" });
        expect(tasks.tools.map((entry) => entry.name)).toContain("tasks_create");
        const invoice = await ask({ query: "create an invoice" });
        expect(invoice.tools.map((entry) => entry.name)[0]).toBe("mcp_acme__create_invoice");
    });

    it("tells the model to search in English and to browse an area", () => {
        const description = (relevance.findToolsTool(catalog)[relevance.FIND_TOOLS] as {
            description: string;
        }).description;
        expect(description).toMatch(/in English, whatever language/);
        expect(description).toMatch(/`area`/);
    });

    it("never loads a whole area: a server with hundreds of tools is listed, not sent", async () => {
        const listed = await ask({ area: "Acme Billing" });
        expect(relevance.loadedBy(relevance.FIND_TOOLS, listed)).toEqual([]);
        expect(listed.listed!.length).toBeLessThanOrEqual(relevance.AREA_LIST_MAX);
    });
});
