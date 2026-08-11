/**
 * Where Microsoft returns somebody after they prove the account their Minecraft
 * profile belongs to.
 *
 * Its own path rather than the Microsoft one beside it, because it is a different
 * application: this one is registered for Xbox sign-in and approved for the
 * Minecraft API, and the OneDrive one is not.
 */

import { finishConnectionCallback } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionCallback(request, "minecraft");
}
