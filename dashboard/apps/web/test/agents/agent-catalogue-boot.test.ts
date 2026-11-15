/**
 * Booting every catalogued agent, read off the boot script rather than run.
 *
 * `session-commands.test.ts` runs the script in a shell; this one pins what each
 * catalogue entry hands it, for each way a tool is started - installed by npm,
 * by uv or by the vendor's own script, launched on its terminal interface or
 * one turn at a time - so an entry that could not boot fails here first.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import * as commands from "@/lib/agents/session-commands";

describe("the boot script for any catalogued agent", () => {
    const setup = commands.SESSION_SETUP;

    it("installs from the catalogue's command, as the agent's own user", () => {
        expect(setup).toContain('as_agent "$POLARIS_AGENT_INSTALL"');
        expect(setup).toContain('command -v "$POLARIS_AGENT_BINARY"');
    });

    it("finds a binary a vendor's install script put in ~/.local/bin", () => {
        const path = setup.indexOf('PATH="$HOME/.local/bin:$PATH"');
        expect(path).toBeGreaterThan(-1);
        // Set after the home moves to the session's own, and before the install
        // check that would otherwise report the tool missing.
        expect(path).toBeGreaterThan(setup.indexOf('HOME="$POLARIS_HOME"'));
        expect(path).toBeLessThan(setup.indexOf('as_agent "$POLARIS_AGENT_INSTALL"'));
    });

    const npm = core.AGENT_CLIS.filter((cli) => cli.install?.startsWith("npm install -g "));
    const script = core.AGENT_CLIS.filter((cli) => cli.install?.startsWith("curl "));
    const uv = core.AGENT_CLIS.filter((cli) => cli.install?.startsWith("uv tool install "));

    it("covers every install method the catalogue uses", () => {
        expect(npm.length).toBeGreaterThan(0);
        expect(script.length).toBeGreaterThan(0);
        expect(uv.length).toBeGreaterThan(0);
    });

    it.each(core.AGENT_CLIS.map((cli) => [cli.id, cli] as const))(
        "%s launches as one line of plain words",
        (_id, cli) => {
            // What the runtime joins into POLARIS_AGENT_COMMAND, unattended.
            const line = [cli.binaries[0], ...cli.autonomyArgs].join(" ");
            expect(line).toMatch(/^[A-Za-z0-9 =._-]+$/);
            expect(line.startsWith(`${cli.binaries[0]}`)).toBe(true);
            // The install is one line too: it travels in the environment, where
            // a newline is a control character the host daemon refuses.
            expect(cli.install ?? "").not.toMatch(/[\r\n]/);
        }
    );

    it("starts a tool with headless flags one turn at a time, and the rest on their terminal", () => {
        // Headless flags are only ever ones checked against the tool's own
        // documentation; every agent added from Agent Orchestrator's catalogue
        // keeps its terminal interface until that is done.
        const headless = core.AGENT_CLIS.filter((cli) => cli.headless).map((cli) => cli.id);
        expect(headless).toEqual(["claude"]);
    });

    it("records an ACP mode only as words to append to the binary", () => {
        const acp = core.AGENT_CLIS.filter((cli) => cli.acp);
        expect(acp.map((cli) => cli.id)).toEqual(
            expect.arrayContaining(["opencode", "copilot", "cursor", "qwen", "kimi", "grok", "hermes"])
        );
        for (const cli of acp) expect(cli.acp?.join(" ")).toMatch(/^[A-Za-z0-9 ._-]+$/);
    });
});
