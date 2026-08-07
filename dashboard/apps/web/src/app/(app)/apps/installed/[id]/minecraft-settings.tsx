"use client";

/**
 * The server's settings, as the image takes them: environment the container is
 * built with, written into server.properties when it boots. So saving restarts
 * the server, and the form says so before it does rather than after - a restart
 * disconnects whoever is playing.
 */

import { Loader2, RotateCw } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { updateServerSettingsAction } from "./minecraft-actions";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import type { InstalledAppSetting } from "@/lib/apps/install-service";

export function MinecraftSettings({
    installedAppId,
    settings,
    playersOnline,
    onSaved
}: {
    installedAppId: string;
    settings: InstalledAppSetting[];
    playersOnline: number;
    onSaved: () => void;
}) {
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(settings.map((setting) => [setting.key, setting.value]))
    );
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    // Dirty means the values differ from what the server is running on, not that
    // a field was touched: typing a value and putting it back leaves Save off.
    const changed = useMemo(
        () => settings.filter((setting) => (values[setting.key] ?? "") !== setting.value),
        [settings, values]
    );

    const groups = useMemo(() => {
        const order: string[] = [];
        const byGroup = new Map<string, InstalledAppSetting[]>();
        for (const setting of settings) {
            const group = setting.group ?? "Settings";
            if (!byGroup.has(group)) {
                byGroup.set(group, []);
                order.push(group);
            }
            byGroup.get(group)?.push(setting);
        }
        return order.map((group) => ({ group, fields: byGroup.get(group) ?? [] }));
    }, [settings]);

    async function save(): Promise<void> {
        setError(null);
        const warning =
            playersOnline > 0
                ? `${playersOnline} ${playersOnline === 1 ? "player is" : "players are"} connected and will be disconnected.`
                : "The server restarts to pick the new settings up.";
        if (!(await confirm({ title: "Restart with the new settings?", description: warning, confirmLabel: "Save and restart" }))) {
            return;
        }
        startTransition(async () => {
            const result = await updateServerSettingsAction(
                installedAppId,
                changed.map((setting) => ({ key: setting.key, value: values[setting.key] ?? "" }))
            );
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    if (settings.length === 0) {
        return (
            <Card>
                <CardBody className="py-8 text-center text-sm text-muted-foreground">
                    This server has no settings to change yet. Deploy it first.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {groups.map(({ group, fields }) => (
                <Card key={group}>
                    <CardBody className="flex flex-col gap-3">
                        <p className="text-sm font-medium">{group}</p>
                        {fields.map((field) => (
                            <label key={field.key} className="flex flex-col gap-1 text-sm">
                                <span>{field.label}</span>
                                {field.options ? (
                                    <Select
                                        value={values[field.key] ?? ""}
                                        onValueChange={(value) =>
                                            setValues((current) => ({ ...current, [field.key]: value }))
                                        }
                                        options={field.options}
                                    />
                                ) : (
                                    <Input
                                        value={values[field.key] ?? ""}
                                        onChange={(event) =>
                                            setValues((current) => ({ ...current, [field.key]: event.target.value }))
                                        }
                                    />
                                )}
                                {field.help && <span className="text-xs text-muted-foreground">{field.help}</span>}
                            </label>
                        ))}
                    </CardBody>
                </Card>
            ))}

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {changed.length === 0
                        ? "Nothing to save."
                        : `${changed.length} ${changed.length === 1 ? "change" : "changes"} pending a restart.`}
                </p>
                <Button onClick={() => void save()} disabled={pending || changed.length === 0}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                    Save and restart
                </Button>
            </div>

            {confirmElement}
        </div>
    );
}
