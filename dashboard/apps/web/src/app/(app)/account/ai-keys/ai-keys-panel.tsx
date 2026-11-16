/**
 * The provider keys and agent sign-ins of one account: what /account/ai-keys
 * shows, and the Agents section of Connected accounts, drawn by one component
 * so both list and change the same rows.
 */

import { getTranslations } from "@/lib/i18n/request";
import { Badge } from "@polaris/ui";
import { IntegrationLogo } from "@/components/logos";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { assistedSignins } from "@/lib/agents/signin-runtime";
import { isSigninRow, signinProviderRows } from "@/lib/agents/agent-signins";
import { keyStatuses } from "@/lib/agents/key-status-read";
import { ModelKeysView } from "@/components/model-keys/model-keys-view";
import { ensureProviderCatalog } from "@/lib/integrations/provider-catalog";
import { searchKeyProvidersAction } from "@/app/(app)/model-key-provider-actions";
import { modelProviderName, providerRowsFor } from "@/lib/agents/model-key-providers";
import {
    connectedProviders,
    instanceKeysAreShared,
    keySourcesFor,
    listModelKeys,
    signinEnvsFor,
    INSTANCE
} from "@/lib/agents/model-keys";
import {
    addModelKeyAction,
    agentSigninIdentityAction,
    agentSigninScreenAction,
    answerAgentSigninAction,
    beginAgentSigninAction,
    captureAgentSigninAction,
    typeAgentSigninInputAction,
    beginAgentSignoutAction,
    agentSigninStatusAction,
    deleteModelKeyAction,
    endAgentSigninAction,
    limitModelKeyAction,
    reorderModelKeysAction,
    reviveModelKeyAction,
    toggleModelKeyAction,
    updateModelKeyAction
} from "./actions";

export async function AiKeysPanel({
    userId,
    narrow = false
}: {
    userId: string;
    /** Drawn inside another page's reading column (Connected accounts). */
    narrow?: boolean;
}) {
    const t = await getTranslations("account");
    // One read, split below: agent sign-ins live in the same table as provider
    // keys and would otherwise be drawn as a credential for a provider that
    // does not exist. Read once so any missing hint is filled once.
    const [rows, sources, shared, deployment, fromPlatform] = await Promise.all([
        listModelKeys(userId),
        keySourcesFor(userId),
        instanceKeysAreShared(),
        // The providers the deployment holds a key for, each listed with whose
        // key a run of this person's actually spends.
        connectedProviders(),
        // What the deployment holds, asked as the deployment rather than as this
        // person, so a row it covers can say so instead of reading as missing.
        // Empty when sharing is off - the resolver checks that itself, which is
        // the same check that decides whether a session would actually get one.
        signinEnvsFor(INSTANCE)
    ]);

    await ensureProviderCatalog();
    const keys = rows.filter((row) => !isSigninRow(row.provider));
    const signins = rows.filter((row) => isSigninRow(row.provider));
    const health = await keyStatuses(keys);

    const covered = [...sources.entries()]
        .filter(([, source]) => source === "instance")
        .map(([slug]) => modelProviderName(slug));
    const deploymentRows = deployment.map((slug) => ({
        slug,
        name: modelProviderName(slug),
        yours: sources.get(slug) === "own"
    }));

    return (
        <div className="flex flex-col gap-4">
            <ModelKeysView
                providers={providerRowsFor(keys.map((key) => key.provider))}
                searchProviders={searchKeyProvidersAction}
                keys={keys}
                health={health}
                narrow={narrow}
                actions={{
                    add: addModelKeyAction,
                    update: updateModelKeyAction,
                    remove: deleteModelKeyAction,
                    reorder: reorderModelKeysAction,
                    toggle: toggleModelKeyAction,
                    limit: limitModelKeyAction,
                    revive: reviveModelKeyAction
                }}
                copy={{
                    title: t("aiKeys.keys.title"),
                    hint: t("aiKeys.keys.hint"),
                    empty:
                        shared && covered.length > 0
                            ? t("aiKeys.keys.emptyShared")
                            : t("aiKeys.keys.empty"),
                    adding: t("aiKeys.keys.adding")
                }}
                footer={<FallbackCard providers={deploymentRows} shared={shared} t={t} />}
            />

            {/* The same table, for the accounts an agent signs in with. A second
                one rather than a section of the first: they are a different
                question - which account works, not which provider bills - and
                mixing them put a subscription in a list about metered keys.
                Everything else about them is a key, so everything else about them
                is the table: named, reordered, renamed, given an end date, shown
                with its last use. */}
            <ModelKeysView
                providers={signinProviderRows()}
                keys={signins}
                narrow={narrow}
                actions={{
                    add: addModelKeyAction,
                    update: updateModelKeyAction,
                    remove: deleteModelKeyAction,
                    reorder: reorderModelKeysAction,
                    toggle: toggleModelKeyAction
                }}
                copy={{
                    title: t("aiKeys.accounts.title"),
                    action: t("aiKeys.accounts.add"),
                    hint: t("aiKeys.accounts.hint"),
                    empty:
                        fromPlatform.size > 0
                            ? t("aiKeys.accounts.emptyShared")
                            : t("aiKeys.accounts.empty"),
                    adding: t("aiKeys.accounts.adding")
                }}
                assist={{
                    signins: assistedSignins(),
                    actions: {
                        begin: beginAgentSigninAction,
                        screen: agentSigninScreenAction,
                        answer: answerAgentSigninAction,
                        identity: agentSigninIdentityAction,
                        capture: captureAgentSigninAction,
                        type: typeAgentSigninInputAction,
                        signout: beginAgentSignoutAction,
                        status: agentSigninStatusAction,
                        end: endAgentSigninAction
                    }
                }}
            />
        </div>
    );
}

/**
 * The providers the deployment holds a key for, under the account's own keys:
 * each by name, with whose key a run of this account spends - its own where it
 * added one, the deployment's otherwise. Read-only; who may spend the
 * deployment's keys is set under /admin.
 */
function FallbackCard({
    providers,
    shared,
    t
}: {
    providers: Array<{ slug: string; name: string; yours: boolean }>;
    shared: boolean;
    t: NamespaceTranslator<"account">;
}) {
    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium">{t("aiKeys.fallback.title")}</h2>
                <p className="text-muted-foreground text-xs">
                    {!shared
                        ? t("aiKeys.fallback.notShared")
                        : providers.length > 0
                          ? t("aiKeys.fallback.shared")
                          : t("aiKeys.fallback.noKeys")}
                </p>
            </div>
            {shared && providers.length > 0 ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {providers.map((provider) => (
                        <li key={provider.slug} className="flex items-center gap-2 px-3 py-2">
                            <IntegrationLogo slug={provider.slug} name={provider.name} className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-sm" title={provider.name}>
                                {provider.name}
                            </span>
                            <Badge variant={provider.yours ? "neutral" : "primary"} className="min-w-0 shrink truncate">
                                {provider.yours ? t("aiKeys.fallback.usingYours") : t("aiKeys.fallback.usingDeployment")}
                            </Badge>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
