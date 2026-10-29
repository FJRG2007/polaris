"use client";

/**
 * The Drive settings card. A switch saves the moment it is pressed, shows the
 * new position at once, and goes back with a message if the save fails.
 */

import { useState, useTransition } from "react";
import { setConfirmTrashAction } from "./actions";
import type { DrivePreferences } from "@/lib/drive-preferences";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, Switch } from "@polaris/ui";

export function DriveSettings({ initial }: { initial: DrivePreferences }) {
    const t = useTranslations("drive");
    const [confirmTrash, setConfirmTrash] = useState(initial.confirmTrash);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const change = (next: boolean) => {
        if (next === confirmTrash) return;
        const before = confirmTrash;
        setConfirmTrash(next);
        setError(null);
        startTransition(async () => {
            const result = await setConfirmTrashAction(next).catch(() => ({ error: "failed" }));
            if ("error" in result) {
                setConfirmTrash(before);
                setError(t("settings.saveFailed"));
            }
        });
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-1">
                        <span id="drive-confirm-trash" className="text-sm font-medium">
                            {t("settings.confirmTrash")}
                        </span>
                        <span
                            id="drive-confirm-trash-hint"
                            className="text-muted-foreground text-sm"
                        >
                            {t("settings.confirmTrashHint")}
                        </span>
                    </div>
                    <Switch
                        checked={confirmTrash}
                        onChange={change}
                        disabled={pending}
                        aria-label={t("settings.confirmTrash")}
                        aria-describedby="drive-confirm-trash-hint"
                    />
                </div>
                {error ? (
                    <p role="alert" className="text-danger text-sm">
                        {error}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}
