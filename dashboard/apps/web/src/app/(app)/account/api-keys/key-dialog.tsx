"use client";

/**
 * The form behind both buttons: minting a key and changing one.
 *
 * One dialog rather than two, because everything about a key except the secret
 * can be changed after it exists, and the fields are therefore the same fields.
 * Which is the point: a key whose expiry was set to ninety days when it should
 * have been a year, or whose scopes were guessed at, used to be deleted and
 * re-issued - and re-issuing means finding every place the old value was pasted.
 *
 * The secret is the one thing an edit cannot touch. It exists for a moment at
 * creation and is a hash afterwards, which is why creating hands it back and
 * editing hands back nothing at all.
 */

import { useEffect, useState } from "react";
import { ScopePicker } from "./scope-picker";
import type { AccessGroupView, ApiKeyView } from "@polaris/auth";
import { createApiKeyAction, updateApiKeyAction } from "./actions";
import { ClientRulesEditor, EMPTY_CLIENT_RULES } from "@/components/client-rules-editor";
import {
    AccessRulesEditor,
    EMPTY_ACCESS_RULES,
    type AccessRulesValue
} from "@/components/access-rules-editor";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import {
    API_KEY_ENVIRONMENTS,
    API_KEY_ENVIRONMENT_LABELS,
    API_KEY_EXPIRY_CHOICES,
    expandPermissions,
    type ApiKeyEnvironment,
    type Permission,
    type UserAgentRules
} from "@polaris/core";

/** The Select value that swaps the fixed spans for a date of the user's choosing. */
const CUSTOM_EXPIRY = "custom";

/** And the one that leaves an existing key ending exactly when it already did.
 *  Only offered while editing, and the default there: renaming a key must not
 *  quietly move its expiry to whatever the form happened to show. */
const KEEP_EXPIRY = "keep";

function expiryLabel(days: number): string {
    return days === 0 ? "Never expires" : `${days} days`;
}

