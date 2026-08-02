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
                title="Delete this project"
                description="Every environment, service, volume record, variable and deploy log in it goes. There is no undo and no export afterwards."
            >
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                        {settings.environments.length}{" "}
                        {settings.environments.length === 1 ? "environment" : "environments"} - {settings.serviceCount}{" "}
                        {settings.serviceCount === 1 ? "service" : "services"}
                    </p>
                    {isOwner ? (
                        <Button variant="danger" onClick={() => setConfirming(true)} disabled={!canManage}>
                            <Trash2 className="size-4" /> Delete project
                        </Button>
                    ) : (
                        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <TriangleAlert className="size-3.5" />
                            Only {settings.ownerName}, who owns this project, can delete it.
                        </p>
                    )}
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
            </SettingsCard>

            <p className="text-xs text-muted-foreground">
                Removing a single service is done from the service itself, and is staged so it can be reviewed before it
                takes effect.
            </p>

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={settings.name}
                kind="project"
                description="This is immediate. Unlike removing a service, it is not staged and there is nothing to review afterwards."
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}
