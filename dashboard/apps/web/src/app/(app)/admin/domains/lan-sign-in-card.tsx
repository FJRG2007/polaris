"use client";

/**
 * Whether people may sign in on this machine's own address on the local
 * network - `https://192.168.1.20` typed by hand, for a device where
 * `polaris.local` does not resolve.
 *
 * On unless an administrator turned it off. The switch flips at once and goes back
 * if the server refuses. The addresses it would accept are listed, each with a
 * link, so whoever turns it on can open one straight away.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Skeleton, Switch } from "@polaris/ui";
import { setLanSignInAction } from "./actions";
import type { LanSignInView } from "@/lib/lan-sign-in";
import { PageSection } from "@/components/page-section";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function LanSignInCard({
    view,
    onSaved
}: {
    /** Null while the panel's read is on its way, or from a copy kept before
     *  this setting existed. */
    view: LanSignInView | null | undefined;
    onSaved: (next: LanSignInView) => void;
}) {
    const t = useTranslations("admin");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [optimistic, setOptimistic] = useState<boolean | null>(null);
    const enabled = optimistic ?? view?.enabled ?? true;

    async function toggle(next: boolean) {
        if (!view || next === view.enabled) return;
        setOptimistic(next);
        setBusy(true);
        setError("");
        const result = await runAction(() => setLanSignInAction(next), setError);
        setBusy(false);
        setOptimistic(null);
        if (!result || result.error || !result.view) {
            if (result?.error) setError(result.error);
            return;
        }
        onSaved(result.view);
    }

    return (
        <PageSection
            id="lan-sign-in"
            title={t("domains.lanSignIn.title")}
            description={t("domains.lanSignIn.description")}
            actions={
                <Switch
                    checked={enabled}
                    disabled={!view || busy}
                    onChange={(next) => void toggle(next)}
                    aria-label={t("domains.lanSignIn.toggle")}
                />
            }
        >
            {!view ? (
                <Skeleton className="h-4 w-64" />
            ) : (
                <div className="flex flex-col gap-2 text-sm">
                    {view.addresses.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("domains.lanSignIn.noAddress")}
                        </p>
                    ) : (
                        <>
                            <p className="text-xs text-muted-foreground">
                                {enabled
                                    ? t("domains.lanSignIn.onHint")
                                    : t("domains.lanSignIn.offHint")}
                            </p>
                            <ul className="flex flex-wrap gap-x-4 gap-y-1">
                                {view.addresses.map((address) => (
                                    <li key={address} className="min-w-0">
                                        <a
                                            href={`https://${address}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="block truncate font-mono text-xs text-primary hover:underline"
                                        >
                                            https://{address}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
            )}
        </PageSection>
    );
}
