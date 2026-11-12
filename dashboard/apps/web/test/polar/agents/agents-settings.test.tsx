// @vitest-environment jsdom
/**
 * The Agents settings: Save stays off until the agent has a name and
 * instructions, saves what was picked, and every agent starts its own chat.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const saved: unknown[] = [];
const savedDefaults: unknown[] = [];

vi.mock("@/app/(app)/polar/settings/agents-actions", () => ({
    saveAgentAction: async (input: { agent: Record<string, unknown> }) => {
        saved.push(input);
        return { ok: true, value: { id: "0190c6a0-0000-7000-8000-0000000000b1", ...input.agent } };
    },
    deleteAgentAction: async () => ({ ok: true, value: null }),
    saveAgentDefaultAction: async (input: Record<string, unknown>) => {
        savedDefaults.push(input);
        return { ok: true, value: input };
    }
}));

const { PolarAgents, agentChatHref } = await import("@/app/(app)/polar/settings/polar-agents");

// What jsdom does not implement and the pickers call on the way open.
Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined
});

afterEach(cleanup);

describe("the Agents settings", () => {
    it("saves a new agent only once it has a name and instructions", async () => {
        render(
            <PolarAgents
                initial={[]}
                defaults={[]}
                readOnly={false}
                picks={{ skills: ["pdf"], connectors: [], models: [], engines: [] }}
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

    it("sets the account and the models of an agent that comes with Polaris", async () => {
        render(
            <PolarAgents
                initial={[]}
                defaults={[]}
                readOnly={false}
                picks={{ skills: [], connectors: [], models: [], engines: [CLAUDE] }}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("Polar")).toBeTruthy();
        expect(screen.getByText("First that works - Any model")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Edit Claude Code" }));
        const save = screen.getByRole("button", { name: "Save" });
        // Nothing changed yet.
        expect(save.getAttribute("aria-disabled")).toBe("true");
        await choose("Account", "work@example.com");
        await choose("Add a model", "Claude Opus");
        await choose("Add a model", "Claude Sonnet");
        expect(screen.getByText("Preferred")).toBeTruthy();
        // Sonnet first.
        fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1] as HTMLElement);
        fireEvent.click(save);
        await waitFor(() => expect(savedDefaults).toHaveLength(1));
        expect(savedDefaults[0]).toEqual({
            engine: "claude",
            account: ACCOUNT,
            models: [
                { provider: "anthropic", model: "claude-sonnet" },
                { provider: "anthropic", model: "claude-opus" }
            ],
            modelPolicy: "preferred"
        });
        expect(await screen.findByText("work@example.com - Claude Sonnet +1")).toBeTruthy();
    });

    it("runs one of the person's own agents on a coding tool, without Polar's skills", async () => {
        saved.length = 0;
        render(
            <PolarAgents
                initial={[]}
                defaults={[]}
                readOnly={false}
                picks={{ skills: ["pdf"], connectors: [], models: [], engines: [CLAUDE] }}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
        fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Reviewer" } });
        fireEvent.change(screen.getByLabelText("Instructions *"), {
            target: { value: "Review the diff." }
        });
        expect(screen.getByLabelText("pdf")).toBeTruthy();
        await choose("Runs on", "Claude Code");
        // Skills are Polar's; a tool works on its own.
        expect(screen.queryByLabelText("pdf")).toBeNull();
        await choose("Add a model", "Claude Opus");
        fireEvent.click(screen.getByRole("switch", { name: "Only these models" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0]).toMatchObject({
            agent: {
                name: "Reviewer",
                engine: "claude",
                account: null,
                models: [{ provider: "anthropic", model: "claude-opus" }],
                modelPolicy: "required"
            }
        });
        // It starts a Code task, not a chat.
        const start = await screen.findByRole("link", { name: "New task" });
        expect(start.getAttribute("href")).toBe("/polar?session=new");
    });
});

const ACCOUNT = "0190c6a0-0000-7000-8000-0000000000a1";

const CLAUDE = {
    engine: "claude",
    name: "Claude Code",
    modelSource: "own" as const,
    accounts: [
        {
            key: "claude:machine",
            kind: "machine" as const,
            label: null,
            accountId: null,
            machine: true,
            mine: null,
            readiness: "ready" as const
        },
        {
            key: `claude:${ACCOUNT}`,
            kind: "subscription" as const,
            label: "work@example.com",
            accountId: ACCOUNT,
            machine: false,
            mine: true,
            readiness: "ready" as const
        }
    ],
    catalogue: [
        { provider: "anthropic", model: "claude-opus", name: "Claude Opus" },
        { provider: "anthropic", model: "claude-sonnet", name: "Claude Sonnet" }
    ]
};

/** Picks an option of the select a label names. */
async function choose(label: string, option: string) {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name: option }));
}
