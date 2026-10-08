"use client";

/**
 * The deployment's seasonal switch. Saved the moment it moves, put back if the
 * save is refused.
 */

import { useState, useTransition } from "react";
import { Card, CardBody, CardHeader, CardTitle, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setSeasonsAllowedAction } from "./seasonal-actions";

export function SeasonalAdminCard({ initial }: { initial: boolean }) {
    const t = useTranslations("admin");
    const [allowed, setAllowed] = useState(initial);
    const [error, setError] = useState("");
    const [, startSaving] = useTransition();

    function toggle(next: boolean) {
        setAllowed(next);
        setError("");
        startSaving(async () => {
            const result = await setSeasonsAllowedAction(next).catch(() => ({
                error: t("settings.seasonal.notSaved")
            }));
            if (result.error) {
                setError(result.error);
                setAllowed(!next);
            }
        });
    }

    return (
        <Card className="mt-4">
            <CardHeader>
                <CardTitle>{t("settings.seasonal.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("settings.seasonal.body")}</p>
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("settings.seasonal.label")}</p>
                        <p className="text-xs text-muted-foreground">
                            {allowed ? t("settings.seasonal.on") : t("settings.seasonal.off")}
                        </p>
                    </div>
                    <Switch
                        checked={allowed}
                        onChange={toggle}
                        aria-label={t("settings.seasonal.label")}
                    />
                </div>
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}
