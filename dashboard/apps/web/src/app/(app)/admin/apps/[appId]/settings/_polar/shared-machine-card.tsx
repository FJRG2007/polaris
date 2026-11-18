"use client";

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Card, CardBody, Switch, useOptimisticToggle } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setSharedWorkspaceAction } from "./actions";

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
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);
    const [on, toggle] = useOptimisticToggle(
        allowed,
        async (next) => {
            setError(null);
            return (
                (await runAction(() => setSharedWorkspaceAction({ allowed: next }), setError)) ?? {
                    error: true
                }
            );
        },
        { onRefused: setError }
    );

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">{t("agents.sharedMachine.label")}</p>
                        <p className="text-muted-foreground text-xs">
                            {on
                                ? t("agents.sharedMachine.on")
                                : t("agents.sharedMachine.off")}
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        onChange={toggle}
                        aria-label={t("agents.sharedMachine.switch")}
                    />
                </div>
                {/* The part that costs the subscription rather than the privacy,
                    said where the decision is made. A personal plan is licensed
                    to one person and several people working through it is what
                    account-sharing enforcement exists for - and it ends in a
                    suspension, not a warning. */}
                {on ? (
                    <p className="text-xs text-warning">{t("agents.sharedMachine.warning")}</p>
                ) : null}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
