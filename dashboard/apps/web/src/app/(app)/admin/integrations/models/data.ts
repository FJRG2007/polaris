"use server";

import { requireAdmin } from "@/lib/session";
import { keyStatuses } from "@/lib/agents/key-status-read";
import {
    instanceKeysAreShared,
    INSTANCE,
    listAgentSignins,
    listProviderKeys
} from "@/lib/agents/model-keys";

/** The deployment's model keys and agent accounts, and whether members share them. */
export async function loadModelProvidersAction() {
    await requireAdmin();
    const [keys, signins, shared] = await Promise.all([
        listProviderKeys(INSTANCE),
        listAgentSignins(INSTANCE),
        instanceKeysAreShared()
    ]);
    return { keys, signins, shared, health: await keyStatuses(keys) };
}
