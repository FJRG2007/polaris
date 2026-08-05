/**
 * Model keys (/apps/agents/keys): the provider credentials this account brought
 * itself, and what its runs fall back to when it has not brought one.
 */

import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { ModelKeysView } from "./model-keys-view";
import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";
import { instanceKeysAreShared, keySourcesFor, listUserModelKeys } from "@/lib/agents/user-model-keys";

export const dynamic = "force-dynamic";

export default async function ModelKeysPage() {
    const user = await requirePermission("agents.read");
    const [keys, sources, shared] = await Promise.all([
        listUserModelKeys(user.id),
        keySourcesFor(user.id),
        instanceKeysAreShared()
    ]);

    // Read here rather than in the actions file: everything a "use server" module
    // exports has to be an action, and this is a constant.
    const providers = MODEL_INTEGRATIONS.map((entry) => ({
        slug: entry.slug,
        name: entry.name,
        apiKeyLabel: entry.apiKeyLabel ?? "API key",
        apiKeyHelp: entry.apiKeyHelp ?? null,
        createUrl: entry.setupLinks?.[0]?.url ?? null,
        isGateway: entry.slug === GATEWAY_SLUG
    }));

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader
                title="Model keys"
                description="The provider accounts your agent runs bill to. A key you add here is used before anything the deployment holds."
            />
            <ModelKeysView
                providers={providers}
                keys={keys}
                sources={[...sources.entries()]}
                instanceShared={shared}
            />
        </div>
    );
}
