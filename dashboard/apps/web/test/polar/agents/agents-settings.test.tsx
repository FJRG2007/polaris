// @vitest-environment jsdom
/**
 * The Agents settings: Save stays off until the agent has a name and
 * instructions, saves what was picked, and every agent starts its own chat.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const saved: unknown[] = [];

vi.mock("@/app/(app)/polar/settings/agents-actions", () => ({
    saveAgentAction: async (input: { agent: Record<string, unknown> }) => {
        saved.push(input);
        return { ok: true, value: { id: "0190c6a0-0000-7000-8000-0000000000b1", ...input.agent } };
    },
    deleteAgentAction: async () => ({ ok: true, value: null })
}));

const { PolarAgents, agentChatHref } = await import("@/app/(app)/polar/settings/polar-agents");

afterEach(cleanup);

describe("the Agents settings", () => {
    it("saves a new agent only once it has a name and instructions", async () => {
        render(
            <PolarAgents
                initial={[]}
                readOnly={false}
                picks={{ skills: ["pdf"], connectors: [], models: [] }}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Sales" } });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByLabelText("Instructions *"), {
            target: { value: "Qualify leads." }
        });
        fireEvent.click(screen.getByLabelText("pdf"));
        expect(save.getAttribute("aria-disabled")).toBe("false");
        fireEvent.click(save);
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0]).toMatchObject({
            id: null,
            agent: { name: "Sales", instructions: "Qualify leads.", skills: ["pdf"], choice: null }
        });
        expect(await screen.findByRole("link", { name: "Chat" })).toBeTruthy();
    });

    it("starts a chat with the agent", () => {
        expect(agentChatHref("abc")).toBe("/polar?new=1&agent=abc");
    });
});
