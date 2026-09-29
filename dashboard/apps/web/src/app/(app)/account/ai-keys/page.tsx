/**
 * AI provider keys (/account/ai-keys): the provider accounts this person's AI
 * work bills to, and the order they are tried in.
 *
 * An account setting rather than a feature of the Agents app, because it is the
 * same answer wherever Polaris asks a model something: a key you brought is used
 * first, and the deployment's is the fallback for a provider you have not brought
 * one for.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Badge, Card, CardBody } from "@polaris/ui";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { assistedSignins } from "@/lib/agents/signin-runtime";
import { signinProviderRows } from "@/lib/agents/agent-signins";
import { ModelKeysView } from "@/components/model-keys/model-keys-view";
import { modelProviderName, modelProviderRows } from "@/lib/agents/model-key-providers";
import {
    instanceKeysAreShared,
    keySourcesFor,
    listAgentSignins,
    listProviderKeys,
    signinEnvsFor,
    INSTANCE
} from "@/lib/agents/model-keys";
import {
    addModelKeyAction,
    agentSigninIdentityAction,
    agentSigninScreenAction,
    answerAgentSigninAction,
    beginAgentSigninAction,
    deleteModelKeyAction,
    endAgentSigninAction,
    reorderModelKeysAction,
    updateModelKeyAction
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AiKeysPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    // Two listings rather than one filtered afterwards: agent sign-ins live in
    // the same table as provider keys and would otherwise be drawn in the
    // provider table as a credential for a provider that does not exist.
    const [keys, signins, sources, shared, fromPlatform] = await Promise.all([
        listProviderKeys(user.id),
        listAgentSignins(user.id),
        keySourcesFor(user.id),
        instanceKeysAreShared(),
        // What the deployment holds, asked as the deployment rather than as this
        // person, so a row it covers can say so instead of reading as missing.
        // Empty when sharing is off - the resolver checks that itself, which is
        // the same check that decides whether a session would actually get one.
        signinEnvsFor(INSTANCE)
    ]);

    const covered = [...sources.entries()]
        .filter(([, source]) => source === "instance")
        .map(([slug]) => modelProviderName(slug));

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("aiKeys.page.title")}</h1>
                <p className="text-muted-foreground text-sm">{t("aiKeys.page.intro")}</p>
            </div>
            <ModelKeysView
                providers={modelProviderRows()}
                keys={keys}
                actions={{
                    add: addModelKeyAction,
                    update: updateModelKeyAction,
                    remove: deleteModelKeyAction,
                    reorder: reorderModelKeysAction
                }}
                copy={{
                    title: t("aiKeys.keys.title"),
                    hint: t("aiKeys.keys.hint"),
                    empty: shared && covered.length > 0 ? t("aiKeys.keys.emptyShared") : t("aiKeys.keys.empty"),
                    adding: t("aiKeys.keys.adding")
                }}
                footer={<FallbackCard providers={covered} shared={shared} t={t} />}
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
                actions={{
                    add: addModelKeyAction,
                    update: updateModelKeyAction,
                    remove: deleteModelKeyAction,
                    reorder: reorderModelKeysAction
                }}
                copy={{
                    title: t("aiKeys.accounts.title"),
                    action: t("aiKeys.accounts.add"),
                    hint: t("aiKeys.accounts.hint"),
                    empty: fromPlatform.size > 0 ? t("aiKeys.accounts.emptyShared") : t("aiKeys.accounts.empty"),
                    adding: t("aiKeys.accounts.adding")
                }}
                assist={{
                    signins: assistedSignins(),
                    actions: {
                        begin: beginAgentSigninAction,
                        screen: agentSigninScreenAction,
                        answer: answerAgentSigninAction,
                        identity: agentSigninIdentityAction,
                        end: endAgentSigninAction
                    }
                }}
            />
        </div>
    );
}

/** What happens for a provider this account has brought no key for. */
function FallbackCard({
    providers,
    shared,
    t
}: {
    providers: string[];
    shared: boolean;
    t: NamespaceTranslator<"account">;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <h2 className="text-sm font-medium">{t("aiKeys.fallback.title")}</h2>
                {shared && providers.length > 0 ? (
                    <>
                        <p className="text-muted-foreground text-xs">{t("aiKeys.fallback.shared")}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                            {providers.map((name) => (
                                <Badge key={name} variant="neutral">
                                    {name}
                                </Badge>
                            ))}
                        </div>
                    </>
                ) : (
                    <p className="text-muted-foreground text-xs">
                        {shared ? t("aiKeys.fallback.noKeys") : t("aiKeys.fallback.notShared")}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
