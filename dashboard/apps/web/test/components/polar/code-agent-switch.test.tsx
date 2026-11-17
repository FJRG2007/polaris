// @vitest-environment jsdom

/**
 * The thread's agent switch: offered only where the server would allow it,
 * "Switching..." the moment it is confirmed, the dialog back on the same pick
 * with the server's sentence when it refuses, and the new session opened when
 * it does not.
 */

import { toWire } from "@/lib/app-bundles/wire";
import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { CodePick } from "@/lib/polar/agents/code-sources";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const PICK: CodePick = { source: "account:codex", provider: "openai", model: "gpt-5" };

// The picker has tests of its own; here it is one button that picks.
vi.mock("@/components/polar/code-model-picker", () => ({
    CodeModelPicker: ({ value, onChange }: { value: CodePick | null; onChange: (pick: CodePick) => void }) => (
        <button type="button" data-testid="picker" onClick={() => onChange(PICK)}>
            {value ? `picked:${value.source}` : "none"}
        </button>
    )
}));

const { CodeAgentSwitch, canSwitchAgent, switchableSources } = await import("@/components/polar/code-agent-switch");

const SESSION = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";

let answer: () => Promise<Response>;
const posted: unknown[] = [];
let release: (() => void) | null = null;

const json = (value: unknown) => new Response(JSON.stringify({ value: toWire(value) }), { status: 200 });

beforeEach(() => {
    posted.length = 0;
    release = null;
    answer = async () => json({ id: NEW });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url === "/api/polar/code/choices") {
                return json({ code: { sources: [{ key: "account:codex", readiness: "ready" }, { key: "account:gone", readiness: "missing" }] } });
            }
            posted.push(JSON.parse(String(init?.body)));
            // Held until the test lets it answer, so the optimistic state can be read.
            await new Promise<void>((resolve) => (release = resolve));
            return answer();
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function mount() {
    const onSwitched = vi.fn();
    const onError = vi.fn();
    render(
        <MessagesWrapper>
            <CodeAgentSwitch sessionId={SESSION} onSwitched={onSwitched} onError={onError} />
        </MessagesWrapper>
    );
    return { onSwitched, onError };
}

async function pickAndConfirm() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Switch agent" }));
    await user.click(await screen.findByTestId("picker"));
    await user.click(screen.getByRole("button", { name: "Switch" }));
}

describe("canSwitchAgent", () => {
    const thread = {
        canManage: true,
        session: { live: true },
        view: { place: "local", repoId: "00000000-0000-4000-8000-0000000000aa", state: "working" }
    };

    it("offers it for a running session on Polaris with a repository", () => {
        expect(canSwitchAgent(thread)).toBe(true);
    });

    it("hides it wherever the server would refuse", () => {
        expect(canSwitchAgent(null)).toBe(false);
        expect(canSwitchAgent({ ...thread, canManage: false })).toBe(false);
        expect(canSwitchAgent({ ...thread, session: { live: false } })).toBe(false);
        expect(canSwitchAgent({ ...thread, view: { ...thread.view, place: "host" } })).toBe(false);
        expect(canSwitchAgent({ ...thread, view: { ...thread.view, place: "computer" } })).toBe(false);
        expect(canSwitchAgent({ ...thread, view: { ...thread.view, repoId: null } })).toBe(false);
        expect(canSwitchAgent({ ...thread, view: { ...thread.view, state: "starting" } })).toBe(false);
    });

    it("offers only sources that can sign in", () => {
        const kept = switchableSources([
            { key: "a", readiness: "ready" },
            { key: "b", readiness: "unknown" },
            { key: "c", readiness: "missing" }
        ] as never);
        expect(kept.map((source) => source.key)).toEqual(["a", "b"]);
    });
});

describe("CodeAgentSwitch", () => {
    it("says it is switching at once, then opens the new session", async () => {
        const { onSwitched, onError } = mount();
        await pickAndConfirm();
        expect(await screen.findByText("Switching...")).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(posted).toEqual([{ sessionId: SESSION, pick: PICK }]);
        release?.();
        await waitFor(() => expect(onSwitched).toHaveBeenCalledWith(NEW));
        expect(onError).toHaveBeenLastCalledWith(null);
        await waitFor(() => expect(screen.getByRole("button", { name: "Switch agent" })).toBeTruthy());
        expect(screen.queryByText("Switching...")).toBeNull();
    });

    it("reopens the dialog on the same pick with the server's sentence when refused", async () => {
        answer = async () => json({ error: "Answer the agent's question first, then switch." });
        const { onSwitched, onError } = mount();
        await pickAndConfirm();
        expect(await screen.findByText("Switching...")).toBeTruthy();
        release?.();
        await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Answer the agent's question first, then switch."));
        expect(await screen.findByRole("dialog")).toBeTruthy();
        expect(screen.getByTestId("picker").textContent).toBe(`picked:${PICK.source}`);
        expect(onSwitched).not.toHaveBeenCalled();
        expect(screen.queryByText("Switching...")).toBeNull();
    });

    it("says it failed in its own words when the request itself fails", async () => {
        answer = async () => new Response("{}", { status: 500 });
        const { onError } = mount();
        await pickAndConfirm();
        release?.();
        await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Couldn't switch agents. Try again."));
        expect(await screen.findByRole("dialog")).toBeTruthy();
    });

    it("cannot be confirmed before an agent is picked", async () => {
        mount();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Switch agent" }));
        const confirm = await screen.findByRole("button", { name: "Switch" });
        expect((confirm as HTMLButtonElement).disabled).toBe(true);
    });
});
