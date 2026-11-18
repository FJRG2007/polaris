/**
 * AI providers: every AI connection of one owner - provider keys, subscription
 * sign-ins, cloud accounts and agent accounts - as one list with one Add
 * connection.
 *
 * One component for both owners. An account sees its own under Polar's
 * settings (and in the Agents section of Connected accounts); an administrator
 * sees the deployment's defaults on Management, which every account falls back
 * to. The table, the catalogue and the dialogs are the same; what differs is
 * whose actions they call, handed in by each page, and the parts only an
 * account has - the sign-ins kept on its own sessions' machine, and the line
 * saying which of the deployment's keys its runs fall back to.
 */

import { AGENT_CLIS } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import type { ComponentProps, ReactNode } from "react";
import { homeSigninsOf } from "@/lib/agents/home-signins";
import { keyStatuses } from "@/lib/agents/key-status-read";
import { assistedSignins } from "@/lib/agents/signin-runtime";
import { ModelKeysView, type AssistedSignin } from "./model-keys-view";
import { ConnectionHub, type ConnectionOption } from "./connection-hub";
import { CloudAccounts, type CloudAccountActions } from "./cloud-accounts";
import { ensureProviderCatalog } from "@/lib/integrations/provider-catalog";
import { ProviderLogins, type ProviderLoginActions } from "./provider-logins";
import { searchKeyProvidersAction } from "@/app/(app)/model-key-provider-actions";
import { modelProviderName, providerRowsFor } from "@/lib/agents/model-key-providers";
import { agentSignins, isSigninRow, signinProviderRows, type AgentSignin } from "@/lib/agents/agent-signins";
import {
    connectedProviders,
    instanceKeysAreShared,
    keySourcesFor,
    listModelKeys,
    signinEnvsFor,
    INSTANCE
} from "@/lib/agents/model-keys";

type ViewProps = ComponentProps<typeof ModelKeysView>;

/** Whose connections these are, and the actions that write them. */
export type ProvidersOwner =
    | {
          kind: "account";
          userId: string;
          /** The sign-ins kept on this person's sessions' machine. */
          signin: AssistedSignin["actions"];
      }
    | { kind: "deployment"; sharedFooter: ReactNode; privateFooter: ReactNode };

export async function AiProvidersPanel({
    owner,
    actions,
    copy,
    narrow = false,
    after
}: {
    owner: ProvidersOwner;
    actions: { keys: ViewProps["actions"]; logins: ProviderLoginActions; clouds: CloudAccountActions };
    /** The table's words. `emptyShared` is said where an account's runs are
     *  already covered by the deployment's keys. */
    copy: ViewProps["copy"] & { emptyShared?: string };
    /** Drawn inside another page's reading column: optional columns stay folded. */
    narrow?: boolean;
    /** Drawn under the table: the deployment's custom providers. */
    after?: ReactNode;
}) {
    const account = owner.kind === "account" ? owner : null;
    const keyOwner = account ? account.userId : INSTANCE;
    // One read, split below: agent sign-ins live in the same table as provider
    // keys and would otherwise be drawn as a credential for a provider that
    // does not exist.
    const [rows, shared] = await Promise.all([listModelKeys(keyOwner), instanceKeysAreShared(), ensureProviderCatalog()]);
    const keys = rows.filter((row) => !isSigninRow(row.provider));
    const [health, fallback] = await Promise.all([keyStatuses(keys), account ? accountFallback(account.userId, shared) : null]);

    // Only an account signs in on its own sessions' machine: the deployment
    // has no home, and an administrator would be signing a subscription that
    // is not theirs into a machine that is not theirs.
    const assisted = account ? assistedSignins() : [];
    const { emptyShared, ...words } = copy;

    // The dialogs read the account's words wherever the panel is drawn: Polar's
    // settings and Management do not carry them otherwise.
    return (
        <Messages namespaces={["account", "badges", "validation"]}>
            <ConnectionHub>
                <div className="flex flex-col gap-4">
                    <ProviderLogins actions={actions.logins} />
                    <CloudAccounts actions={actions.clouds} />
                    <ModelKeysView
                        providers={[...providerRowsFor(keys.map((key) => key.provider)), ...signinProviderRows()]}
                        searchProviders={searchKeyProvidersAction}
                        keys={rows}
                        health={health}
                        narrow={narrow}
                        connectOptions={connectOptions(assisted)}
                        actions={actions.keys}
                        copy={{ ...words, empty: fallback?.covered && emptyShared ? emptyShared : words.empty }}
                        footer={owner.kind === "deployment" ? (shared ? owner.sharedFooter : owner.privateFooter) : undefined}
                        assist={
                            account && fallback
                                ? { signins: assisted, connected: fallback.connected, actions: account.signin }
                                : undefined
                        }
                        deployment={fallback?.deployment}
                    />
                    {after}
                </div>
            </ConnectionHub>
        </Messages>
    );
}

/** What an account's runs fall back to: the deployment's keys, and which of
 *  them a run of this person's would actually spend. */
async function accountFallback(userId: string, shared: boolean) {
    const t = await getTranslations("account");
    const [sources, held, fromPlatform, connected] = await Promise.all([
        keySourcesFor(userId),
        connectedProviders(),
        // What the deployment holds, asked as the deployment, so a row it covers
        // can say so instead of reading as missing. Empty when sharing is off.
        signinEnvsFor(INSTANCE),
        // The agents this person connected on their sessions' machine.
        homeSigninsOf(userId).catch(() => null)
    ]);
    const rows = held.map((slug) => ({ slug, name: modelProviderName(slug), yours: sources.get(slug) === "own" }));
    const coveredByDeployment = [...sources.values()].some((source) => source === "instance");
    return {
        covered: (shared && coveredByDeployment) || fromPlatform.size > 0,
        connected: connected ? [...connected] : null,
        deployment: {
            rows: shared ? rows : [],
            note: !shared
                ? t("aiKeys.fallback.notShared")
                : rows.length > 0
                  ? t("aiKeys.fallback.shared")
                  : t("aiKeys.fallback.noKeys")
        }
    };
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
