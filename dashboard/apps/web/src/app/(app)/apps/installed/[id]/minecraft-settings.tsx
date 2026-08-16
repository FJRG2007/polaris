"use client";

/**
 * The server's settings, as the image takes them: environment the container is
 * built with, written into its own config when it boots. Nothing here reaches a
 * running server, so applying a change means restarting - and that disconnects
 * whoever is playing.
 *
 * Which is why saving and restarting are two decisions rather than one. Somebody
 * writing a description at four in the afternoon should not have to choose between
 * losing it and ending everybody's evening: the value is stored either way, the
 * next start picks it up whenever that is, and the restart can be had now, when the
 * last person leaves, or at a time.
 */

import { RestartPlanner } from "./restart-planner";
import { Loader2, RotateCw, Save } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { updateServerSettingsAction } from "./minecraft-actions";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import type { InstalledAppSetting } from "@/lib/apps/install-service";

export function MinecraftSettings({
    installedAppId,
    settings,
    playersOnline,
    running = true,
    onSaved
}: {
    installedAppId: string;
    settings: InstalledAppSetting[];
    playersOnline: number;
    /** Whether the server is up. A stopped one needs no restart at all: what was
     *  saved is what it will start with. */
    running?: boolean;
    onSaved: () => void;
}) {
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(settings.map((setting) => [setting.key, setting.value]))
    );
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    /** Something was saved and deliberately not applied, so the restart card is
     *  what turns it into a running server. */
    const [waiting, setWaiting] = useState(false);

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

    async function save(restart: boolean): Promise<void> {
        setError(null);
        const warning =
            playersOnline > 0
                ? `${playersOnline} ${playersOnline === 1 ? "player is" : "players are"} connected and will be disconnected.`
                : "The server restarts to pick the new settings up.";
        // Only the restart is worth asking about. Saving a value the server will
        // read at its next start costs nobody anything.
        if (
            restart &&
            !(await confirm({
                title: "Restart with the new settings?",
                description: warning,
                confirmLabel: "Save and restart"
            }))
        ) {
            return;
        }
        startTransition(async () => {
            const result = await updateServerSettingsAction(
                installedAppId,
                changed.map((setting) => ({ key: setting.key, value: values[setting.key] ?? "" })),
                restart
            );
            if (result.error) {
                setError(result.error);
                return;
            }
            // Saved and not applied: the card below is how it gets applied later.
            setWaiting(!restart && running);
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

            {/* Saved and waiting: now, when the last person leaves, or at a time. */}
            <RestartPlanner
                installedAppId={installedAppId}
                running={running}
                changed={waiting}
                reason="a settings change"
                onRestarted={() => {
                    setWaiting(false);
                    onSaved();
                }}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {changed.length === 0
                        ? "Nothing to save."
                        : `${changed.length} ${changed.length === 1 ? "change" : "changes"} the server picks up when it next starts.`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    {/* Storing a value and applying it are two decisions. Saving
                        alone disconnects nobody, and the next start reads it
                        whenever that is. */}
                    <Button
                        variant="secondary"
                        onClick={() => void save(false)}
                        disabled={pending || changed.length === 0}
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        Save
                    </Button>
                    <Button onClick={() => void save(true)} disabled={pending || changed.length === 0}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                        Save and restart
                    </Button>
                </div>
            </div>

            {confirmElement}
        </div>
    );
}
