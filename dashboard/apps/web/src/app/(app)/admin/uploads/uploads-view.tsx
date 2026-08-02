"use client";

/**
 * Where files people attach to their work are kept.
 *
 * Polaris already knows how to reach a NAS, an NFS export or an SFTP host, so
 * this is not a new kind of storage - it is the choice of which one uploads go
 * to. Left alone it picks the obvious answer: the NAS if this instance has one,
 * because that is the disk with the room and the backups, and its own disk if it
 * does not.
 *
 * Changing it moves nothing. Every file remembers the storage it was written to,
 * so what is already attached stays readable exactly where it is.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { setUploadSettingsAction } from "./actions";
import { HardDrive, Loader2, Server } from "lucide-react";
import type { UploadSettings } from "@/lib/tasks/attachment-service";
import { Button, Card, CardBody, Input, Select, cn } from "@polaris/ui";

const AUTOMATIC = "auto";
const LOCAL = "local";

/** Megabytes are what people think in; the setting is stored in bytes. */
function toMegabytes(bytes: number): number {
    return Math.round(bytes / (1024 * 1024));
}

export function UploadsView({ settings }: { settings: UploadSettings }) {
    const [target, setTarget] = useState(settings.choice);
    const [megabytes, setMegabytes] = useState(String(toMegabytes(settings.maxBytes)));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const limit = Number(megabytes);
    const limitValid = Number.isFinite(limit) && limit >= 1 && limit <= 10240;
    const dirty = target !== settings.choice || toMegabytes(settings.maxBytes) !== limit;

    const options = [
        { value: AUTOMATIC, label: `Choose for me (${settings.resolved.name})` },
        { value: LOCAL, label: "This server" },
        ...settings.options.map((connection) => ({
            value: connection.id,
            label: `${connection.name} (${connection.kind})`
        }))
    ];

    const save = async () => {
        if (!limitValid || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setUploadSettingsAction({ target, maxBytes: limit * 1024 * 1024 }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <div className="flex max-w-2xl flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-4 p-4">
                    <div className="flex items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                            {settings.resolved.id === LOCAL ? (
                                <Server className="size-5" />
                            ) : (
                                <HardDrive className="size-5" />
                            )}
                        </span>
                        <div className="min-w-0">
                            <p className="text-sm font-medium">Uploads go to {settings.resolved.name}</p>
                            <p className="text-xs text-muted-foreground">
                                {settings.resolved.automatic
                                    ? "Worked out from what this instance has connected. Connect a NAS and new files follow it."
                                    : "Chosen here."}
                            </p>
                        </div>
                    </div>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">Where to keep them</span>
                        <Select
                            value={target}
                            onValueChange={(value) => {
                                setTarget(value);
                                setSaved(false);
                            }}
                            options={options}
                            aria-label="Upload storage"
                            className="w-full"
                        />
                        <span className="text-xs text-muted-foreground">
                            Files already attached stay where they were written; this decides where the next ones go.
                        </span>
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">Biggest single file</span>
                        <div className="flex items-center gap-2">
                            <Input
                                type="number"
                                min={1}
                                max={10240}
                                value={megabytes}
                                aria-label="Upload limit in megabytes"
                                onChange={(event) => {
                                    setMegabytes(event.target.value);
                                    setSaved(false);
                                }}
                                className={cn("w-28", !limitValid && "border-danger/50")}
                            />
                            <span className="text-sm text-muted-foreground">MB</span>
                        </div>
                        {!limitValid && <span className="text-xs text-danger">Between 1 and 10240 MB.</span>}
                    </label>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex items-center gap-3">
                        <Button onClick={() => void save()} disabled={!dirty || !limitValid || saving}>
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            Save
                        </Button>
                        {saved && !dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
