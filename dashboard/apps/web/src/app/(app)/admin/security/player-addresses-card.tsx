"use client";

/**
 * Whether game server managers see where other people sign in from.
 *
 * Saved as it is flipped, since it is one answer with nothing to fill in beside
 * it; a save that fails puts the switch back where it was and says so.
 */

import { useState, useTransition } from "react";
import { Card, CardBody, Switch } from "@polaris/ui";
import { savePlayerAddressesSharedAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Feedback } from "@/app/(app)/account/security/setting-card";

export function PlayerAddressesCard({ shared }: { shared: boolean }) {
    const t = useTranslations("admin");
    const [on, setOn] = useState(shared);
    const [error, setError] = useState<string | null>(null);
    const [pending, startSaving] = useTransition();

    function change(next: boolean) {
        const previous = on;
        setOn(next);
        setError(null);
        startSaving(async () => {
            try {
                const result = await savePlayerAddressesSharedAction(next);
                if (result.error) {
                    setOn(previous);
                    setError(result.error);
                }
            } catch {
                setOn(previous);
                setError(t("security.errors.saveFailed"));
            }
        });
    }

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
                        disabled={pending}
                        onChange={change}
                        aria-label={t("security.playerAddresses.title")}
                    />
                </div>
                <Feedback error={error ?? undefined} />
            </CardBody>
        </Card>
    );
}
