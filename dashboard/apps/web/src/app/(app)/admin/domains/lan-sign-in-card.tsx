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
import { Download } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { cn, settingType, Skeleton, Switch, useOptimisticToggle } from "@polaris/ui";
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
    const [error, setError] = useState("");
    const [enabled, toggle] = useOptimisticToggle(
        view?.enabled ?? true,
        async (next) => {
            setError("");
            const result = await runAction(() => setLanSignInAction(next), setError);
            if (!result || result.error) return result ?? { error: true };
            if (!result.view) return { ok: false };
            onSaved(result.view);
            return null;
        },
        { onRefused: setError }
    );

    return (
        <PageSection
            id="lan-sign-in"
            title={t("domains.lanSignIn.title")}
            description={t("domains.lanSignIn.description")}
            actions={
                <Switch
                    checked={enabled}
                    disabled={!view}
                    onChange={toggle}
                    aria-label={t("domains.lanSignIn.toggle")}
                />
            }
        >
            {!view ? (
                <Skeleton className="h-4 w-64" />
            ) : (
                <div className={cn(settingType.body, "flex flex-col gap-2")}>
                    {view.addresses.length === 0 ? (
                        <p className={settingType.hint}>
                            {t("domains.lanSignIn.noAddress")}
                        </p>
                    ) : (
                        <>
                            <p className={settingType.hint}>
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
                            {/* These addresses carry the local CA's certificate: with
                                its root installed they open with no warning at all. */}
                            <a
                                href="/api/system/local-ca"
                                className={cn(settingType.small, "inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-muted")}
                            >
                                <Download className="size-3.5 shrink-0" aria-hidden />
                                {t("domains.certificate.download")}
                            </a>
                        </>
                    )}
                    {error ? (
                        <p role="alert" className={settingType.error}>
                            {error}
                        </p>
                    ) : null}
                </div>
            )}
        </PageSection>
    );
}
