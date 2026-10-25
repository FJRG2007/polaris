"use client";

/**
 * An installed app whose code is not running here: why, and the button that
 * fixes it. Shown in place of the app's screen.
 *
 * Code that has not arrived yet gets Try again. Code that is here but cannot run
 * on this version of Polaris gets the update that fixes it - the app's own, or
 * Polaris's - for an administrator, and who to ask for everybody else.
 */

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpCircle, PackageX, RotateCw } from "lucide-react";
import { Button, EmptyState, buttonVariants } from "@polaris/ui";
import { retryAppAction } from "@/lib/app-bundles/actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Where an administrator updates Polaris and each app. */
export const APP_UPDATES_HREF = "/admin/settings#app-updates";

export function AppUnavailable({
    app,
    name,
    reason,
    update,
    canUpdate = false
}: {
    app: string;
    name: string;
    reason: string;
    update?: "dashboard" | "app";
    canUpdate?: boolean;
}) {
    const t = useTranslations("components");
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();

    const retry = () =>
        start(async () => {
            const result = await retryAppAction(app);
            if (result.error) setError(result.error);
            else router.refresh();
        });

    if (update) {
        const why = t(update === "app" ? "appBundles.appTooOld" : "appBundles.polarisTooOld", { name });
        const description = canUpdate ? why : `${why} ${t("appBundles.askAdmin")}`;
        return (
            <EmptyState
                icon={<ArrowUpCircle />}
                title={t("appBundles.needsUpdate", { name })}
                description={description}
                action={
                    canUpdate ? (
                        <Link href={APP_UPDATES_HREF} className={buttonVariants()}>
                            <ArrowUpCircle />
                            {update === "app"
                                ? t("appBundles.updateApp", { name })
                                : t("appBundles.updatePolaris")}
                        </Link>
                    ) : undefined
                }
            />
        );
    }

    return (
        <EmptyState
            icon={<PackageX />}
            title={t("appBundles.unavailable", { name })}
            description={error ?? reason}
            action={
                <Button onClick={retry} disabled={pending}>
                    <RotateCw className={pending ? "animate-spin" : undefined} />
                    {t("actions.tryAgain")}
                </Button>
            }
        />
    );
}
