/**
 * Keeping a session's recorded client current across updates of that client.
 */

import { prisma } from "@polaris/db";
import { describeClient } from "@polaris/core";
import { withAppMarker } from "@/lib/session-row";
import { sessionClient } from "@/lib/session-device";

/**
 * Keep the session's recorded client at the version it runs now.
 *
 * The record is taken at sign-in, so a session that lives across updates went
 * on reading "Polaris Desktop 0.1.1" or an old Brave long after both had moved
 * on. Only a new version of the same browser on the same system is followed -
 * that is an update, not a different client - and only when the user-agent
 * actually changed, so an unchanged request writes nothing.
 */
export async function followClientVersion(
    sessionId: string,
    state: { userAgent: string | null; userAgentBrands: string | null; userAgentPlatform: string | null },
    asked: { userAgent: string | null; brands: string | null; platform: string | null }
): Promise<void> {
    if (!asked.userAgent || asked.userAgent === state.userAgent) return;
    // The record was taken from one of the app's requests that went out without
    // its marker: the app saying so now is the same client, so the record
    // takes its word and stops reading as the bare WebView.
    const healed = withAppMarker(asked.userAgent, state.userAgent) === asked.userAgent;
    const was = sessionClient({ userAgent: null, state });
    const here = describeClient(asked.userAgent, asked.brands, asked.platform);
    if (!healed && (!was.browser || was.browser !== here.browser || was.os !== here.os)) return;
    await prisma.sessionState
        .update({
            where: { sessionId },
            data: {
                userAgent: asked.userAgent,
                userAgentBrands: asked.brands,
                userAgentPlatform: asked.platform
            }
        })
        .catch((error: unknown) => console.error("polaris: could not record the client's version:", error));
}
