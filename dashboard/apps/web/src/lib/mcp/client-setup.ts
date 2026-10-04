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
 * No credential appears in any of them: each client signs in through OAuth.
 */

/** What the server is called in every client's configuration. */
export const SERVER_NAME = "polaris";

export function claudeCodeCommand(url: string): string {
    return `claude mcp add --transport http ${SERVER_NAME} ${url}`;
}

export function cursorConfig(url: string): string {
    return JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2);
}

export function cursorInstallLink(url: string): string {
    const config = Buffer.from(JSON.stringify({ url }), "utf8").toString("base64");
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

/** Where Claude's connector settings open (claude.com/docs/connectors). */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

/** Each client's own page on adding a remote MCP server. */
export const SETUP_GUIDES = {
    claudeCode: "https://code.claude.com/docs/en/mcp",
    claude: "https://claude.com/docs/connectors/custom/add-unlisted",
    chatgpt: "https://developers.openai.com/api/docs/guides/developer-mode",
    cursor: "https://cursor.com/docs/context/mcp",
    vscode: "https://code.visualstudio.com/docs/copilot/customization/mcp-servers"
} as const;
