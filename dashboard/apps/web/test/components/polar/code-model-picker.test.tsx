// @vitest-environment jsdom

/**
 * Code's one picker: sources as groups with their models, no tool named
 * anywhere, a pick reported as a source and model, and the groups moved with
 * the keyboard's up and down buttons, saved on the server.
 */

import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import { CodeModelPicker } from "@/components/polar/code-model-picker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { resetPickerPrefs } from "@/components/polar/elements/use-picker-prefs";
import { codeSourcesFor, polarSourcesFor, resolveCodeEngine } from "@/lib/polar/agents/code-sources";

const PLAN = "0190c6a0-0000-7000-8000-0000000000a1";
const sources = [
    ...codeSourcesFor(
        [
            { key: `claude:${PLAN}`, cli: "claude", readiness: "ready", accountId: PLAN, account: "me@example.test", mine: true, machine: false, apiKey: false, env: "CLAUDE_CODE_OAUTH_TOKEN" }
        ],
        [{ provider: "anthropic", model: "claude-opus-4-1", name: "Claude Opus 4.1" }]
    ),
    ...polarSourcesFor(
        [{ provider: "openrouter", name: "OpenRouter", payers: ["own"], models: [{ provider: "openrouter", model: "anthropic/claude-opus", name: "Claude Opus" }] }],
        []
    )
];

const puts: unknown[] = [];
let refuse = false;

beforeEach(() => {
    resetPickerPrefs();
    const kept = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
        clear: () => kept.clear()
    });
    puts.length = 0;
    refuse = false;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method === "PUT") {
                puts.push(JSON.parse(String(init.body)));
                return new Response("{}", { status: refuse ? 500 : 200 });
            }
            return new Response(JSON.stringify({ order: [], recent: [{ source: `account:${PLAN}`, provider: "anthropic", model: "claude-opus-4-1" }] }), { status: 200 });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("Code's model picker", () => {
    it("lists sources and their models, names no tool, and sends the resolved engine", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<CodeModelPicker sources={sources} value={null} onChange={onChange} automatic disabled={false} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: /Model/ }));
        const menu = await screen.findByRole("menu");
        expect(menu.textContent).toContain("Claude subscription");
        expect(menu.textContent).toContain("me@example.test");
        expect(menu.textContent).toContain("OpenRouter");
        expect(menu.textContent).toContain("Automatic");
        expect(menu.textContent).not.toMatch(/Claude Code|OpenCode|Codex/);
        await waitFor(() => expect(menu.textContent).toContain("Recent"));
        const rows = screen.getAllByRole("menuitem", { name: /Claude Opus 4\.1/ });
        await user.click(rows[rows.length - 1]!);
        const pick = onChange.mock.calls[0]![0];
        expect(pick).toEqual({ source: `account:${PLAN}`, provider: "anthropic", model: "claude-opus-4-1" });
        const source = sources.find((entry) => entry.key === pick.source)!;
        expect(resolveCodeEngine(source, pick, { needsSession: true })).toEqual({
            cli: "claude",
            accountId: PLAN,
            useMachineLogin: false,
            modelChoice: { provider: "anthropic", model: "claude-opus-4-1", payer: null }
        });
    });

    it("moves a group with the keyboard's buttons, saves it, and puts it back when refused", async () => {
        const user = userEvent.setup();
        render(<CodeModelPicker sources={sources} value={null} onChange={() => undefined} automatic disabled={false} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: /Model/ }));
        await user.click(await screen.findByRole("menuitem", { name: "Order providers" }));
        await user.click(screen.getByRole("button", { name: "Move OpenRouter up" }));
        expect(puts).toEqual([{ order: ["polar:openrouter", `account:${PLAN}`] }]);
        const items = () => screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
        expect(items()[0]).toContain("OpenRouter");
        refuse = true;
        await user.click(screen.getByRole("button", { name: "Move OpenRouter down" }));
        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't save the order"));
        expect(items()[0]).toContain("OpenRouter");
    });
});
