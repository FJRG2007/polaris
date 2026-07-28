"use client";

/**
 * The key list and the two dialogs it needs: one to mint a key, one to show the
 * secret. The secret dialog is separate on purpose - it is the only moment the
 * value exists, so it gets the user's full attention and an explicit copy step
 * rather than being tucked into the bottom of a form.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Plus } from "lucide-react";
import type { AccessGroupView, ApiKeyView } from "@polaris/auth";
import { API_KEY_EXPIRY_CHOICES, expandPermissions, type Permission } from "@polaris/core";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import {
    AccessRulesEditor,
    EMPTY_ACCESS_RULES,
    type AccessRulesValue
} from "@/components/access-rules-editor";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { createApiKeyAction, deleteApiKeyAction, revokeApiKeyAction } from "./actions";
import { ScopePicker } from "./scope-picker";

/** The Select value that swaps the fixed spans for a date of the user's choosing. */
const CUSTOM_EXPIRY = "custom";

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

/** What a key's state should read as in the list. */
function keyStatus(key: ApiKeyView): { label: string; tone: "success" | "neutral" | "danger" } {
    if (key.revokedAt) return { label: "Revoked", tone: "danger" };
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", tone: "neutral" };
    }
    return { label: "Active", tone: "success" };
}

export function ApiKeysView({
    keys,
    groups,
    availableScopes
}: {
    keys: ApiKeyView[];
    groups: AccessGroupView[];
    availableScopes: Permission[];
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [createOpen, setCreateOpen] = useState(false);
    const [issued, setIssued] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function revoke(key: ApiKeyView) {
        const ok = await confirm({
            title: `Revoke "${key.name}"?`,
            description: "Anything using this key stops working immediately.",
            confirmLabel: "Revoke",
            danger: true
        });
        if (!ok) return;
        const result = await revokeApiKeyAction(key.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    async function remove(key: ApiKeyView) {
        const ok = await confirm({
            title: `Delete "${key.name}"?`,
            description: "The key disappears from this list. It cannot be undone.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!ok) return;
        const result = await deleteApiKeyAction(key.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <h2 className="text-sm font-medium">Your keys</h2>
                            <p className="text-xs text-muted-foreground">
                                Each key carries a subset of your own permissions, and can be limited to an address
                                or a location.
                            </p>
                        </div>
                        <Button size="sm" onClick={() => setCreateOpen(true)}>
                            <Plus className="size-4" />
                            New key
                        </Button>
                    </div>

                    {keys.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No keys yet.</p>
                    ) : (
                        keys.map((key) => {
                            const status = keyStatus(key);
                            return (
                                <div
                                    key={key.id}
                                    className="flex items-start justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                                >
                                    <div className="flex min-w-0 items-start gap-3">
                                        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="flex items-center gap-2 text-sm">
                                                <span className="truncate">{key.name}</span>
                                                <Badge variant={status.tone}>{status.label}</Badge>
                                            </p>
                                            <p className="font-mono text-xs text-muted-foreground">{key.prefix}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {key.scopes.length} scope{key.scopes.length === 1 ? "" : "s"}
                                                {key.expiresAt ? (
                                                    <>
                                                        {" - expires "}
                                                        <RelativeTime iso={key.expiresAt} />
                                                    </>
                                                ) : null}
                                                {key.lastUsedAt ? (
                                                    <>
                                                        {" - last used "}
                                                        <RelativeTime iso={key.lastUsedAt} />
                                                    </>
                                                ) : " - never used"}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 gap-1">
                                        {key.revokedAt ? null : (
                                            <Button variant="ghost" size="sm" onClick={() => void revoke(key)}>
                                                Revoke
                                            </Button>
                                        )}
                                        <Button variant="ghost" size="sm" onClick={() => void remove(key)}>
                                            Delete
                                        </Button>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </CardBody>
            </Card>

            <CreateKeyDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                groups={groups}
                availableScopes={availableScopes}
                onCreated={(secret) => {
                    setCreateOpen(false);
                    setIssued(secret);
                    router.refresh();
                }}
            />
            <IssuedKeyDialog secret={issued} onClose={() => setIssued(null)} />
            {confirmElement}
        </div>
    );
}

function CreateKeyDialog({
    open,
    onOpenChange,
    groups,
    availableScopes,
    onCreated
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groups: AccessGroupView[];
    availableScopes: Permission[];
    onCreated: (secret: string) => void;
}) {
    const [name, setName] = useState("");
    const [scopes, setScopes] = useState<Permission[]>([]);
    const [expiry, setExpiry] = useState<string>("90");
    const [expiryDate, setExpiryDate] = useState("");
    const [rules, setRules] = useState<AccessRulesValue>(EMPTY_ACCESS_RULES);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const custom = expiry === CUSTOM_EXPIRY;
    const chosenDate = custom ? endOfDay(expiryDate) : null;
    const dateReady = !custom || (chosenDate !== null && chosenDate.getTime() > Date.now());

    function reset() {
        setName("");
        setScopes([]);
        setExpiry("90");
        setExpiryDate("");
        setRules(EMPTY_ACCESS_RULES);
        setError(null);
    }

    async function submit() {
        setBusy(true);
        setError(null);
        const result = await createApiKeyAction({
            name,
            scopes: expandPermissions(scopes),
            expiresInDays: custom ? 0 : Number(expiry),
            expiresAt: chosenDate?.toISOString(),
            ...rules
        });
        setBusy(false);
        if (result.error || !result.secret) {
            setError(result.error ?? "Could not create the key.");
            return;
        }
        const secret = result.secret;
        reset();
        onCreated(secret);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) reset();
            }}
        >
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>New API key</DialogTitle>
                    <DialogDescription>
                        The key is shown once, right after it is created. Store it somewhere safe.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input
                            value={name}
                            placeholder="Backup script"
                            autoComplete="off"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>

                    <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Scopes</span>
                        <ScopePicker available={availableScopes} selected={scopes} onChange={setScopes} />
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="flex flex-col gap-1 text-sm">
                            Expiry
                            <Select
                                value={expiry}
                                onValueChange={setExpiry}
                                options={[
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

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => void submit()}
                            disabled={busy || name.trim() === "" || scopes.length === 0 || !dateReady}
                        >
                            {busy ? "Creating..." : "Create key"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function IssuedKeyDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
    return (
        <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Your new API key</DialogTitle>
                    <DialogDescription>
                        Copy it now - Polaris stores only a hash and cannot show it again.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <code className="break-all rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                        {secret}
                    </code>
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            onClick={() => secret && void navigator.clipboard.writeText(secret)}
                        >
                            <Copy className="size-4" />
                            Copy
                        </Button>
                        <Button onClick={onClose}>Done</Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
