"use client";

/**
 * The deployment's default routing: what an account that set none of its own
 * falls back through, and where a coding tool's request lands. The same editor
 * a person has in Polar's settings, offering the deployment's keys only.
 */

import { useState, useTransition } from "react";
import { runAction } from "@/lib/run-action";
import { Card, CardBody } from "@polaris/ui";
import type { PolarRouting } from "@/lib/polar/routing";
import type { RouteKeyOption } from "@/lib/polar/routing-keys";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { RoutingEditor } from "@/components/polar/routing-editor";
import { useSettingsModels } from "@/components/polar/settings-models";
import { saveInstanceRoutingAction } from "./actions";

export function RoutingCard({
    routing,
    keys
}: {
    routing: PolarRouting;
    keys: RouteKeyOption[];
}) {
    const t = useTranslations("polar");
    const { answer } = useSettingsModels();
    const [current, setCurrent] = useState(routing);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const save = (next: PolarRouting) => {
        const before = current;
        setError(null);
        // Optimistic, with the routing put back if the write is refused.
        setCurrent(next);
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => saveInstanceRoutingAction(next), setError);
                if (!result || result.error) {
                    setCurrent(before);
                    if (result?.error) setError(result.error);
                }
            })();
        });
    };

    return (
        <Card>
            <CardBody className="flex min-w-0 flex-col gap-4">
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{t("routing.admin.title")}</p>
                    <p className="text-muted-foreground text-xs">{t("routing.admin.intro")}</p>
                </div>
                {error ? (
                    <p className="text-danger text-xs" role="alert">
                        {error}
                    </p>
                ) : null}
                <RoutingEditor
                    value={current}
                    onChange={save}
                    providers={answer?.providers ?? null}
                    keys={keys}
                />
            </CardBody>
        </Card>
    );
}
