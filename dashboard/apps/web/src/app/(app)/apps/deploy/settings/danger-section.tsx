"use client";

/**
 * Danger: the things that cannot be taken back.
 *
 * Deleting a project is the owner's alone. Being an admin on somebody else's
 * project is enough to change everything inside it and deliberately not enough to
 * remove the thing itself - so an admin who is not the owner is told that rather
 * than shown a button that will fail.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteProjectAction } from "../actions";
import { SettingsCard } from "../project-settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Trash2, TriangleAlert } from "lucide-react";
import { Button, ConfirmDeleteDialog } from "@polaris/ui";
import type { ProjectSettingsView } from "@/lib/deploy-project-service";

export function DangerSection({
    settings,
    canManage,
    isOwner
}: {
    settings: ProjectSettingsView;
    canManage: boolean;
    isOwner: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("deploySettings");
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function remove() {
        setError(null);
        startTransition(async () => {
            const result = await deleteProjectAction(settings.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.push("/apps/deploy");
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                tone="danger"
                title={t("danger.title")}
                description={t("danger.description")}
            >
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                        {t("danger.counts", { environments: settings.environments.length, services: settings.serviceCount })}
                    </p>
                    {isOwner ? (
                        <Button variant="danger" onClick={() => setConfirming(true)} disabled={!canManage}>
                            <Trash2 className="size-4" /> {t("danger.delete")}
                        </Button>
                    ) : (
                        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <TriangleAlert className="size-3.5" />
                            {t("danger.ownerOnly", { owner: settings.ownerName })}
                        </p>
                    )}
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
            </SettingsCard>

            <p className="text-xs text-muted-foreground">
                {t("danger.singleService")}
            </p>

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={settings.name}
                kind="project"
                title={t("danger.delete")}
                confirmLabel={t("danger.delete")}
                description={t("danger.confirmDescription")}
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}
