"use client";

/**
 * A server standing on a map that only works on one release, running another.
 *
 * A map's release is decided when the server is created on it, so a server made
 * before its map was held to a release - or moved off it in Settings since - keeps
 * running one the map breaks on, and nothing about the world says why. This says
 * it where the map is described, and the button puts the server on the map's
 * release with the same save the Settings tab makes.
 */

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useGameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { Button, Card, CardBody } from "@polaris/ui";
import { updateServerSettingsAction } from "./minecraft-actions";

const { useConfirm } = hostUi.confirmDialog;

export function MapReleaseNotice({
    installedAppId,
    mapName,
    pinned,
    current,
    running,
    canManage,
    onSaved
}: {
    installedAppId: string;
    mapName: string;
    /** The release the map works on. */
    pinned: string;
    /** The release the server is set to. */
    current: string;
    running: boolean;
    canManage: boolean;
    onSaved: () => void;
}) {
    const t = useGameText("minecraft");
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    if (current.trim() === pinned) return null;

    async function move(): Promise<void> {
        setError(null);
        if (
            running &&
            !(await confirm({
                title: t("mapRelease.confirmTitle", { version: pinned }),
                description: t("mapRelease.confirmText"),
                confirmLabel: t("mapRelease.switch", { version: pinned })
            }))
        )
            return;
        startTransition(async () => {
            const result = await updateServerSettingsAction(
                installedAppId,
                [{ key: "VERSION", value: pinned }],
                running
            );
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    return (
        <Card className="lg:col-span-2 border-warning-edge">
            <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                    {t("mapRelease.title", { map: mapName, version: pinned })}
                </p>
                <p className="text-sm text-muted-foreground">
                    {t("mapRelease.text", {
                        current: current.trim() || t("mapRelease.latest"),
                        version: pinned
                    })}
                </p>
                {error && <p className="text-sm text-destructive">{error}</p>}
                {canManage ? (
                    <Button
                        size="sm"
                        className="self-start"
                        disabled={pending}
                        onClick={() => void move()}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        {t("mapRelease.switch", { version: pinned })}
                    </Button>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("mapRelease.askManager")}</p>
                )}
            </CardBody>
            {confirmElement}
        </Card>
    );
}
