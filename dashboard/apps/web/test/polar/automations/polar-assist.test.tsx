// @vitest-environment jsdom
/**
 * "Build with Polar" where an automation or a node is added: not drawn for an
 * account Polar is not for, and for one it is, the words go to Polar's panel
 * with the automation and the connection they are about, sent at once.
 * Also the panel's announcement of a finished write, which the canvas refetches on.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const polar = vi.hoisted(() => ({ allowed: true, missing: false, ask: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/polar/polar-reach", () => ({
    usePolarReach: () => (polar.missing ? null : polar)
}));

const { PolarAssist, assistEdgeOf } = await import("@/app/(app)/automations/polar-assist");
const { finishedWrites } = await import("@/lib/polar/tool-changes");

const AUTOMATION = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
    cleanup();
    polar.ask.mockReset();
});

function draw(edge: string | null = null) {
    return render(
        <MessagesWrapper>
            <PolarAssist
                target={{ kind: "nodes", automationId: AUTOMATION, edge: assistEdgeOf(edge) }}
            />
        </MessagesWrapper>
    );
}

describe("Build with Polar", () => {
    it("is not drawn for an account Polar is not for", () => {
        polar.allowed = false;
        const { container } = draw();
        expect(container.querySelector("[data-polar-assist]")).toBeNull();
        polar.allowed = true;
    });

    it("is not drawn where there is no Polar, such as an app's own routes", () => {
        polar.missing = true;
        const { container } = draw();
        expect(container.querySelector("[data-polar-assist]")).toBeNull();
        polar.missing = false;
    });

    it("sends the words with the automation and the connection they go on", async () => {
        draw("start:next>tell");
        fireEvent.click(screen.getByRole("button", { name: "Build with Polar" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "wait five minutes" } });
        fireEvent.click(screen.getByRole("button", { name: "Ask Polar" }));
        await vi.waitFor(() => expect(polar.ask).toHaveBeenCalled());
        const [quote, draft, send] = polar.ask.mock.calls[0]!;
        expect(quote).toBe("");
        expect(send).toBe(true);
        expect(draft).toContain(AUTOMATION);
        expect(draft).toContain("start");
        expect(draft).toContain("tell");
        expect(draft).toContain("wait five minutes");
    });

    it("sends nothing for an empty request", () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: "Build with Polar" }));
        expect(screen.getByRole("button", { name: "Ask Polar" })).toHaveProperty("disabled", true);
    });
});

describe("what the panel announces", () => {
    it("names each successful automations write, and nothing else", () => {
        const found = finishedWrites([
            {
                parts: [
                    {
                        type: "tool-automations_update",
                        toolCallId: "a",
                        state: "output-available",
                        output: { ok: true, data: { automationId: AUTOMATION } }
                    },
                    {
                        type: "tool-automations_update",
                        toolCallId: "b",
                        state: "output-available",
                        output: { ok: false, data: null }
                    },
                    {
                        type: "tool-automations_get",
                        toolCallId: "c",
                        state: "output-available",
                        output: { ok: true, data: { automationId: AUTOMATION } }
                    },
                    {
                        type: "tool-automations_create",
                        toolCallId: "d",
                        state: "approval-requested"
                    }
                ]
            }
        ]);
        expect([...found.keys()]).toEqual(["a"]);
        expect(found.get("a")).toEqual({ tool: "automations_update", automationId: AUTOMATION });
    });
});
