"use client";

/**
 * Writing an alert.
 *
 * Four questions in the order somebody asks them: what should reach me, from
 * where, when, and who else needs to know. Everything except the first has a
 * sensible "anything" answer, so an alert can be one tick and two names.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { saveAlertAction } from "../actions";
import { runAction } from "@/lib/run-action";
import type { CameraView } from "@/lib/home/cameras";
import type { AlertRuleView } from "@/lib/home/alerts";
import {
    Button,
    Checkbox,
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

/** What an alert can fire on. The camera's own vocabulary, in words. */
const KINDS = [
    { value: "person", label: "Somebody is seen" },
    { value: "face", label: "A known face is seen" },
    { value: "vehicle", label: "A vehicle" },
    { value: "animal", label: "An animal" },
    { value: "motion", label: "Anything moves" },
    { value: "tamper", label: "A camera is tampered with" }
];

export function AlertDialog({
    rule,
    cameras,
    people,
    known,
    onClose,
    onSaved
}: {
    rule: AlertRuleView | null;
    cameras: readonly CameraView[];
    /** Everybody who could be told. */
    people: readonly { id: string; name: string }[];
    /** The faces the recognizer knows, for narrowing to one person. */
    known: readonly { id: string; name: string }[];
    onClose: () => void;
    onSaved: (rule: AlertRuleView) => void;
}) {
    const [name, setName] = useState(rule?.name ?? "");
    const [kinds, setKinds] = useState<string[]>([...(rule?.kinds ?? ["person"])]);
    const [cameraId, setCameraId] = useState(rule?.cameraId ?? "");
    const [label, setLabel] = useState(rule?.label ?? "");
    const [hoursOn, setHoursOn] = useState(rule?.hours != null);
    const [from, setFrom] = useState(String(rule?.hours?.from ?? 22));
    const [to, setTo] = useState(String(rule?.hours?.to ?? 7));
    const [recipients, setRecipients] = useState<string[]>([...(rule?.recipients ?? [])]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(
            () =>
                saveAlertAction(rule?.id ?? null, {
                    name,
                    // Null means "wherever the switcher is"; the action fills it
                    // in, so an alert always belongs to a place.
                    placeId: rule?.placeId ?? null,
                    cameraId: cameraId || null,
                    kinds,
                    label: label || null,
                    hours: hoursOn ? { from: Number(from) || 0, to: Number(to) || 0 } : null,
                    recipients,
                    enabled: rule?.enabled ?? true
                }),
            setError
        );
        setBusy(false);
        if (!result || result.error || !result.rule) {
            if (result?.error) setError(result.error);
            return;
        }
        onSaved(result.rule);
    };

    const toggle = (list: string[], value: string, on: boolean): string[] =>
        on ? [...list, value] : list.filter((item) => item !== value);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{rule ? rule.name : "Add an alert"}</DialogTitle>
                    <DialogDescription>
                        It arrives as a message in a conversation with the people you pick, so it turns up wherever
                        they are rather than waiting on a badge.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[12px] font-medium text-muted-foreground">
                            Name<span className="text-danger"> *</span>
                        </span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Somebody at the door overnight"
                            autoFocus
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-[12px] font-medium text-muted-foreground">Tell me when</span>
                        <div className="flex flex-wrap gap-3">
                            {KINDS.map((item) => (
                                <label key={item.value} className="flex items-center gap-2 text-[13px]">
                                    <Checkbox
                                        checked={kinds.includes(item.value)}
                                        onChange={(event) => setKinds(toggle(kinds, item.value, event.target.checked))}
                                    />
                                    {item.label}
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1.5">
                            <span className="text-[12px] font-medium text-muted-foreground">On</span>
                            <Select
                                value={cameraId}
                                onValueChange={setCameraId}
                                options={[
                                    { value: "", label: "Any camera here" },
                                    ...cameras.map((camera) => ({ value: camera.id, label: camera.name }))
                                ]}
                            />
                        </label>
                        {known.length > 0 ? (
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[12px] font-medium text-muted-foreground">Only about</span>
                                <Select
                                    value={label}
                                    onValueChange={setLabel}
                                    options={[
                                        { value: "", label: "Anybody, strangers included" },
                                        ...known.map((person) => ({ value: person.name, label: person.name }))
                                    ]}
                                />
                            </label>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="flex items-center justify-between gap-3">
                            <span className="text-[13px] text-foreground">Only at certain hours</span>
                            <Switch checked={hoursOn} onChange={setHoursOn} />
                        </label>
                        {hoursOn ? (
                            <div className="flex items-center gap-2">
                                <Input
                                    value={from}
                                    onChange={(event) => setFrom(event.target.value)}
                                    className="w-20"
                                    inputMode="numeric"
                                    aria-label="From hour"
                                />
                                <span className="text-[12px] text-muted-foreground">to</span>
                                <Input
                                    value={to}
                                    onChange={(event) => setTo(event.target.value)}
                                    className="w-20"
                                    inputMode="numeric"
                                    aria-label="To hour"
                                />
                                <span className="text-[12px] text-foreground-subtle">
                                    24-hour clock. 22 to 7 is overnight.
                                </span>
                            </div>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-[12px] font-medium text-muted-foreground">
                            Tell<span className="text-danger"> *</span>
                        </span>
                        <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-md border border-border p-2">
                            {people.map((person) => (
                                <label key={person.id} className="flex items-center gap-2 text-[13px]">
                                    <Checkbox
                                        checked={recipients.includes(person.id)}
                                        onChange={(event) =>
                                            setRecipients(toggle(recipients, person.id, event.target.checked))
                                        }
                                    />
                                    {person.name}
                                </label>
                            ))}
                        </div>
                    </div>
                </div>

                {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        onClick={save}
                        disabled={busy || !name.trim() || kinds.length === 0 || recipients.length === 0}
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {rule ? "Save" : "Add alert"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
