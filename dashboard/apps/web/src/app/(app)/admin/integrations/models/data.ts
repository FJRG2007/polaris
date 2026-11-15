"use server";

import { requireAdmin } from "@/lib/session";
import { keyStatuses } from "@/lib/agents/key-status-read";
import { providerRowsFor } from "@/lib/agents/model-key-providers";
import {
    ensureProviderCatalog,
    listCustomProviders,
    providerIndexState
} from "@/lib/integrations/provider-catalog";
import {
    instanceKeysAreShared,
    INSTANCE,
    listAgentSignins,
    listProviderKeys
} from "@/lib/agents/model-keys";

/** The deployment's model keys and agent accounts, and whether members share them. */
export async function loadModelProvidersAction() {
    await requireAdmin();
    const [keys, signins, shared, , custom, index] = await Promise.all([
        listProviderKeys(INSTANCE),
        listAgentSignins(INSTANCE),
        instanceKeysAreShared(),
        ensureProviderCatalog(),
        listCustomProviders(),
        providerIndexState()
    ]);
    return {
        keys,
        signins,
        shared,
        health: await keyStatuses(keys),
        // Rows for the providers these keys belong to, not the catalogue: the Add
        // dialog pages the rest from the server.
        providers: providerRowsFor(keys.map((key) => key.provider)),
        custom,
        index
    };
}
