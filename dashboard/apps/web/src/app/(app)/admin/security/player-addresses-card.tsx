"use client";

/**
 * Whether game server managers see where other people sign in from.
 *
 * Saved as it is flipped, since it is one answer with nothing to fill in beside
 * it; a save that fails puts the switch back where it was and says so.
 */

import { useOptimisticToggle } from "@polaris/ui";
import { useState } from "react";
import { Card, CardBody, Switch } from "@polaris/ui";
import { savePlayerAddressesSharedAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Feedback } from "@/app/(app)/account/security/setting-card";

export function PlayerAddressesCard({ shared }: { shared: boolean }) {
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);

    const [on, toggle] = useOptimisticToggle(
        shared,
        async (next) => {
            setError(null);
            return savePlayerAddressesSharedAction(next);
        },
        { onRefused: setError, failure: t("security.errors.saveFailed") }
    );

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-sm font-medium">{t("security.playerAddresses.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("security.playerAddresses.hint")}</p>
                    </div>
                    <Switch
                        checked={on}
                        onChange={toggle}
                        aria-label={t("security.playerAddresses.title")}
                    />
                </div>
                <Feedback error={error ?? undefined} />
            </CardBody>
        </Card>
    );
}
