/**
 * The signed-in account's own account key: public halves, lock envelopes and
 * the OPAQUE unlock of the password envelope. Behind the chat end-to-end
 * encryption flag: 404 while it is off. See lib/chat/e2ee/handlers.ts.
 */

import { handleKeys } from "@/lib/chat/e2ee/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    return handleKeys(request);
}
