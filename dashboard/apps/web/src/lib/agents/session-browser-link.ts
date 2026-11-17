/**
 * The key a session's worker browser answers to (session-browser-mcp.ts).
 *
 * The session's id signed with the app secret every install already has, as
 * the preview address is (session-preview-link.ts), under its own label so one
 * can never stand in for the other. Nothing stores it: the boot environment
 * hands it to the container and the dashboard derives it again to dial it, so
 * it needs no new setting and exists on every install.
 *
 * Server-only.
 */

import { createHmac } from "node:crypto";
import { loadEnv } from "@polaris/config";

export function browserKey(sessionId: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET)
        .update(`agent-browser:${sessionId}`)
        .digest("base64url");
}
