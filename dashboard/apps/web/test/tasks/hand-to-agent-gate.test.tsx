// @vitest-environment jsdom

/**
 * The "give to an agent" button follows the same answer the start refuses on:
 * disabled with the reason for an account without Agents or with no
 * repository, and disabled until that answer is in.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
    answer: { allowed: true, repos: [{ id: "r1", name: "web" }], agents: [], sources: [] } as unknown,
    pending: false
}));

vi.mock("@/app/(app)/tasks/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/app/(app)/tasks/tasks-polls", () => ({
    handoffChoices: () => (state.pending ? new Promise(() => undefined) : Promise.resolve(state.answer))
}));

const { HandToAgent } = await import("@/app/(app)/tasks/hand-to-agent");

afterEach(cleanup);

function button(): HTMLButtonElement {
    return screen.getByRole("button") as HTMLButtonElement;
}

function show() {
    render(withMessages(<HandToAgent taskId="t1" reference="ENG-1" name="Fix" description="" />));
}

describe("HandToAgent", () => {
    it("is usable for an account with Agents and a repository", async () => {
        state.pending = false;
        state.answer = { allowed: true, repos: [{ id: "r1", name: "web" }], agents: [], sources: [] };
        show();
        await waitFor(() => expect(button().disabled).toBe(false));
        expect(button().getAttribute("aria-label")).toBe("Give this to an agent");
    });

    it("is disabled with the reason for an account without Agents", async () => {
        state.pending = false;
        state.answer = { allowed: false, repos: [], agents: [], sources: [] };
        show();
        await waitFor(() => expect(button().getAttribute("aria-label")).toContain("no access to Agents"));
        expect(button().disabled).toBe(true);
    });

    it("is disabled with the reason when no repository is connected", async () => {
        state.pending = false;
        state.answer = { allowed: true, repos: [], agents: [], sources: [] };
        show();
        await waitFor(() => expect(button().getAttribute("aria-label")).toContain("none is connected"));
        expect(button().disabled).toBe(true);
    });

    it("is not offered before the answer is in", () => {
        state.pending = true;
        show();
        expect(button().disabled).toBe(true);
    });
});
