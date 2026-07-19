"use client";

/**
 * Per-item access editor. Opened from the Drive context menu on an item you own
 * (or as an admin), it manages two things for that path: the ACL grants that let
 * other users and groups reach it, and the optional password lock that gates it.
 * Data is loaded on open through a server action and re-loaded after each change,
 * so the dialog always reflects the authoritative state.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Lock, ShieldCheck, Trash2, Unlock, User, Users } from "lucide-react";
import { DRIVE_ACTIONS, type DriveAction } from "@polaris/core";
import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import {
    getAccessSettingsAction,
    lockPathAction,
    removeDriveAclAction,
    removeLockAction,
    setDriveAclAction,
    unlockPathAction
} from "./access-actions";
import type { AccessPrincipal, AccessSettings } from "./access-types";

export interface AccessTarget {
    connectionId: string;
    path: string;
    name: string;
}

/** Human labels for the raw Drive verbs, so a grant reads plainly. */
const ACTION_LABELS: Record<DriveAction, string> = {
    read: "View",
    download: "Download",
    write: "Edit",
    rename: "Rename",
    copy: "Copy",
    delete: "Delete"
};

/** One-click access levels; "Custom" just leaves the checkboxes as-is. */
const PRESETS: { id: string; label: string; actions: DriveAction[] }[] = [
    { id: "viewer", label: "Viewer", actions: ["read", "download"] },
    { id: "editor", label: "Editor", actions: ["read", "download", "write", "rename", "copy", "delete"] }
];

/** Whether a chosen action set exactly matches a preset. */
function presetMatch(actions: Set<DriveAction>): string {
    for (const preset of PRESETS) {
        if (preset.actions.length === actions.size && preset.actions.every((action) => actions.has(action))) {
            return preset.id;
        }
    }
    return "custom";
}

