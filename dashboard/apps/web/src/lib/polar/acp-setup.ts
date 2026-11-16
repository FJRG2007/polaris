/**
 * What an editor is told to run so Polar is one of its agents, generated for
 * this instance's address.
 *
 * An ACP agent is a command the editor starts and talks to over standard
 * input and output. Polar's is `polaris-agent acp` (`native/acp-agent.ts`),
 * served by this instance (`/api/agents/native/bundle`), so no package
 * registry and no install step is involved: the command is Node running a
 * short loader that downloads the bundle, checks it against the digest the
 * route sends, keeps it in `~/.polaris-agent/`, and runs it. When the
 * instance cannot be reached the last copy kept runs instead, so the editor
 * still starts offline. Each start fetches again, so an updated Polaris is
 * picked up without the person doing anything.
 *
 * Pure: the settings screen renders these strings and a test asserts them.
 */

/** `NATIVE_BUNDLE_ROUTE` (`native/bundle.ts`), restated because that module
 *  reads the disk and this one renders in the browser; a test holds them equal. */
export const ACP_BUNDLE_ROUTE = "/api/agents/native/bundle";

/** The name the agent appears under in the editor. */
export const ACP_AGENT_NAME = "Polar";

/** Stands where the person's key goes, until they paste or create one. */
export const ACP_KEY_PLACEHOLDER = "<your Polaris API key>";

/** The loader `node` runs. ESM (`--input-type=module`) for top-level await. */
export const ACP_LOADER = [
    'import{mkdirSync,writeFileSync,renameSync,existsSync}from"node:fs";',
    'import{homedir}from"node:os";import{join}from"node:path";',
    'import{pathToFileURL}from"node:url";import{createHash}from"node:crypto";',
    'const d=join(homedir(),".polaris-agent"),f=join(d,"polaris-agent.mjs");mkdirSync(d,{recursive:true});',
    `try{const r=await fetch(String(process.env.POLARIS_URL).replace(/\\/+$/,"")+"${ACP_BUNDLE_ROUTE}");`,
    'if(r.ok){const b=Buffer.from(await r.arrayBuffer());',
    'if(createHash("sha256").update(b).digest("hex")===r.headers.get("x-content-sha256")){',
    'const t=f+"."+process.pid+".tmp";writeFileSync(t,b);renameSync(t,f)}}}catch{}',
    'if(!existsSync(f)){console.error("Polar: Polaris could not be reached at "+process.env.POLARIS_URL);process.exit(1)}',
    'process.argv=[process.argv[0],f,"acp"];await import(pathToFileURL(f).href)'
].join("");

export interface AcpCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

/** The command, its arguments and its environment, for this instance. */
export function acpCommand(instanceUrl: string, apiKey: string = ACP_KEY_PLACEHOLDER): AcpCommand {
    return {
        command: "node",
        args: ["--input-type=module", "-e", ACP_LOADER],
        env: { POLARIS_URL: instanceUrl.replace(/\/+$/, ""), POLARIS_API_KEY: apiKey }
    };
}

export type AcpEditor = "zed" | "jetbrains" | "other";

export const ACP_EDITORS: readonly AcpEditor[] = ["zed", "jetbrains", "other"];

/**
 * The block each editor's settings take, as JSON text:
 * - Zed: `agent_servers` in its settings file, a `custom` server
 *   (zed.dev docs, and opencode.ai/docs/acp for the same shape).
 * - JetBrains: `agent_servers` in `~/.jetbrains/acp.json`, which the IDE
 *   opens from AI Chat, "Add Custom Agent" (jetbrains.com/help/ai-assistant/acp).
 * - Any other ACP client (VS Code extensions, Neovim plugins): the command,
 *   arguments and environment, which is what each of them asks for.
 */
export function acpSnippet(editor: AcpEditor, instanceUrl: string, apiKey?: string): string {
    const run = acpCommand(instanceUrl, apiKey);
    const server = { command: run.command, args: run.args, env: run.env };
    if (editor === "zed") {
        return JSON.stringify({ agent_servers: { [ACP_AGENT_NAME]: { type: "custom", ...server } } }, null, 4);
    }
    if (editor === "jetbrains") return JSON.stringify({ agent_servers: { [ACP_AGENT_NAME]: server } }, null, 4);
    return JSON.stringify(server, null, 4);
}
