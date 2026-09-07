"use client";

/**
 * Connecting something the devices at a place are reached through.
 *
 * The make and the way in are two questions, not one, and both are the reader's
 * to answer. A lock maker is a web account reachable from anywhere and a box on
 * the same network answering in milliseconds; a switch maker is a cloud project
 * and a key on the device itself. Which of those somebody has - and which they
 * are willing to depend on - is not something a form can work out for them, so it
 * is asked, with what each one costs written next to it.
 *
 * Everything below those two questions is drawn from the registry: the fields, the
 * hints, what is a secret and what is an address, and the steps for the part that
 * genuinely is not Polaris' to do. Adding a make adds no markup here.
 *
 * A credential is written once and never shown again. There is no reveal and no
 * masked copy of it in a field on the next visit: it is a key to somebody's front
 * door, and a screen that can print it back is a screen somebody can be walked
 * into opening.
 */

import Link from "next/link";
import * as actions from "../actions";
import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { ExternalLink, Loader2 } from "lucide-react";
import type { DeviceView } from "@/lib/home/device-kinds";
import * as registry from "@/lib/home/device-connections";
import type { DeviceAccountView } from "@/lib/home/device-accounts";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** What comes back once something is connected: everything the screen behind this
 *  has to redraw, so it never has to go and ask again. */
export interface Connected {
    readonly devices: DeviceView[];
    readonly accounts: DeviceAccountView[];
}

function Field({
    field,
    value,
    onChange
}: {
    field: registry.ConnectionField;
    value: string;
    onChange: (value: string) => void;
}) {
    const issue = registry.fieldIssue(field, value);
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
                {field.label}
                {field.optional === true ? (
                    <span className="text-foreground-subtle"> optional</span>
                ) : (
                    <span className="text-danger"> *</span>
                )}
            </span>
            {field.choices ? (
                <Select
                    value={value || field.defaultValue || ""}
                    onValueChange={onChange}
                    options={field.choices.map((choice) => ({ value: choice.value, label: choice.label }))}
                    aria-label={field.label}
                />
            ) : (
                <Input
                    type={field.secret === true ? "password" : "text"}
                    value={value}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={field.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                    aria-label={field.label}
                />
            )}
            {field.hint && <span className="text-xs text-foreground-subtle">{field.hint}</span>}
            {issue && <span className="text-xs text-danger">{issue}</span>}
        </label>
    );
}

export function ConnectDialog({
    open,
    reconnect,
    onClose,
    onConnected
}: {
    open: boolean;
    /** The account being given a new credential, where that is what this is. Its
     *  connection cannot change: a token is replaced, a way in is not. */
    reconnect: DeviceAccountView | null;
    onClose: () => void;
    onConnected: (result: Connected) => void;
}) {
    const brands = useMemo(() => registry.deviceBrands(), []);
    const [brand, setBrand] = useState(brands[0]?.brand ?? "");
    const [chosen, setChosen] = useState(registry.connectionsOfBrand(brands[0]?.brand ?? "")[0]?.id ?? "");
    const [label, setLabel] = useState("");
    const [fields, setFields] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const connectionId = reconnect ? reconnect.connection : chosen;
    const connection = registry.deviceConnection(connectionId);
    const ofBrand = useMemo(() => registry.connectionsOfBrand(brand), [brand]);
    const complete = connection ? registry.fieldsComplete(connection, fields) : false;

    /** A make with one way in is not a question. The picker stays visible so it is
     *  obvious there was a choice made, and there is nothing to weigh up. */
    const pickBrand = (next: string) => {
        setBrand(next);
        setChosen(registry.connectionsOfBrand(next)[0]?.id ?? "");
        setFields({});
        setError("");
    };

    const submit = async () => {
        if (!connection || !complete || saving) return;
        setSaving(true);
        setError("");
        const payload = { connection: connection.id, label, fields };
        const result = await runAction(
            () =>
                reconnect
                    ? actions.reconnectDeviceAccountAction(reconnect.id, payload)
                    : actions.connectDeviceAccountAction(payload),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setFields({});
        setLabel("");
        onConnected({ devices: result.devices ?? [], accounts: result.accounts ?? [] });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        {reconnect ? `Reconnect ${reconnect.label}` : "Connect devices"}
                    </DialogTitle>
                    <DialogDescription>
                        {reconnect
                            ? "The devices keep their names, their places and everything they have done. Only what Polaris opens them with changes."
                            : "Pick what you have and how Polaris should reach it. What it finds arrives as devices you can name and place."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {!reconnect && (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-xs text-muted-foreground">Make</span>
                                <Select
                                    value={brand}
                                    onValueChange={pickBrand}
                                    options={brands.map((entry) => ({
                                        value: entry.brand,
                                        label: entry.brand
                                    }))}
                                    aria-label="Make"
                                />
                            </label>
                            <label className="flex flex-col gap-1.5">
                                <span className="text-xs text-muted-foreground">How to reach it</span>
                                <Select
                                    value={chosen}
                                    onValueChange={(next) => {
                                        setChosen(next);
                                        setFields({});
                                        setError("");
                                    }}
                                    options={ofBrand.map((entry, index) => ({
                                        value: entry.id,
                                        label: index === 0 ? `${entry.label} - recommended` : entry.label
                                    }))}
                                    aria-label="How to reach it"
                                />
                            </label>
                        </div>
                    )}

                    {connection && (
                        <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
                            <span className="text-xs font-medium">
                                {registry.REACH_LABELS[connection.reach]}
                            </span>
                            <span className="text-xs text-muted-foreground">{connection.summary}</span>
                            {connection.note && (
                                <span className="text-xs text-foreground-subtle">{connection.note}</span>
                            )}
                        </div>
                    )}

                    {connection?.steps && (
                        <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs text-muted-foreground">
                            {connection.steps.map((step, index) => (
                                <li key={step}>
                                    {index === 0 && connection.link ? (
                                        <>
                                            {step.split(connection.link.label)[0]}
                                            <Link
                                                href={connection.link.href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="inline-flex items-center gap-1 text-foreground underline"
                                            >
                                                {connection.link.label}
                                                <ExternalLink className="size-3" />
                                            </Link>
                                            {step.split(connection.link.label)[1]}
                                        </>
                                    ) : (
                                        step
                                    )}
                                </li>
                            ))}
                        </ol>
                    )}

                    {connection?.fields.map((field) => (
                        <Field
                            key={field.key}
                            field={field}
                            value={fields[field.key] ?? ""}
                            onChange={(value) =>
                                setFields((current) => ({ ...current, [field.key]: value }))
                            }
                        />
                    ))}

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            Name for this connection{" "}
                            <span className="text-foreground-subtle">optional</span>
                        </span>
                        <Input
                            value={label}
                            maxLength={60}
                            placeholder={reconnect?.label ?? connection?.brand ?? ""}
                            onChange={(event) => setLabel(event.target.value)}
                            aria-label="Name for this connection"
                        />
                    </label>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={!complete || saving}
                        aria-disabled={!complete || saving}
                    >
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        {saving ? "Checking" : "Connect"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
