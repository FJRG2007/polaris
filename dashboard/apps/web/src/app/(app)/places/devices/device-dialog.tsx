"use client";

/**
 * What Polaris is allowed to say about a door, as opposed to what the account
 * says.
 *
 * Four fields, and three of them exist because the account is not organised the
 * way a building is: one login can hold every lock a company owns, so the place
 * and the area are decided here, and the name typed here is kept rather than
 * overwritten on the next sync - "Warehouse side door" is worth more than "Smart
 * Lock 4" and would be lost every minute otherwise.
 *
 * The fourth is the one that matters. A door can be set to be watched rather than
 * operated, which is refused in the service and not merely hidden here: a lock on
 * a door that is not this team's to open should still show its state and its
 * history, and should have no button that opens it.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { deviceEditSchema } from "@/lib/home/schemas";
import type { PlaceView } from "@/lib/home/place-kinds";
import type { DeviceView } from "@/lib/home/device-kinds";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";

export function DeviceDialog({
    device,
    places,
    onClose,
    onSaved
}: {
    device: DeviceView | null;
    places: readonly PlaceView[];
    onClose: () => void;
    onSaved: (device: DeviceView) => void;
}) {
    const [name, setName] = useState("");
    const [zone, setZone] = useState("");
    const [placeId, setPlaceId] = useState("");
    const [controllable, setControllable] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!device) return;
        setName(device.name);
        setZone(device.zone);
        setPlaceId(device.placeId ?? "");
        setControllable(device.controllable);
        setError("");
    }, [device]);

    const nameIssue = name.trim()
        ? (deviceEditSchema.shape.name.safeParse(name).error?.issues[0]?.message ?? null)
        : null;
    const canSubmit = name.trim().length > 0 && !nameIssue && !saving;

    const submit = async () => {
        if (!device || !canSubmit) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.saveDeviceAction(device.id, {
                    name,
                    zone,
                    placeId: placeId || null,
                    controllable
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.device) onSaved(result.device);
    };

    return (
        <Dialog open={device !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{device?.name ?? "Door"}</DialogTitle>
                    <DialogDescription>
                        {device?.model || "Connected through the account it is on."} Everything else
                        about it is read back from that account.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            Name <span className="text-danger">*</span>
                        </span>
                        <Input
                            autoFocus
                            value={name}
                            maxLength={80}
                            aria-label="Name"
                            onChange={(event) => setName(event.target.value)}
                        />
                        {nameIssue && <span className="text-xs text-danger">{nameIssue}</span>}
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            Area <span className="text-foreground-subtle">optional</span>
                        </span>
                        <Input
                            value={zone}
                            maxLength={60}
                            aria-label="Area"
                            placeholder="Reception"
                            onChange={(event) => setZone(event.target.value)}
                        />
                        <span className="text-xs text-foreground-subtle">
                            Doors and cameras in the same area are shown together.
                        </span>
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">Place</span>
                        <Select
                            value={placeId}
                            onValueChange={setPlaceId}
                            aria-label="Place"
                            options={[
                                { value: "", label: "Not decided yet" },
                                ...places.map((place) => ({ value: place.id, label: place.name }))
                            ]}
                        />
                    </label>

                    <label className="flex items-center justify-between gap-3">
                        <span className="flex flex-col gap-0.5">
                            <span className="text-sm">Operate from Polaris</span>
                            <span className="text-xs text-foreground-subtle">
                                Off leaves the state and the history and takes away the buttons.
                            </span>
                        </span>
                        <Switch
                            checked={controllable}
                            onChange={setControllable}
                            aria-label="Operate from Polaris"
                        />
                    </label>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={() => void submit()} disabled={!canSubmit}>
                        {saving ? "Saving" : "Save"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
