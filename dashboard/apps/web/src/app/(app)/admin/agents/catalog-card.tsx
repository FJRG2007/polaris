"use client";

/**
 * The model catalogue, and when it was last read.
 *
 * It refreshes itself daily, so this exists for the two moments waiting is the
 * wrong answer: a deployment that has just come up and has nothing yet, and a
 * model released this morning that somebody wants to pick today. The count is
 * here because an empty catalogue is otherwise invisible - the pickers simply
 * offer less, and nobody would know to look.
 */

import { RefreshCw } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { Button, Card, CardBody, Switch } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import {
    refreshModelCatalogAction,
    setInstanceKeySharingAction,
    setSharedWorkspaceAction
} from "./actions";

/**
 * Whether an account with no key of its own runs on the deployment's.
 *
 * Sits beside the catalogue because both answer the same question from
 * different ends: which models can be picked, and whose account pays when one
 * is. Turning it off does not break a deployment quietly - accounts that have
 * brought their own keys keep working, and the ones that have not are told on
 * their own AI provider keys screen.
 */
export function KeySharingCard({ shared }: { shared: boolean }) {
    const [on, setOn] = useState(shared);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const toggle = (next: boolean) => {
        setError(null);
        // Optimistic, with the switch put back if the write is refused.
        setOn(next);
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () => setInstanceKeySharingAction({ shared: next }),
                    setError
                );
                if (!result || result.error) setOn(!next);
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">
                            Share this deployment&apos;s provider keys
                        </p>
                        <p className="text-muted-foreground text-xs">
                            {on
                                ? "Anybody without a key of their own runs on the keys stored under Integrations, and those accounts are billed to you."
                                : "Runs only use keys people add themselves, under Account > AI provider keys. Nobody spends this deployment's providers."}
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        onChange={toggle}
                        disabled={pending}
                        aria-label="Share provider keys"
                    />
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

/**
 * Whether this deployment offers a machine everybody shares.
 *
 * The copy says what it actually means rather than what it is called, because
 * what it is called sounds administrative and what it means is not: one home,
 * so a subscription signed in there is signed in for everybody who can open it,
 * and the files one person leaves are the files the next person finds. That is
 * right for a team on one subscription and wrong for a deployment of separate
 * people, and only an administrator knows which of those this is.
 *
 * And it says the part that costs money rather than privacy. A personal Claude
 * or ChatGPT subscription is licensed to one person; several people working
 * through one of them is what account-sharing enforcement is for, and the way
 * that ends is the subscription being suspended rather than a warning. A key or
 * a team plan is billed for exactly this and cannot be lost this way. Nobody
 * reads terms before flipping a switch, so the switch says it.
 */
export function SharedWorkspaceCard({ allowed }: { allowed: boolean }) {
    const [on, setOn] = useState(allowed);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const toggle = (next: boolean) => {
        setError(null);
        setOn(next);
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () => setSharedWorkspaceAction({ allowed: next }),
                    setError
                );
                if (!result || result.error) setOn(!next);
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">Offer a machine everybody shares</p>
                        <p className="text-muted-foreground text-xs">
                            {on
                                ? "Anybody who can start a session can open the shared machine. It has one home: what is signed in there is signed in for all of them, and the files one person leaves are the files the next one finds."
                                : "Every session opens on a machine of its own account, with its own logins and its own files. Nobody can reach anybody else's."}
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        onChange={toggle}
                        disabled={pending}
                        aria-label="Offer a shared machine"
                    />
                </div>
                {/* The part that costs the subscription rather than the privacy,
                    said where the decision is made. A personal plan is licensed
                    to one person and several people working through it is what
                    account-sharing enforcement exists for - and it ends in a
                    suspension, not a warning. */}
                {on ? (
                    <p className="text-xs text-amber-400">
                        Sign it in with an API key or a team plan. A personal Claude or ChatGPT
                        subscription is licensed to one person, and several people working through
                        one is what gets it suspended.
                    </p>
                ) : null}
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

export function CatalogCard({
    models,
    refreshedAt
}: {
    models: number;
    refreshedAt: string | null;
}) {
    const [count, setCount] = useState(models);
    const [at, setAt] = useState(refreshedAt);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const format = useDisplayFormat();

    const refresh = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => refreshModelCatalogAction(), setError);
                if (result?.models !== undefined) {
                    setCount(result.models);
                    setAt(result.at ?? null);
                }
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">Model catalog</p>
                        <p className="text-muted-foreground text-xs">
                            {count === 0
                                ? "Nothing downloaded yet, so the model pickers offer only what you type. It refreshes itself once a day."
                                : `${count} models across the providers Polaris supports. Refreshes itself once a day.`}
                        </p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={refresh} disabled={pending}>
                        <RefreshCw className={`size-4 shrink-0 ${pending ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                </div>
                {at ? (
                    <p className="text-muted-foreground text-xs">
                        Last read <time dateTime={at}>{format.dateTime(at)}</time>.
                    </p>
                ) : null}
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
