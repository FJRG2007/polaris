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
import { Badge, Card, CardBody } from "@polaris/ui";
import { agentSignins } from "@/lib/agents/agent-signins";
import { ModelKeysView } from "@/components/model-keys/model-keys-view";
import { AgentSigninsCard } from "@/components/model-keys/agent-signins-card";
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
                <h1 className="text-[17px] font-semibold tracking-tight">AI provider keys</h1>
                <p className="text-muted-foreground text-sm">
                    The provider accounts your AI work bills to. A key you add here is used before anything the
                    deployment holds.
                </p>
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
                    title: "Your provider keys",
                    hint: "Tried from the top. The first key whose provider serves the model is the one a run uses.",
                    empty:
                        shared && covered.length > 0
                            ? "No keys of your own. Runs use the deployment's."
                            : "No keys yet. A run needs one to reach a provider.",
                    adding: "The provider account your runs bill to. Polaris adds nothing to that bill."
                }}
                footer={
                    <>
                        <AgentSigninsCard
                            signins={agentSignins()}
                            stored={signins.map((row) => ({ id: row.id, provider: row.provider }))}
                            platform={[...fromPlatform]}
                            actions={{
                                add: addModelKeyAction,
                                remove: deleteModelKeyAction,
                                // Only here. On the deployment's own screen an
                                // administrator would be asked to authorise a
                                // subscription that is not theirs, in their own
                                // browser, which is the wrong person entirely.
                                assist: {
                                    begin: beginAgentSigninAction,
                                    screen: agentSigninScreenAction,
                                    answer: answerAgentSigninAction,
                                    end: endAgentSigninAction
                                }
                            }}
                        />
                        <FallbackCard providers={covered} shared={shared} />
                    </>
                }
            />
        </div>
    );
}

/** What happens for a provider this account has brought no key for. */
function FallbackCard({ providers, shared }: { providers: string[]; shared: boolean }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <h2 className="text-sm font-medium">What a run falls back to</h2>
                {shared && providers.length > 0 ? (
                    <>
                        <p className="text-muted-foreground text-xs">
                            For a provider you have no key of your own for, runs use the deployment&apos;s.
                        </p>
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
                        {shared
                            ? "This deployment holds no provider keys, so a run can only use one you add here."
                            : "This deployment does not share its own provider keys, so a run can only use one you add here."}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
