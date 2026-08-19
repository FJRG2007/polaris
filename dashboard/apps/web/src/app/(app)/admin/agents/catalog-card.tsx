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
import { refreshModelCatalogAction, setInstanceKeySharingAction } from "./actions";

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
                const result = await runAction(() => setInstanceKeySharingAction({ shared: next }), setError);
                if (!result || result.error) setOn(!next);
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">Share this deployment&apos;s provider keys</p>
                        <p className="text-muted-foreground text-xs">
                            {on
                                ? "Anybody without a key of their own runs on the keys stored under Integrations, and those accounts are billed to you."
                                : "Runs only use keys people add themselves, under Account > AI provider keys. Nobody spends this deployment's providers."}
                        </p>
                    </div>
                    <Switch checked={on} onChange={toggle} disabled={pending} aria-label="Share provider keys" />
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

export function CatalogCard({ models, refreshedAt }: { models: number; refreshedAt: string | null }) {
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
