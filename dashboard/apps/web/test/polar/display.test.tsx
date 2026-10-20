// @vitest-environment jsdom

/**
 * What a chat shows follows the person's switches: each one hides its own
 * piece entirely, the hover splits the tokens only into what the provider
 * reported, a switch is put back when the server refuses it, and a chat's
 * total comes from its own usage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { MessagesWrapper } = await import("../setup/i18n");
const display = await import("@/components/polar/polar-display");
const { ChatSpend, ContextBar } = await import("@/components/polar/polar-context");
const { POLAR_DISPLAY_DEFAULTS } = await import("@/lib/polar/display");

let saved: "ok" | "refused" = "ok";

beforeEach(() => {
    saved = "ok";
    display.polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: { method?: string }) => {
            if (url === "/api/polar/preferences" && init?.method === "PATCH") {
                return new Response("{}", { status: saved === "ok" ? 200 : 500 });
            }
            if (url === "/api/polar/preferences") {
                return new Response(JSON.stringify(display.polarDisplayStore.get()), {
                    status: 200
                });
            }
            if (url.endsWith("/usage")) {
                return new Response(
                    JSON.stringify({
                        answers: 2,
                        inputTokens: 900,
                        outputTokens: 100,
                        costUsd: 0.5,
                        unpriced: 0
                    }),
                    { status: 200 }
                );
            }
            return new Response("{}", { status: 404 });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const spent = {
    input: 900,
    output: 100,
    cached: 600,
    reasoning: null,
    cost: 0.5
};

function line() {
    return render(
        <MessagesWrapper>
            <p data-testid="line">
                <display.AnswerSpendLine spent={spent} />
            </p>
        </MessagesWrapper>
    );
}

const tokens = () => document.querySelector("[data-polar-spend='tokens']");
const cost = () => document.querySelector("[data-polar-spend='cost']");

describe("the line under an answer", () => {
    it("shows tokens and cost by default, split on hover into what was reported", () => {
        line();
        expect(tokens()?.textContent).toContain("1,000");
        expect(cost()).not.toBeNull();
        const hover = tokens()?.getAttribute("title") ?? "";
        expect(hover).toContain("900");
        expect(hover).toContain("600");
        expect(hover).toContain("100");
        // No reasoning count was reported, so the hover names none.
        expect(hover.split("\n")).toHaveLength(3);
    });

    it("hides the tokens when that switch is off", () => {
        display.polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS, showTokens: false });
        line();
        expect(tokens()).toBeNull();
        expect(cost()).not.toBeNull();
    });

    it("hides the cost when that switch is off", () => {
        display.polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS, showCost: false });
        line();
        expect(tokens()).not.toBeNull();
        expect(cost()).toBeNull();
    });

    it("leaves nothing when both are off", () => {
        display.polarDisplayStore.set({
            ...POLAR_DISPLAY_DEFAULTS,
            showTokens: false,
            showCost: false
        });
        line();
        expect(screen.getByTestId("line").textContent).toBe("");
    });

    it("reads an answer's spend only when it carries both counts", () => {
        expect(display.answerSpendOf({ inputTokens: 1 })).toBeNull();
        expect(display.answerSpendOf(undefined)).toBeNull();
        expect(
            display.answerSpendOf({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3 })
        ).toEqual({ input: 1, output: 2, cached: null, reasoning: 3, cost: null });
    });
});

describe("the settings switches", () => {
    function settings() {
        return render(
            <MessagesWrapper>
                <display.DisplaySettings />
            </MessagesWrapper>
        );
    }

    it("turn at once and stay turned when the server agrees", async () => {
        settings();
        const toggle = screen.getAllByRole("switch")[1] as HTMLElement;
        await act(async () => {
            fireEvent.click(toggle);
        });
        expect(display.polarDisplayStore.get().showCost).toBe(false);
        expect(fetch).toHaveBeenCalledWith(
            "/api/polar/preferences",
            expect.objectContaining({ method: "PATCH", body: JSON.stringify({ showCost: false }) })
        );
    });

    it("are put back when the server refuses", async () => {
        saved = "refused";
        expect(await display.changePolarDisplay("autoCompact", false)).toBe(false);
        expect(display.polarDisplayStore.get().autoCompact).toBe(true);
    });
});

describe("a chat's total", () => {
    it("sums the chat's answers", async () => {
        render(
            <MessagesWrapper>
                <ChatSpend threadId="11111111-1111-4111-8111-111111111111" />
            </MessagesWrapper>
        );
        await waitFor(() =>
            expect(document.querySelector("[data-polar-chat-spend]")?.textContent).toContain(
                "1,000"
            )
        );
    });

    it("has spent nothing when the chat is not saved", () => {
        render(
            <MessagesWrapper>
                <ChatSpend threadId={null} />
            </MessagesWrapper>
        );
        expect(document.querySelector("[data-polar-chat-spend]")).toBeNull();
        expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/usage"));
    });
});

describe("the context bar", () => {
    function bar(used: number, onCompact = vi.fn()) {
        render(
            <MessagesWrapper>
                <ContextBar used={used} draft={40} window={1000} canCompact onCompact={onCompact} />
            </MessagesWrapper>
        );
        return onCompact;
    }

    it("shows how full the context is, with the numbers on hover", () => {
        bar(460);
        const meter = screen.getByRole("meter");
        expect(meter.getAttribute("aria-valuenow")).toBe("50");
        expect(meter.getAttribute("aria-valuetext")).toContain("1,000");
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("hides itself entirely when that switch is off", () => {
        display.polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS, showContextBar: false });
        bar(460);
        expect(document.querySelector("[data-polar-context-bar]")).toBeNull();
    });

    it("says the chat no longer fits and offers Compact", () => {
        const onCompact = bar(990);
        expect(screen.getByRole("status")).toBeTruthy();
        fireEvent.click(screen.getByRole("button"));
        expect(onCompact).toHaveBeenCalledOnce();
    });

    it("draws nothing for a model whose window is unknown", () => {
        render(
            <MessagesWrapper>
                <ContextBar used={10} draft={0} window={null} canCompact onCompact={vi.fn()} />
            </MessagesWrapper>
        );
        expect(document.querySelector("[data-polar-context-bar]")).toBeNull();
    });
});
