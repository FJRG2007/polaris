/**
 * Who the AI providers screen writes for: the signed-in person, their own
 * keys, revalidating their own page. Shared by every action file of the screen.
 */

import { requireUser } from "@/lib/session";
import { AI_PROVIDERS_PAGE } from "@/lib/connections/hub-href";
import type { KeyScope } from "@/lib/agents/model-key-actions";

export const AI_PROVIDERS_PATH = AI_PROVIDERS_PAGE;

export async function accountScope(): Promise<KeyScope> {
    const user = await requireUser();
    return { owner: user.id, actorId: user.id, path: AI_PROVIDERS_PATH, audit: "account" };
}
