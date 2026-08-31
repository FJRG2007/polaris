// @vitest-environment jsdom

/**
 * The agent picker, opened for real.
 *
 * `agent-signins.test.ts` and `session-commands.test.ts` pin the data and the
 * boot script; this one exercises the surface a person actually sees - that the
 * picker draws each tool's own mark, that search narrows the list by vendor as
 * well as by name, and that a tool this account cannot sign in reads as "Not
 * linked" rather than being hidden or silently allowed through.
 */

import * as core from "@polaris/core";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChoice } from "@/lib/agents/agent-readiness";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentSelect, SignInNotice } from "@/components/agents/agent-select";

afterEach(cleanup);

/** The real catalogue, answered as it would be for an account holding only a
 *  Claude subscription token - so `claude` reads ready and every other tool
 *  with sourced credentials reads "Not linked", the same split the picker was
 *  built to show. */
function choicesFor(held: Set<string>): AgentChoice[] {
    const present = (env: string): boolean => held.has(env);
    return core.AGENT_CLIS.map((cli) => ({
        id: cli.id,
        label: cli.label,
        vendor: cli.vendor,
        install: cli.install,
        docs: cli.docs,
        readiness: core.agentReadiness(cli, present),
        missing:
            core.agentReadiness(cli, present) === "missing"
                ? cli.credentials.map((c) => ({ env: c.env, label: c.label, url: c.url, howto: c.howto }))
                : []
    }));
}

describe("AgentSelect", () => {
    it("draws the vendor's own mark for the tool that is picked", () => {
        const options = choicesFor(new Set(["CLAUDE_CODE_OAUTH_TOKEN"]));
        const { container } = render(<AgentSelect options={options} value="claude" onChange={() => {}} />);
        // Anthropic's mark is inline SVG carrying its own path data; a
        // monogram (the fallback for a tool with no mark) draws a <span> of
        // initials instead, never an <svg>.
        const svg = container.querySelector("svg");
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    });

    it("opens on the trigger and lists every tool with its readiness", async () => {
        const options = choicesFor(new Set(["CLAUDE_CODE_OAUTH_TOKEN"]));
        render(<AgentSelect options={options} value="" onChange={() => {}} />);

        await userEvent.click(screen.getByRole("button", { name: /pick an agent/i }));

        expect(screen.getByRole("listbox")).not.toBeNull();
        expect(screen.getByRole("option", { name: /claude code/i })).not.toBeNull();
        // Codex has its own credential (OPENAI_API_KEY) that nothing here holds,
        // so it is the row that has to say it cannot sign in - the whole reason
        // this component exists over a plain listbox.
        const codexRow = screen.getByRole("option", { name: /codex/i });
        expect(codexRow.textContent).toContain("Not linked");
        const claudeRow = screen.getByRole("option", { name: /claude code/i });
        expect(claudeRow.textContent).not.toContain("Not linked");
    });

    it("narrows the list by vendor, not only by the tool's own name", async () => {
        const options = choicesFor(new Set());
        render(<AgentSelect options={options} value="" onChange={() => {}} />);
        await userEvent.click(screen.getByRole("button", { name: /pick an agent/i }));

        await userEvent.type(screen.getByPlaceholderText("Search agents"), "openai");

        expect(screen.getByRole("option", { name: /codex/i })).not.toBeNull();
        expect(screen.queryByRole("option", { name: /claude code/i })).toBeNull();
    });

    it("picks the row and closes, without leaving the search behind", async () => {
        const options = choicesFor(new Set(["CLAUDE_CODE_OAUTH_TOKEN"]));
        let picked = "";
        render(<AgentSelect options={options} value="" onChange={(id) => (picked = id)} />);
        await userEvent.click(screen.getByRole("button", { name: /pick an agent/i }));

        await userEvent.click(screen.getByRole("option", { name: /claude code/i }));

        expect(picked).toBe("claude");
        expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("captures the open picker as evidence of what a person actually sees", async () => {
        const options = choicesFor(new Set(["CLAUDE_CODE_OAUTH_TOKEN"]));
        const { container } = render(<AgentSelect options={options} value="claude" onChange={() => {}} />);
        await userEvent.click(screen.getByRole("button", { name: /claude code/i }));

        const fs = await import("node:fs");
        const dir = "C:\\Users\\admin\\AppData\\Local\\Temp\\enigma-gate-evidence\\01M1CEM62Q4V7JHQ3RH95H407Z";
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}\\agent-select-open.html`, container.innerHTML, "utf8");

        expect(screen.getByRole("listbox")).not.toBeNull();
    });
});

describe("SignInNotice", () => {
    it("names the credential in the vendor's own words and links to where it is linked", () => {
        const codex = choicesFor(new Set()).find((agent) => agent.id === "codex")!;
        render(<SignInNotice agent={codex} />);

        expect(screen.getByText(/Nothing here signs Codex in/i)).not.toBeNull();
        const link = screen.getByRole("link", { name: /add it under ai keys/i });
        expect(link.getAttribute("href")).toBe("/account/ai-keys");
        // The credential's own label from the catalogue, not a name invented here.
        expect(codex.missing.length).toBeGreaterThan(0);
        expect(screen.getByText(codex.missing[0]!.label)).not.toBeNull();
    });
});
