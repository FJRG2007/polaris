/**
 * What the downloads page tells each assistant to run or click, in the format
 * that client documents. A link that decodes to the wrong shape installs
 * nothing, and the person only finds out inside the other app.
 */

import { describe, expect, it } from "vitest";
import * as setup from "@/lib/mcp/client-setup";

const URL_ = "https://polaris.example.test/api/mcp";

describe("client setup", () => {
    it("gives Claude Code its add command, with no credential in it", () => {
        expect(setup.claudeCodeCommand(URL_)).toBe(
            `claude mcp add --transport http polaris ${URL_}`
        );
    });

    it("builds Cursor's install link from the base64 of the server's mcp.json entry", () => {
        const link = new URL(setup.cursorInstallLink(URL_));
        expect(link.protocol).toBe("cursor:");
        expect(link.searchParams.get("name")).toBe("polaris");
        const config = JSON.parse(
            Buffer.from(link.searchParams.get("config")!, "base64").toString("utf8")
        );
        expect(config).toEqual({ url: URL_ });
        expect(JSON.parse(setup.cursorConfig(URL_))).toEqual({
            mcpServers: { polaris: { url: URL_ } }
        });
    });

    it("builds VS Code's install link from the URL-encoded server JSON with its name", () => {
        const link = setup.vscodeInstallLink(URL_);
        expect(link.startsWith("vscode:mcp/install?")).toBe(true);
        const json = JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length)));
        expect(json).toEqual({ name: "polaris", type: "http", url: URL_ });
        expect(JSON.parse(setup.vscodeConfig(URL_))).toEqual({
            servers: { polaris: { type: "http", url: URL_ } }
        });
    });

    it("gives Codex its add and login commands", () => {
        expect(setup.codexCommands(URL_).split("\n")).toEqual([
            `codex mcp add polaris --url ${URL_}`,
            "codex mcp login polaris"
        ]);
    });

    it("gives the generic guide its three connection types, exactly", () => {
        const sse = "https://polaris.example.test/api/mcp/sse";
        expect(setup.streamableHttpConfig(URL_)).toBe(
            JSON.stringify({ mcpServers: { polaris: { url: URL_ } } }, null, 2)
        );
        expect(setup.sseConfig(sse)).toBe(
            JSON.stringify({ mcpServers: { polaris: { type: "sse", url: sse } } }, null, 2)
        );
        expect(setup.stdioConfig(URL_)).toBe(
            JSON.stringify(
                { mcpServers: { polaris: { command: "npx", args: ["-y", "mcp-remote", URL_] } } },
                null,
                2
            )
        );
    });

    it("encodes Cursor's config as the base64 of its exact JSON", () => {
        const expected = Buffer.from(JSON.stringify({ url: URL_ }), "utf8").toString("base64");
        expect(setup.cursorInstallLink(URL_)).toBe(
            `cursor://anysphere.cursor-deeplink/mcp/install?name=polaris&config=${encodeURIComponent(expected)}`
        );
    });

    it("gives Copilot CLI, OpenCode and Kimi Code their documented forms", () => {
        expect(setup.copilotCliCommand(URL_)).toBe(
            `copilot mcp add --transport http polaris ${URL_}`
        );
        expect(JSON.parse(setup.opencodeConfig(URL_))).toEqual({
            mcp: { polaris: { type: "remote", url: URL_, enabled: true } }
        });
        expect(setup.opencodeAuthCommand()).toBe("opencode mcp auth polaris");
        expect(setup.kimiAddCommand(URL_)).toBe(
            `kimi mcp add --transport http --auth oauth polaris ${URL_}`
        );
        expect(setup.kimiAuthCommand()).toBe("kimi mcp auth polaris");
    });
});
