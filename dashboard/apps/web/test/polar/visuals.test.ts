/**
 * The views Polar can draw: the catalogue refuses a payload that does not fit
 * it, a formula is parsed and never run as code, and every view reads as
 * Markdown and - when it is a grid - as CSV.
 */

import { describe, expect, it } from "vitest";

const visuals = await import("@/lib/polar/visuals");
const { polarVisualTools } = await import("@/lib/polar/visual-tool");

const table = {
    title: "Plans",
    view: {
        kind: "table",
        columns: [{ label: "Plan" }, { label: "Price" }],
        rows: [
            ["Basic", 5],
            ["Pro | team", 12.5]
        ]
    }
};

describe("the catalogue", () => {
    it("takes each kind it lists", () => {
        const ok = [
            table,
            {
                view: {
                    kind: "chart",
                    type: "bar",
                    categories: ["a", "b"],
                    series: [{ label: "Sales", values: [1, null] }]
                }
            },
            { view: { kind: "stats", items: [{ label: "Uptime", value: "99.9%", tone: "good" }] } },
            { view: { kind: "steps", items: [{ title: "Install" }, { title: "Run", detail: "npm start" }] } },
            {
                view: {
                    kind: "comparison",
                    options: ["A", "B"],
                    rows: [{ label: "Cost", values: ["Low", "High"] }],
                    pick: 0
                }
            },
            {
                view: {
                    kind: "diagram",
                    nodes: [
                        { id: "a", label: "Browser" },
                        { id: "b", label: "Server" }
                    ],
                    edges: [{ from: "a", to: "b", label: "HTTPS" }]
                }
            },
            {
                view: {
                    kind: "calculator",
                    fields: [
                        { id: "price", label: "Price", value: 100 },
                        { id: "tax", label: "Tax", value: 21, unit: "%" }
                    ],
                    outputs: [{ label: "Total", formula: "price * (1 + tax / 100)" }]
                }
            }
        ];
        for (const input of ok) expect(visuals.polarVisualSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    });

    it("refuses what does not fit", () => {
        const bad: unknown[] = [
            { view: { kind: "html", html: "<script>alert(1)</script>" } },
            { view: { kind: "table", columns: [{ label: "A" }], rows: [["x", "too many"]] } },
            { view: { kind: "table", columns: [], rows: [["x"]] } },
            {
                view: {
                    kind: "chart",
                    type: "bar",
                    categories: ["a", "b"],
                    series: [{ label: "S", values: [1] }]
                }
            },
            {
                view: {
                    kind: "chart",
                    type: "pie",
                    categories: ["a"],
                    series: [{ label: "S", values: [1] }]
                }
            },
            { view: { kind: "comparison", options: ["A", "B"], rows: [{ label: "x", values: ["1"] }] } },
            { view: { kind: "comparison", options: ["A", "B"], rows: [{ label: "x", values: ["1", "2"] }], pick: 3 } },
            { view: { kind: "diagram", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] } },
            { view: { kind: "diagram", nodes: [{ id: "a b", label: "A" }], edges: [] } },
            {
                view: {
                    kind: "calculator",
                    fields: [{ id: "x", label: "X", value: 1 }],
                    outputs: [{ label: "Y", formula: "x + y" }]
                }
            },
            {
                view: {
                    kind: "calculator",
                    fields: [{ id: "x", label: "X", value: 1 }],
                    outputs: [{ label: "Y", formula: "constructor.constructor('alert(1)')()" }]
                }
            },
            {
                view: {
                    kind: "calculator",
                    fields: [{ id: "x", label: "X", value: 0, min: 1, max: 10 }],
                    outputs: [{ label: "Y", formula: "x * 2" }]
                }
            },
            {
                view: {
                    kind: "calculator",
                    fields: [{ id: "x", label: "X", value: 5, min: 10, max: 1 }],
                    outputs: [{ label: "Y", formula: "x * 2" }]
                }
            },
            { view: { kind: "stats", items: Array.from({ length: 9 }, () => ({ label: "a", value: "1" })) } },
            { view: { kind: "steps", items: [{ title: "x".repeat(121) }] } }
        ];
        for (const input of bad) expect(visuals.polarVisualSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    });

    it("is an object at the top, so every provider takes it as a tool's parameters", async () => {
        const tool = polarVisualTools()[visuals.POLAR_VISUAL_TOOL]!;
        const schema = await (tool.inputSchema as { jsonSchema: unknown }).jsonSchema;
        expect((schema as { type?: string }).type).toBe("object");
        expect(await tool.execute!(table as never, { toolCallId: "t", messages: [] } as never)).toEqual({
            ok: true,
            text: "Shown to the person."
        });
    });

    it("reads a stored part only when it holds a whole view", () => {
        expect(visuals.isVisualPart({ type: "tool-polar_show" })).toBe(true);
        expect(visuals.isVisualPart({ type: "tool-polar_remember" })).toBe(false);
        expect(visuals.visualOf({ view: { kind: "table" } })).toBeNull();
        expect(visuals.visualPartMarkdown({ type: "tool-polar_show", input: { view: { kind: "nope" } } })).toBe("");
    });
});

describe("formulas", () => {
    const run = (formula: string, values: Record<string, number> = {}) => visuals.calculate(formula, values);

    it("follows the usual precedence", () => {
        expect(run("1 + 2 * 3")).toBe(7);
        expect(run("(1 + 2) * 3")).toBe(9);
        expect(run("-2 ^ 2")).toBe(-4);
        expect(run("2 ^ 3 ^ 2")).toBe(512);
        expect(run("10 % 4")).toBe(2);
        expect(run("max(1, a, 3) + round(b)", { a: 5, b: 1.6 })).toBe(7);
        expect(run("pow(2, 10)")).toBe(1024);
        expect(run("1.5e2")).toBe(150);
    });

    it("has no value where the arithmetic has none", () => {
        expect(run("1 / 0")).toBeNull();
        expect(run("sqrt(-1)")).toBeNull();
    });

    it("refuses anything that is not arithmetic", () => {
        for (const source of ["", "1 +", "(1", "a.b", "eval(1)", "1 2", "x[0]", "'a'", "pow(1)", "round(1, 2)"]) {
            expect(typeof visuals.parseFormula(source), source).toBe("string");
        }
    });
});

describe("as text", () => {
    it("writes a table as a Markdown table, escaping its pipes", () => {
        const markdown = visuals.visualMarkdown(visuals.visualOf(table)!);
        expect(markdown).toBe(
            ["**Plans**", "", "| Plan | Price |", "| --- | --- |", "| Basic | 5 |", "| Pro \\| team | 12.5 |"].join("\n")
        );
    });

    it("writes the other kinds as lists a reader can follow", () => {
        const md = (view: unknown) => visuals.visualMarkdown(visuals.visualOf({ view })!);
        expect(md({ kind: "steps", items: [{ title: "Install" }, { title: "Run", detail: "npm start" }] })).toBe(
            "1. **Install**\n2. **Run** - npm start"
        );
        expect(
            md({
                kind: "diagram",
                nodes: [
                    { id: "a", label: "Browser" },
                    { id: "b", label: "Server" },
                    { id: "c", label: "Alone" }
                ],
                edges: [{ from: "a", to: "b", label: "HTTPS" }]
            })
        ).toBe("- Browser -> Server (HTTPS)\n- Alone");
        expect(
            md({
                kind: "calculator",
                fields: [{ id: "n", label: "Count", value: 4 }],
                outputs: [{ label: "Double", formula: "n * 2" }]
            })
        ).toBe("- Count: 4\n- **Double** = n * 2 = 8");
        expect(md({ kind: "stats", items: [{ label: "Uptime", value: "99.9%", detail: "30 days" }] })).toBe(
            "- **Uptime**: 99.9% (30 days)"
        );
    });

    it("writes a chart's numbers as a table and as CSV", () => {
        const chart = visuals.visualOf({
            view: {
                kind: "chart",
                type: "line",
                categories: ["Jan", "Feb"],
                series: [{ label: "Users", values: [10, null] }],
                unit: "k"
            }
        })!;
        expect(visuals.visualMarkdown(chart)).toContain("| Jan | 10 |");
        expect(visuals.visualCsv(chart.view)).toBe(",Users (k)\r\nJan,10\r\nFeb,");
    });

    it("quotes CSV cells and keeps a spreadsheet from reading one as a formula", () => {
        const csv = visuals.visualCsv(
            visuals.visualOf({
                view: { kind: "table", columns: [{ label: "A" }, { label: "B" }], rows: [["=1+1", 'say "hi", ok']] }
            })!.view
        );
        expect(csv).toBe(`A,B\r\n'=1+1,"say ""hi"", ok"`);
        expect(visuals.visualCsv(visuals.visualOf({ view: { kind: "steps", items: [{ title: "x" }] } })!.view)).toBeNull();
    });
});
