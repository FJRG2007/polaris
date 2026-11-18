/**
 * Who the AI providers screen writes for: the signed-in person, their own
 * keys, revalidating their own page. Shared by every action file of the screen.
 */

import { requireUser } from "@/lib/session";
import type { KeyScope } from "@/lib/agents/model-key-actions";

export const AI_PROVIDERS_PATH = "/polar/settings/providers";

export async function accountScope(): Promise<KeyScope> {
    const user = await requireUser();
    return { owner: user.id, actorId: user.id, path: AI_PROVIDERS_PATH, audit: "account" };
}
