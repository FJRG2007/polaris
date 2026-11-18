/**
 * Every AI connection of one account - provider keys, subscription sign-ins,
 * cloud accounts and agent accounts - as one list with one Add connection: what
 * /account/ai-keys shows, and the Agents section of Connected accounts, drawn by
 * one component so both list and change the same rows.
 */

import { getTranslations } from "@/lib/i18n/request";
import { assistedSignins } from "@/lib/agents/signin-runtime";
import { AGENT_CLIS } from "@polaris/core";
import { agentSignins, isSigninRow, signinProviderRows, type AgentSignin } from "@/lib/agents/agent-signins";
import { ProviderLogins } from "@/components/model-keys/provider-logins";
import { CloudAccounts } from "@/components/model-keys/cloud-accounts";
import { ConnectionHub, type ConnectionOption } from "@/components/model-keys/connection-hub";
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
    const health = await keyStatuses(keys);

    const covered = [...sources.entries()]
        .filter(([, source]) => source === "instance")
        .map(([slug]) => modelProviderName(slug));
    const deploymentRows = deployment.map((slug) => ({
        slug,
        name: modelProviderName(slug),
        yours: sources.get(slug) === "own"
    }));

    const assisted = assistedSignins();
    const keysEmpty = shared && covered.length > 0;
    const accountsEmpty = fromPlatform.size > 0;

    // One list and one way in. Keys and agent accounts were two tables with two
    // Add buttons beside two cards of sign-ins and clouds, and somebody adding
    // Claude had to know which of the four it was first. They are one table now
    // - the order is one order, read per provider - and Add connection asks what
    // is being connected before how.
    return (
        <ConnectionHub>
            <div className="flex flex-col gap-4">
                <ProviderLogins />
                <CloudAccounts />
                <ModelKeysView
                    providers={[...providerRowsFor(keys.map((key) => key.provider)), ...signinProviderRows()]}
                    searchProviders={searchKeyProvidersAction}
                    keys={rows}
                    health={health}
                    narrow={narrow}
                    connectOptions={connectOptions(assisted)}
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
                        title: t("aiKeys.connections.title"),
                        hint: t("aiKeys.connections.hint"),
                        empty:
                            keysEmpty || accountsEmpty
                                ? t("aiKeys.connections.emptyShared")
                                : t("aiKeys.connections.empty"),
                        adding: t("aiKeys.connections.adding")
                    }}
                    assist={{
                        signins: assisted,
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
                    deployment={{
                        rows: shared ? deploymentRows : [],
                        note: !shared
                            ? t("aiKeys.fallback.notShared")
                            : deploymentRows.length > 0
                              ? t("aiKeys.fallback.shared")
                              : t("aiKeys.fallback.noKeys")
                    }}
                />
            </div>
        </ConnectionHub>
    );
}

/**
 * The agent accounts and agent sign-ins Add connection lists, each with the
 * vendor of the agent it signs in, so a Claude subscription is offered beside
 * the Anthropic key rather than on a card of its own.
 */
function connectOptions(assisted: readonly AgentSignin[]): ConnectionOption[] {
    const vendorOf = (id: string | undefined) => AGENT_CLIS.find((cli) => cli.id === id)?.vendor ?? "";
    const home = new Set(assisted.filter((signin) => signin.home).map((signin) => signin.slug));
    const accounts = agentSignins()
        .filter((signin) => !home.has(signin.slug))
        .map<ConnectionOption>((signin) => ({
            method: "account",
            slug: signin.slug,
            name: signin.label,
            vendor: vendorOf(signin.serves[0]?.id),
            aliases: signin.serves.map((tool) => tool.label)
        }));
    const homes = assisted
        .filter((signin) => signin.home)
        .map<ConnectionOption>((signin) => ({
            method: "home",
            slug: signin.slug,
            name: signin.serves[0]?.label ?? signin.label,
            vendor: vendorOf(signin.serves[0]?.id),
            aliases: [signin.label],
            ...(signin.single ? { single: true } : {})
        }));
    return [...accounts, ...homes];
}