/** A picked day expires at the end of it, local time - the day itself still works. */
function endOfDay(date: string): Date | null {
    const [year, month, day] = date.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/** Today, local time, as the earliest day a key may be set to expire on. */
function earliestExpiryDate(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
}

export function KeyDialog({
    open,
    onOpenChange,
    groups,
    availableScopes,
    /** The key being changed, or null to mint a new one. */
    editing,
    onCreated,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groups: AccessGroupView[];
    availableScopes: Permission[];
    editing: ApiKeyView | null;
    onCreated: (secret: string) => void;
    onSaved: () => void;
}) {
    const [name, setName] = useState("");
    const [environment, setEnvironment] = useState<ApiKeyEnvironment>("production");
    const [scopes, setScopes] = useState<Permission[]>([]);
    const [expiry, setExpiry] = useState<string>("90");
    const [expiryDate, setExpiryDate] = useState("");
    const [rules, setRules] = useState<AccessRulesValue>(EMPTY_ACCESS_RULES);
    const [clients, setClients] = useState<UserAgentRules>(EMPTY_CLIENT_RULES);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * Fill the form from the key being edited, every time one is opened.
     *
     * Keyed by the key's id rather than by the dialog opening, so pressing edit
     * on a second row while the first is still mounted shows the second row's
     * values - which is what a list of fourteen keys will do to this within a
     * minute of it existing.
     */
    useEffect(() => {
        if (!open) return;
        setError(null);
        if (!editing) {
            setName("");
            setEnvironment("production");
            setScopes([]);
            setExpiry("90");
            setExpiryDate("");
            setRules(EMPTY_ACCESS_RULES);
            setClients(EMPTY_CLIENT_RULES);
            return;
        }
        setName(editing.name);
        setEnvironment(editing.environment);
        setScopes(editing.scopes as Permission[]);
        setExpiry(KEEP_EXPIRY);
        setExpiryDate("");
        setRules({
            groupIds: editing.groupIds,
            allowedCidrs: editing.allowedCidrs,
            allowedCountries: editing.allowedCountries,
            allowedContinents: editing.allowedContinents
        });
        setClients({
            allowedUserAgents: editing.allowedUserAgents,
            deniedUserAgents: editing.deniedUserAgents
        });
    }, [editing, open]);

    const custom = expiry === CUSTOM_EXPIRY;
    const keeping = expiry === KEEP_EXPIRY;
    const chosenDate = custom ? endOfDay(expiryDate) : null;
    const dateReady = !custom || (chosenDate !== null && chosenDate.getTime() > Date.now());

    async function submit() {
        setBusy(true);
        setError(null);
        const shared = {
            name,
            environment,
            scopes: expandPermissions(scopes),
            ...rules,
            ...clients
        };

        if (editing) {
            const result = await updateApiKeyAction({
                ...shared,
                id: editing.id,
                // One of the three and never two. Left out entirely under
                // "keep", which is what tells the server the expiry is not part
                // of this edit - and a span sent beside a null date would read
                // as "never expires" and quietly undo the span that was chosen.
                ...(keeping
                    ? {}
                    : custom
                      ? { expiresAt: chosenDate?.toISOString() }
                      : { expiresInDays: Number(expiry) })
            });
            setBusy(false);
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
            return;
        }

        const result = await createApiKeyAction({
            ...shared,
            expiresInDays: custom ? 0 : Number(expiry),
            expiresAt: chosenDate?.toISOString()
        });
        setBusy(false);
        if (result.error || !result.secret) {
            setError(result.error ?? "Could not create the key.");
            return;
        }
        onCreated(result.secret);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{editing ? "Edit API key" : "New API key"}</DialogTitle>
                    <DialogDescription>
                        {editing
                            ? "Everything except the secret itself. Whatever is using this key keeps working."
                            : "The key is shown once, right after it is created. Store it somewhere safe."}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-4 sm:flex-row">
                        <label className="flex flex-1 flex-col gap-1 text-sm">
                            Name
                            <Input
                                value={name}
                                placeholder="Backup script"
                                autoComplete="off"
                                onChange={(event) => setName(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm sm:w-44">
                            Environment
                            <Select
                                value={environment}
                                onValueChange={(value) => setEnvironment(value as ApiKeyEnvironment)}
                                options={API_KEY_ENVIRONMENTS.map((value) => ({
                                    value,
                                    label: API_KEY_ENVIRONMENT_LABELS[value]
                                }))}
                            />
                        </label>
                    </div>
                    <p className="-mt-2 text-xs text-muted-foreground">
                        The environment is a label for sorting your own keys. Both reach the same
                        Polaris.
                    </p>

                    <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Scopes</span>
                        <ScopePicker
                            available={availableScopes}
                            selected={scopes}
                            onChange={setScopes}
                        />
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="flex flex-col gap-1 text-sm">
                            Expiry
                            <Select
                                value={expiry}
                                onValueChange={setExpiry}
                                options={[
                                    ...(editing
                                        ? [{ value: KEEP_EXPIRY, label: "Leave as it is" }]
                                        : []),
                                    ...API_KEY_EXPIRY_CHOICES.map((days) => ({
                                        value: String(days),
                                        label: expiryLabel(days)
                                    })),
                                    { value: CUSTOM_EXPIRY, label: "Custom date" }
                                ]}
                            />
                        </label>
                        {custom ? (
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="text-xs text-muted-foreground">
                                    Works through the end of the chosen day.
                                </span>
                                <Input
                                    type="date"
                                    value={expiryDate}
                                    min={earliestExpiryDate()}
                                    onChange={(event) => setExpiryDate(event.target.value)}
                                />
                            </label>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium">Where the key may be used</span>
                        <AccessRulesEditor value={rules} groups={groups} onChange={setRules} />
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium">What may use it</span>
                        <ClientRulesEditor value={clients} onChange={setClients} />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => void submit()}
                            disabled={
                                busy || name.trim() === "" || scopes.length === 0 || !dateReady
                            }
                        >
                            {busy
                                ? editing
                                    ? "Saving..."
                                    : "Creating..."
                                : editing
                                  ? "Save changes"
                                  : "Create key"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
