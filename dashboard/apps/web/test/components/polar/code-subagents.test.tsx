// @vitest-environment jsdom

/**
 * The Code thread's subagent tree: one row per subagent with its description,
 * type, status and step count, opened to its tool steps, and a Stop only on a
 * running one for somebody who may steer the session.
 */

import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CodeSubagents } from "@/components/polar/polar-code-subagents";
import type { PolarCodeSubagent } from "@/lib/polar/code";

const NOW = Date.now();

const nodes: PolarCodeSubagent[] = [
    {
        id: "a1",
        agentId: "a1",
        toolUseId: "toolu_1",
        type: "Explore",
        description: "Find the API routes",
        status: "done",
        startedAt: NOW - 65_000,
        endedAt: NOW - 1_000,
        steps: [
            { tool: "Grep", id: "toolu_g", status: "done", startedAt: NOW - 60_000, endedAt: NOW - 58_000 },
            { tool: "Read", id: "toolu_r", status: "failed", startedAt: NOW - 50_000, endedAt: NOW - 49_000 }
        ]
    },
    {
        id: "a2",
        agentId: "a2",
        toolUseId: "toolu_2",
        type: "Plan",
        description: "",
        status: "running",
        startedAt: NOW - 3_000,
        endedAt: null,
        steps: []
    }
];

afterEach(cleanup);

describe("CodeSubagents", () => {
    it("draws nothing without subagents", () => {
        const { container } = render(<CodeSubagents subagents={[]} onStop={null} />, { wrapper: MessagesWrapper });
        expect(container.textContent).toBe("");
    });

    it("lists each subagent and opens one to its steps", async () => {
        render(<CodeSubagents subagents={nodes} onStop={null} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("1 running")).toBeTruthy();
        expect(screen.getByText("Find the API routes")).toBeTruthy();
        expect(screen.getByText("Explore")).toBeTruthy();
        expect(screen.getByText("1m 4s")).toBeTruthy();
        expect(screen.getByText("2 steps")).toBeTruthy();
        expect(screen.getByText("No description")).toBeTruthy();
        expect(screen.getByText("Working")).toBeTruthy();
        // Read-only: nothing to stop.
        expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();

        expect(screen.queryByText("Grep")).toBeNull();
        await userEvent.click(screen.getByText("Find the API routes"));
        expect(screen.getByText("Grep")).toBeTruthy();
        expect(screen.getByText("Read")).toBeTruthy();
        expect(screen.getByText("Failed")).toBeTruthy();

        await userEvent.click(screen.getByText("No description"));
        expect(screen.getByText("No steps yet")).toBeTruthy();
    });

    it("offers Stop on a running subagent, saying it stops the whole turn", async () => {
        const onStop = vi.fn();
        render(<CodeSubagents subagents={nodes} onStop={onStop} />, { wrapper: MessagesWrapper });
        const stop = screen.getAllByRole("button", { name: /Stop/ });
        expect(stop).toHaveLength(1);
        expect(stop[0]!.getAttribute("title")).toBe("Stops the agent's whole turn");
        await userEvent.click(stop[0]!);
        expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("folds the list away", async () => {
        render(<CodeSubagents subagents={nodes} onStop={null} />, { wrapper: MessagesWrapper });
        await userEvent.click(screen.getByRole("button", { name: "Hide subagents" }));
        expect(screen.queryByText("Find the API routes")).toBeNull();
    });
});
