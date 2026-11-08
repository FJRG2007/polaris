"use server";

import { requireAdmin } from "@/lib/session";
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
    return { keys, signins, shared };
}
