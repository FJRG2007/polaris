/**
 * Polar's tools by the MCP server they come from: Polaris's own, built in, and
 * each remote connector the person added. A server switched off takes all of
 * its tools out of a turn without touching the switches of the tools inside
 * it, so turning it back on brings back exactly the choices that were there.
 *
 * Pure and shared: the settings screen groups with it and the chat route
 * enforces with it, so what the screen shows off is what the model is not
 * offered.
 */

/** Polaris's own MCP server, built into Polar. */
export const POLARIS_SERVER = "polaris";

/** The id a remote connector's server is switched by. */
export function connectorServer(connector: string): string {
    return `connector:${connector}`;
}

/** What the grouping needs to know about a tool. */
export interface ServedTool {
    title?: string;
    /** The connector's name, for a tool of a remote MCP server. */
    connector?: string;
}

/** The server a tool belongs to. */
export function serverOfTool(tool: ServedTool): string {
    return tool.connector ? connectorServer(tool.connector) : POLARIS_SERVER;
}

/**
 * The names a turn must not offer: the tools switched off one by one, and
 * every tool of a server switched off as a whole.
 */
export function offWithServers(
    off: readonly string[],
    serversOff: readonly string[],
    tools: Record<string, ServedTool>
): Set<string> {
    const result = new Set(off);
    if (serversOff.length === 0) return result;
    const servers = new Set(serversOff);
    for (const [name, tool] of Object.entries(tools)) {
        if (servers.has(serverOfTool(tool))) result.add(name);
    }
    return result;
}

export interface ToolServerGroup {
    id: string;
    kind: "polaris" | "connector";
    /** The connector's name; empty for Polaris, which the screen names itself. */
    name: string;
    tools: { name: string; title: string }[];
}

/** The tools as servers, Polaris first and the connectors after by name, each
 *  server's tools by title. */
export function groupToolsByServer(tools: Record<string, ServedTool>): ToolServerGroup[] {
    const groups = new Map<string, ToolServerGroup>();
    groups.set(POLARIS_SERVER, { id: POLARIS_SERVER, kind: "polaris", name: "", tools: [] });
    for (const [name, tool] of Object.entries(tools)) {
        const id = serverOfTool(tool);
        let group = groups.get(id);
        if (!group) {
            group = { id, kind: "connector", name: tool.connector ?? "", tools: [] };
            groups.set(id, group);
        }
        // A connector's tool is titled "<connector>: <tool>" for a flat list;
        // inside its own server the prefix only repeats the heading.
        const title = tool.title ?? name;
        const prefix = tool.connector ? `${tool.connector}: ` : "";
        group.tools.push({
            name,
            title: prefix && title.startsWith(prefix) ? title.slice(prefix.length) : title
        });
    }
    for (const group of groups.values()) {
        group.tools.sort((a, b) => a.title.localeCompare(b.title));
    }
    const [polaris, ...connectors] = [...groups.values()];
    return [polaris!, ...connectors.sort((a, b) => a.name.localeCompare(b.name))];
}
