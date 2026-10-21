// @vitest-environment jsdom

/**
 * A view Polar drew stays inside the message column: the frame never grows
 * past it, a table scrolls sideways in its one box, a tall view folds behind
 * "Show all", a view that throws is shown as its text, the calculator answers
 * as it is typed into, and a shared chat draws the same views.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const chartThrows = { on: false };
vi.mock("@/components/polar/visuals/visual-chart", async (original) => {
    const real = await original<typeof import("@/components/polar/visuals/visual-chart")>();
    return {
        ...real,
        VisualChart: (props: Parameters<typeof real.VisualChart>[0]) => {
            if (chartThrows.on) throw new Error("boom");
            return real.VisualChart(props);
        }
    };
});

const { MessagesWrapper } = await import("../setup/i18n");
const { PolarVisualView, VISUAL_FOLD_PX } = await import("@/components/polar/visuals/visual-view");
const { SharedMessages } = await import("@/components/polar/shared-transcript");
const { layersOf } = await import("@/components/polar/visuals/visual-diagram");
const visuals = await import("@/lib/polar/visuals");

afterEach(() => {
    cleanup();
    chartThrows.on = false;
    vi.restoreAllMocks();
});

function draw(input: unknown) {
    const visual = visuals.visualOf(input);
    expect(visual).not.toBeNull();
    return render(
        <MessagesWrapper>
            <PolarVisualView visual={visual!} />
        </MessagesWrapper>
    );
}

const wide = {
    title: "Many columns",
    view: {
        kind: "table",
        columns: Array.from({ length: 12 }, (_, index) => ({ label: `Column ${index}` })),
        rows: [Array.from({ length: 12 }, (_, index) => index * 1000)]
    }
};

const VIEWS: Record<string, unknown> = {
    table: wide,
    chart: {
        view: {
            kind: "chart",
            type: "bar",
            categories: ["a", "b", "c"],
            series: [{ label: "S", values: [3, -1, null] }]
        }
    },
    timeline: {
        view: {
            kind: "chart",
            type: "line",
            categories: ["2026-01-01", "2026-02-01"],
            series: [{ label: "Users", values: [1, 4] }]
        }
    },
    stats: { view: { kind: "stats", items: [{ label: "Uptime", value: "99.99%", tone: "good" }] } },
    steps: {
        view: { kind: "steps", items: [{ title: "One" }, { title: "Two", detail: "Then this" }] }
    },
    comparison: {
        view: {
            kind: "comparison",
            options: ["A", "B"],
            rows: [{ label: "Cost", values: ["Low", "High"] }],
            pick: 1
        }
    },
    diagram: {
        view: {
            kind: "diagram",
            nodes: [
                { id: "a", label: "Browser" },
                { id: "b", label: "Server" }
            ],
            edges: [{ from: "a", to: "b" }]
        }
    },
    calculator: {
        view: {
            kind: "calculator",
            fields: [{ id: "n", label: "Count", value: 2, min: 0, max: 10 }],
            outputs: [{ label: "Double", formula: "n * 2" }]
        }
    }
};

describe("the frame", () => {
    it.each(Object.keys(VIEWS))(
        "holds %s to the column with no scroll but a sideways one",
        (kind) => {
            const { container } = draw(VIEWS[kind]);
            const figure = container.querySelector("figure")!;
            expect(figure.className).toContain("max-w-full");
            expect(figure.className).toContain("min-w-0");
            expect(figure.className).toContain("overflow-hidden");
            // Nothing scrolls up and down inside the chat's own scroll.
            expect(
                container.querySelector("[class*='overflow-y-auto'], [class*='overflow-auto']")
            ).toBeNull();
            const sideways = container.querySelectorAll("[class*='overflow-x-auto']");
            expect(sideways.length).toBe(["table", "comparison", "diagram"].includes(kind) ? 1 : 0);
        }
    );

    it("scrolls a wide table inside its one box", () => {
        const { container } = draw(wide);
        const table = container.querySelector("table")!;
        expect(table.parentElement!.className).toContain("overflow-x-auto");
        expect(screen.getAllByRole("columnheader")).toHaveLength(12);
        expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
    });

    it("folds a tall view behind Show all, and opens it", () => {
        vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(VISUAL_FOLD_PX * 3);
        const { container } = draw(VIEWS.steps);
        const body = container.querySelector<HTMLElement>("figure > div")!;
        expect(body.style.maxHeight).toBe(`${VISUAL_FOLD_PX}px`);
        fireEvent.click(screen.getByRole("button", { name: "Show all" }));
        expect(body.style.maxHeight).toBe("");
        expect(
            screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")
        ).toBe("true");
    });

    it("copies the view as Markdown", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        draw(VIEWS.steps);
        fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
        await vi.waitFor(() =>
            expect(writeText).toHaveBeenCalledWith("1. **One**\n2. **Two** - Then this")
        );
    });

    it("shows the view's text when drawing it fails", () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        chartThrows.on = true;
        const { container } = draw({
            title: "Sales",
            view: {
                kind: "chart",
                type: "bar",
                categories: ["Jan"],
                series: [{ label: "S", values: [7] }]
            }
        });
        const figure = container.querySelector("figure") as HTMLElement;
        expect(within(figure).getByRole("cell", { name: "Jan" })).toBeTruthy();
        expect(within(figure).getByRole("cell", { name: "7" })).toBeTruthy();
    });
});

describe("the views", () => {
    it("marks the recommended option", () => {
        draw(VIEWS.comparison);
        expect(screen.getByText(/Recommended/).textContent).toContain("B");
    });

    it("draws a diagram as one picture with its nodes", () => {
        const { container } = draw(VIEWS.diagram);
        const svg = container.querySelector("svg[role='img']")!;
        expect(svg.getAttribute("style")).toContain("max-width");
        expect(svg.getAttribute("style")).toContain("min-width");
        expect(svg.parentElement!.className).toContain("overflow-x-auto");
        expect(
            within(svg as unknown as HTMLElement).getAllByText("Browser").length
        ).toBeGreaterThan(0);
    });

    it("lays a loop out without hanging", () => {
        const layers = layersOf({
            kind: "diagram",
            nodes: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
                { id: "c", label: "C" }
            ],
            edges: [
                { from: "a", to: "b" },
                { from: "b", to: "c" },
                { from: "c", to: "a" }
            ]
        });
        expect([layers.get("a"), layers.get("b"), layers.get("c")]).toEqual([0, 1, 2]);
    });

    it("works the calculator out as it is typed into, and says when a value is out of range", () => {
        draw(VIEWS.calculator);
        const field = screen.getByLabelText("Count");
        expect(screen.getByText("4")).toBeTruthy();
        fireEvent.change(field, { target: { value: "5" } });
        expect(screen.getByText("10")).toBeTruthy();
        fireEvent.change(field, { target: { value: "50" } });
        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(screen.getByText("Between 0 and 10")).toBeTruthy();
        expect(screen.getByText("-")).toBeTruthy();
    });

    it("gives a screen reader a chart's values as a table", () => {
        draw(VIEWS.chart);
        const table = screen.getByRole("table", { name: "Chart" });
        expect(within(table).getByRole("rowheader", { name: "a" })).toBeTruthy();
        expect(within(table).getByRole("cell", { name: "3" })).toBeTruthy();
        expect(within(table).getByRole("cell", { name: "-1" })).toBeTruthy();
    });

    it("draws a line over dates with the dashboard's time chart", () => {
        const { container } = draw(VIEWS.timeline);
        expect(container.querySelector("svg")).not.toBeNull();
    });
});

describe("a shared chat", () => {
    it("draws the views of an answer, in order with its words", () => {
        const visual = visuals.visualOf(VIEWS.steps)!;
        render(
            <MessagesWrapper>
                <SharedMessages
                    fileUrl={(id) => `/f/${id}`}
                    messages={[
                        {
                            id: "m",
                            role: "assistant",
                            text: "Do this.\n\n1. **One**",
                            files: [],
                            blocks: [
                                { kind: "text", text: "Do this." },
                                { kind: "visual", visual }
                            ]
                        }
                    ]}
                />
            </MessagesWrapper>
        );
        expect(screen.getByText("Do this.")).toBeTruthy();
        expect(screen.getByText("Then this")).toBeTruthy();
    });
});
