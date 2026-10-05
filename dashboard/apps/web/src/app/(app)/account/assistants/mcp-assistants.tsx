/**
 * Account > AI assistants, "Connect an MCP client": this instance's MCP
 * addresses, resolved on the server under the name the page was opened on, and
 * handed to the client picker with the strings it reads.
 *
 * Its own component so the page that holds it only places it.
 */

import { ConnectGuides } from "./connect-guides";
import { Messages } from "@/components/i18n/messages";
import { currentOrigin } from "@/lib/mcp/oauth/origin";
import { MCP_PATH, SSE_PATH } from "@/lib/mcp/oauth/urls";

export async function McpAssistants() {
    const origin = await currentOrigin();
    return (
        <Messages namespaces={["mcpConnect"]}>
            <ConnectGuides urls={{ http: `${origin}${MCP_PATH}`, sse: `${origin}${SSE_PATH}` }} />
        </Messages>
    );
}
