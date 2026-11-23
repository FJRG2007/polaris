/**
 * The chat MLS delivery service: devices, key packages, one group per
 * conversation, its ordered log and the history-key envelopes. Behind the chat
 * end-to-end encryption flag: 404 while it is off. See lib/chat/e2ee/mls-handler.ts.
 */

import { handleMls } from "@/lib/chat/e2ee/mls-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    return handleMls(request);
}
