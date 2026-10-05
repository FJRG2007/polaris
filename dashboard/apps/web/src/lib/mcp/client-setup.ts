/**
 * What each assistant needs typed, pasted or clicked to connect to this
 * instance's MCP endpoint. Pure, so the downloads page and its tests share it.
 *
 * Every format here is the client's own documented one:
 *   - Claude Code: `claude mcp add --transport http <name> <url>`, then `/mcp`
 *     to sign in (code.claude.com/docs/en/mcp).
 *   - Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=`,
 *     config being the server's mcp.json entry, JSON then base64
 *     (cursor.com/docs/mcp/install-links; remote entries are `{ url }`,
 *     cursor.com/docs/context/mcp).
 *   - VS Code: `vscode:mcp/install?` + the URL-encoded JSON of the server with
 *     its name (code.visualstudio.com/api/extension-guides/ai/mcp), and
 *     `servers` in .vscode/mcp.json with `type: "http"`.
 *   - Codex CLI: `codex mcp add <name> --url <url>`, then `codex mcp login`.
 *   - OpenCode: `mcp.<name>` in opencode.json, `type: "remote"`, then
 *     `opencode mcp auth <name>` (opencode.ai/docs/mcp-servers).
 *   - Kimi Code: `kimi mcp add --transport http --auth oauth <name> <url>`, then
 *     `kimi mcp auth <name>` (moonshotai.github.io/kimi-cli/en/customization/mcp.html).
 *   - Copilot CLI: `copilot mcp add --transport http <name> <url>`
 *     (docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).
 *   - Any other client: the `mcpServers` entry most of them read, in the three
 *     shapes there are - a URL (Streamable HTTP), `type: "sse"` with the SSE
 *     endpoint, or mcp-remote over stdio for a client that only runs commands.
 * No credential appears in any of them: each client signs in through OAuth.
 */

/** What the server is called in every client's configuration. */
export const SERVER_NAME = "polaris";

/** What a client that shows the name to people is told to call it. */
export const DISPLAY_NAME = "Polaris";

/** What VS Code's Command Palette runs to open the user's mcp.json. */
export const VSCODE_OPEN_CONFIG = "MCP: Open User Configuration";

export function claudeCodeCommand(url: string): string {
    return `claude mcp add --transport http ${SERVER_NAME} ${url}`;
}

/** Base64 of a string's UTF-8 bytes, the same in the browser and on the server. */
function base64(text: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** The `mcpServers` entry for the Streamable HTTP endpoint: a bare URL. */
export function streamableHttpConfig(url: string): string {
    return JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2);
}

/** The same for a client that only speaks the older HTTP+SSE transport. */
export function sseConfig(sseUrl: string): string {
    return JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "sse", url: sseUrl } } }, null, 2);
}

/** For a client that can only start a local command: mcp-remote bridges stdio
 *  to the remote endpoint and runs the sign-in in a browser. */
export function stdioConfig(url: string): string {
    return JSON.stringify(
        { mcpServers: { [SERVER_NAME]: { command: "npx", args: ["-y", "mcp-remote", url] } } },
        null,
        2
    );
}

/** Cursor reads the plain `mcpServers` entry. */
export const cursorConfig = streamableHttpConfig;

export function cursorInstallLink(url: string): string {
    const config = base64(JSON.stringify({ url }));
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

export function vscodeConfig(url: string): string {
    return JSON.stringify({ servers: { [SERVER_NAME]: { type: "http", url } } }, null, 2);
}

export function vscodeInstallLink(url: string): string {
    return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "http", url }))}`;
}

export function codexCommands(url: string): string {
    return `codex mcp add ${SERVER_NAME} --url ${url}\ncodex mcp login ${SERVER_NAME}`;
}

export function copilotCliCommand(url: string): string {
    return `copilot mcp add --transport http ${SERVER_NAME} ${url}`;
}

export function opencodeConfig(url: string): string {
    return JSON.stringify(
        { mcp: { [SERVER_NAME]: { type: "remote", url, enabled: true } } },
        null,
        2
    );
}

export function opencodeAuthCommand(): string {
    return `opencode mcp auth ${SERVER_NAME}`;
}

export function kimiAddCommand(url: string): string {
    return `kimi mcp add --transport http --auth oauth ${SERVER_NAME} ${url}`;
}

export function kimiAuthCommand(): string {
    return `kimi mcp auth ${SERVER_NAME}`;
}

/** Where Claude's connector settings open (claude.com/docs/connectors). */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

/** Where Grok's connectors open (docs.x.ai/grok/connectors). */
export const GROK_CONNECTORS_URL = "https://grok.com/connectors";

/** Each client's own page on adding a remote MCP server. */
export const SETUP_GUIDES = {
    claudeCode: "https://code.claude.com/docs/en/mcp",
    claude: "https://claude.com/docs/connectors/custom/remote-mcp",
    chatgpt: "https://developers.openai.com/api/docs/guides/developer-mode",
    cursor: "https://cursor.com/docs/context/mcp",
    vscode: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
    copilot:
        "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    devin: "https://docs.devin.ai/work-with-devin/mcp",
    figma: "https://help.figma.com/hc/en-us/articles/38147204302743-Create-and-use-custom-MCP-connectors-in-Figma-Make",
    grok: "https://docs.x.ai/grok/connectors",
    mistral: "https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors",
    zapier: "https://help.zapier.com/hc/en-us/articles/38777069364109-Connect-remote-MCP-servers-to-Zapier-using-MCP-Client",
    make: "https://apps.make.com/mcp-client",
    opencode: "https://opencode.ai/docs/mcp-servers/",
    kimi: "https://moonshotai.github.io/kimi-cli/en/customization/mcp.html"
} as const;