export function AccessDialog({
    target,
    onOpenChange,
    onChanged
}: {
    target: AccessTarget | null;
    onOpenChange: (open: boolean) => void;
    onChanged?: () => void;
}) {
    const [settings, setSettings] = useState<AccessSettings | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // ACL form state.
    const [principal, setPrincipal] = useState("");
    const [actions, setActions] = useState<Set<DriveAction>>(new Set(["read", "download"]));
    const [effect, setEffect] = useState<"allow" | "deny">("allow");
    // Lock form state.
    const [password, setPassword] = useState("");

    const path = target?.path ?? "";

    async function reload(connectionId: string) {
        setLoading(true);
        setError(null);
        try {
            setSettings(await getAccessSettingsAction(connectionId));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not load access settings");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!target) {
            setSettings(null);
            return;
        }
        void reload(target.connectionId);
        setPrincipal("");
        setActions(new Set(["read", "download"]));
        setEffect("allow");
        setPassword("");
    }, [target]);

    if (!target) return null;

    const grants = (settings?.acls ?? []).filter((acl) => acl.path === path);
    const lock = (settings?.locks ?? []).find((entry) => entry.path === path) ?? null;
    const principalLabel = (type: string, id: string): string => {
        const match = settings?.principals.find((option) => option.type === type && option.id === id);
        return match ? match.label : `${type}:${id}`;
    };

    function toggleAction(action: DriveAction) {
        setActions((prev) => {
            const next = new Set(prev);
            if (next.has(action)) next.delete(action);
            else next.add(action);
            return next;
        });
    }

    function run(work: () => Promise<{ error?: string } | void>) {
        setBusy(true);
        setError(null);
        void (async () => {
            const result = await work();
            if (result && "error" in result && result.error) setError(result.error);
            await reload(target!.connectionId);
            onChanged?.();
            setBusy(false);
        })();
    }

    function addGrant() {
        if (!principal) {
            setError("Choose who to grant access to");
            return;
        }
        const [type, id] = principal.split(":");
        run(() =>
            setDriveAclAction({
                connectionId: target!.connectionId,
                path,
                principalType: type as AccessPrincipal["type"],
                principalId: id as string,
                actions: [...actions],
                effect
            })
        );
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Permissions &amp; lock</DialogTitle>
                    <DialogDescription className="truncate">
                        {target.name} - /{path}
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading...
                    </div>
                ) : (
                    <div className="flex flex-col gap-5">
                        <section className="flex flex-col gap-2">
                            <div>
                                <h3 className="text-sm font-medium">Who can access this</h3>
                                <p className="text-xs text-muted-foreground">
                                    The owner and admins always have full access. Add people or groups below to give
                                    them specific actions; a <span className="text-danger">Deny</span> always wins over
                                    an allow.
                                </p>
                            </div>
                            {grants.length === 0 ? (
                                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                                    No one else has been granted access yet.
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-1.5">
                                    {grants.map((grant) => (
                                        <li
                                            key={grant.id}
                                            className="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                                        >
                                            <div className="flex min-w-0 items-start gap-2">
                                                {grant.principalType === "group" ? (
                                                    <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                                ) : (
                                                    <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                                )}
                                                <div className="min-w-0">
                                                    <span className="flex items-center gap-1.5">
                                                        <span className="truncate font-medium">
                                                            {principalLabel(grant.principalType, grant.principalId)}
                                                        </span>
                                                        <Badge
                                                            variant={grant.effect === "deny" ? "danger" : "success"}
                                                        >
                                                            {grant.effect === "deny" ? "Denied" : "Allowed"}
                                                        </Badge>
                                                    </span>
                                                    <span className="mt-1 flex flex-wrap gap-1">
                                                        {grant.actions.map((action) => (
                                                            <span
                                                                key={action}
                                                                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                                            >
                                                                {ACTION_LABELS[action] ?? action}
                                                            </span>
                                                        ))}
                                                    </span>
                                                </div>
                                            </div>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label="Remove grant"
                                                disabled={busy}
                                                onClick={() =>
                                                    run(() => removeDriveAclAction(target!.connectionId, grant.id))
                                                }
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="flex flex-col gap-2 rounded-md border border-border bg-surface/40 p-3">
                                <select
                                    className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                                    value={principal}
                                    onChange={(event) => setPrincipal(event.target.value)}
                                >
                                    <option value="">Add a user or group...</option>
                                    {(settings?.principals ?? []).map((option) => (
                                        <option key={`${option.type}:${option.id}`} value={`${option.type}:${option.id}`}>
                                            {option.type === "group" ? "Group: " : ""}
                                            {option.label}
                                            {option.sublabel ? ` (${option.sublabel})` : ""}
                                        </option>
                                    ))}
                                </select>
                                <div className="flex items-center gap-1.5">
                                    <span className="text-xs text-muted-foreground">Level</span>
                                    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                                        {PRESETS.map((preset) => (
                                            <button
                                                key={preset.id}
                                                type="button"
                                                onClick={() => setActions(new Set(preset.actions))}
                                                className={
                                                    "rounded px-2 py-1 text-xs transition-colors hover:bg-muted " +
                                                    (presetMatch(actions) === preset.id
                                                        ? "bg-muted font-medium"
                                                        : "text-muted-foreground")
                                                }
                                            >
                                                {preset.label}
                                            </button>
                                        ))}
                                        <span
                                            className={
                                                "rounded px-2 py-1 text-xs " +
                                                (presetMatch(actions) === "custom"
                                                    ? "bg-muted font-medium"
                                                    : "text-muted-foreground")
                                            }
                                        >
                                            Custom
                                        </span>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {DRIVE_ACTIONS.map((action) => (
                                        <label key={action} className="flex items-center gap-1.5 text-xs">
                                            <Checkbox
                                                checked={actions.has(action)}
                                                onChange={() => toggleAction(action)}
                                                aria-label={ACTION_LABELS[action] ?? action}
                                            />
                                            {ACTION_LABELS[action] ?? action}
                                        </label>
                                    ))}
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                    <select
                                        className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                                        value={effect}
                                        onChange={(event) => setEffect(event.target.value as "allow" | "deny")}
                                    >
                                        <option value="allow">Allow</option>
                                        <option value="deny">Deny</option>
                                    </select>
                                    <Button size="sm" disabled={busy} onClick={addGrant}>
                                        Add grant
                                    </Button>
                                </div>
                            </div>

                            <Link
                                href="/admin/policies"
                                className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                            >
                                <ShieldCheck className="size-3.5" />
                                Manage roles, groups and org-wide policies in the IAM dashboard
                                <ArrowUpRight className="size-3.5" />
                            </Link>
                        </section>

                        <section className="flex flex-col gap-2 border-t border-border pt-4">
                            <h3 className="flex items-center gap-1.5 text-sm font-medium">
                                <Lock className="size-4" /> Access lock
                            </h3>
                            {lock ? (
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span className="text-muted-foreground">
                                        This item is password-gated. Anyone opening it must unlock it first.
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() => run(() => removeLockAction(target!.connectionId, lock.id))}
                                    >
                                        <Unlock className="size-4" />
                                        Remove
                                    </Button>
                                </div>
                            ) : (
                                <div className="flex items-end gap-2">
                                    <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                        Set a password to gate this item
                                        <Input
                                            type="password"
                                            value={password}
                                            onChange={(event) => setPassword(event.target.value)}
                                            placeholder="At least 4 characters"
                                        />
                                    </label>
                                    <Button
                                        size="sm"
                                        disabled={busy || password.length < 4}
                                        onClick={() =>
                                            run(async () => {
                                                const result = await lockPathAction(target!.connectionId, path, password);
                                                setPassword("");
                                                return result;
                                            })
                                        }
                                    >
                                        <Lock className="size-4" />
                                        Lock
                                    </Button>
                                </div>
                            )}
                        </section>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The unlock prompt shown in place of a listing when the browsed folder is gated.
 * A correct password sets the session unlock cookie and reloads the listing.
 */
export function UnlockPanel({
    connectionId,
    lockId,
    lockPath,
    onUnlocked
}: {
    connectionId: string;
    lockId: string;
    lockPath: string;
    onUnlocked: () => void;
}) {
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const result = await unlockPathAction(connectionId, lockId, password);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setPassword("");
        onUnlocked();
    }

    return (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-muted">
                <Lock className="size-5 text-muted-foreground" />
            </div>
            <div>
                <p className="text-sm font-medium">This location is locked</p>
                <p className="truncate text-xs text-muted-foreground">/{lockPath}</p>
            </div>
            <form onSubmit={submit} className="flex w-full flex-col gap-2">
                <Input
                    autoFocus
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter password"
                />
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <Button type="submit" disabled={busy || !password}>
                    {busy ? "Unlocking..." : "Unlock"}
                </Button>
            </form>
        </div>
    );
}
