/**
 * The model providers agents run on. Their own screen rather than a category in
 * the marketplace: there are more of them than of everything else put together,
 * and connecting one is a different job from connecting a service - no accounts
 * to link, no permissions to grant, just a key and the order they are tried in.
 * Admin-only, because a key here is the whole deployment's.
 *
 * The same screen an account gets for its own keys, because it is the same job.
 * The deployment's keys were once one per provider with no name, no end date and
 * no second key, which made an administrator's credentials the only ones nobody
 * could keep a spare of.
 */

import Link from "next/link";
import { Card, CardBody } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { modelProviderRows } from "@/lib/agents/model-key-providers";
import { signinProviderRows } from "@/lib/agents/agent-signins";
import { ModelKeysView } from "@/components/model-keys/model-keys-view";
import { instanceKeysAreShared, INSTANCE, listAgentSignins, listProviderKeys } from "@/lib/agents/model-keys";
import {
    addInstanceModelKeyAction,
    deleteInstanceModelKeyAction,
    reorderInstanceModelKeysAction,
    updateInstanceModelKeyAction
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ModelProvidersPage() {
    await requireAdmin();
    // Two listings rather than one filtered afterwards: agent sign-ins share this
    // table and would otherwise appear in the provider list as a credential for a
    // provider that does not exist.
    const [keys, signins, shared] = await Promise.all([
        listProviderKeys(INSTANCE),
        listAgentSignins(INSTANCE),
        instanceKeysAreShared()
    ]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">AI providers</h1>
                <p className="text-muted-foreground text-sm">
                    This deployment&apos;s own accounts with the model providers. A key is handed to a run over
                    an authenticated call and never written into a repository, so replacing it here takes effect
                    everywhere at once. Every provider bills you directly - Polaris adds nothing.
                </p>
            </div>
            <ModelKeysView
                providers={modelProviderRows()}
                keys={keys}
                actions={{
                    add: addInstanceModelKeyAction,
                    update: updateInstanceModelKeyAction,
                    remove: deleteInstanceModelKeyAction,
                    reorder: reorderInstanceModelKeysAction
                }}
                copy={{
                    title: "The deployment's provider keys",
                    hint: "Tried from the top. The first key whose provider serves the model is the one a run uses.",
                    empty: "No keys yet. Without one, only people who bring their own can run anything.",
                    adding: "The provider account this deployment's runs bill to."
                }}
                footer={<SharingCard shared={shared} />}
            />

            {/* The deployment's own agent accounts, in the same table and for the
                same reason the provider keys are in one: everything about them is
                a key - named, reordered, renamed, given an end date, shown with
                its last use - and a card of its own would have had to grow every
                one of those separately and still look like a different feature.
                No assisted sign-in here: an administrator would be asked to
                authorise a subscription that is not theirs, in their own browser. */}
            <ModelKeysView
                providers={signinProviderRows()}
                keys={signins}
                actions={{
                    add: addInstanceModelKeyAction,
                    update: updateInstanceModelKeyAction,
                    remove: deleteInstanceModelKeyAction,
                    reorder: reorderInstanceModelKeysAction
                }}
                copy={{
                    title: "The deployment's agent accounts",
                    hint: "Signs an agent in for anybody whose own account does not. Each account's own is tried first.",
                    empty: "None yet. Without one, only people who bring their own can start a session here.",
                    adding: "The account this deployment's sessions sign an agent in with."
                }}
            />
            <p className="text-muted-foreground text-sm">
                Everything else Polaris connects to lives under{" "}
                <Link href="/admin/integrations" className="text-primary hover:underline">
                    Integrations
                </Link>
                .
            </p>
        </div>
    );
}

/** Who actually spends these. The switch itself is one of the agent defaults, so
 *  it is named here rather than offered twice. */
function SharingCard({ shared }: { shared: boolean }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <h2 className="text-sm font-medium">Who these keys run for</h2>
                <p className="text-muted-foreground text-xs">
                    {shared
                        ? "Anybody whose own keys do not cover a provider runs on these, and the bill is yours. Each account's own keys are used first."
                        : "Nobody but you. Runs use only the keys people add themselves, so a provider nobody has a key for cannot be reached."}{" "}
                    <Link href="/admin/agents" className="text-primary hover:underline">
                        Change this under Agent defaults
                    </Link>
                    .
                </p>
            </CardBody>
        </Card>
    );
}
