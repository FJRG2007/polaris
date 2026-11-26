/**
 * The account key log: signed tree heads and the inclusion and consistency
 * proofs a browser checks before it trusts an account key. Behind the chat
 * end-to-end encryption flag: 404 while it is off. See
 * lib/chat/e2ee/key-log-handler.ts.
 */

import { handleKeyLog } from "@/lib/chat/e2ee/key-log-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    return handleKeyLog(request);
}
