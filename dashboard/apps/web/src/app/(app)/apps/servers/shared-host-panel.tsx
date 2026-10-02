"use client";

/**
 * Whether this server is shared with containers Polaris did not start. When it is,
 * Polaris's clean-up only removes images and build cache, and never a stopped
 * container or a network nothing is attached to - those may be the operator's own.
 * Saved as it is switched, and put back if the save is refused.
 */

import { Switch } from "@polaris/ui";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setSharedHostAction, sharedHostAction } from "./actions";

export function SharedHostPanel({ hostId }: { hostId: string }) {
    const t = useTranslations("servers");
    const [shared, setShared] = useState<boolean | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let active = true;
        void sharedHostAction(hostId)
            .then((result) => {
                if (!active) return;
                if (result.shared !== undefined) setShared(result.shared);
                else setError(result.error ?? t("shared.loadFailed"));
            })
            .catch(() => active && setError(t("shared.loadFailed")));
        return () => {
            active = false;
        };
    }, [hostId, t]);

    async function toggle(next: boolean) {
        const before = shared;
        setError("");
        setShared(next);
        const result = await setSharedHostAction(hostId, next).catch(() => ({
            error: t("shared.saveFailed")
        }));
        if (result.error) {
            setShared(before);
            setError(result.error);
        }
    }

    return (
        <section className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium">{t("shared.title")}</h3>
                    <p className="text-xs text-muted-foreground">{t("shared.hint")}</p>
                </div>
                {shared === null && !error ? (
                    <div
                        className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted"
                        aria-busy="true"
                    />
                ) : (
                    <Switch
                        checked={shared === true}
                        onChange={(next) => void toggle(next)}
                        disabled={shared === null}
                        aria-label={t("shared.title")}
                    />
                )}
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
        </section>
    );
}
