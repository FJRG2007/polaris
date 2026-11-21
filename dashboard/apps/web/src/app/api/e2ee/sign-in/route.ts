/**
 * Signing in with a password proved over OPAQUE, and moving an account onto
 * OPAQUE after a password sign-in. Behind the chat end-to-end encryption flag:
 * 404 while it is off. See lib/chat/e2ee/handlers.ts.
 */

import { handleSignIn } from "@/lib/chat/e2ee/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    return handleSignIn(request);
}
