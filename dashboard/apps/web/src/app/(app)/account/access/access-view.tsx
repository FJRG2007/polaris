"use client";

/**
 * Access rules: the account's sign-in restrictions on top, the reusable groups
 * below. Both edit through the same dialog component, so a rule set looks and
 * behaves identically wherever it is written.
 *
 * The current address is shown next to the sign-in card because it is the one
 * piece of information that makes these rules safe to write - the server refuses
 * a change that would shut this address out, but seeing it first avoids the trip.
 */

import { useState } from "react";
import { namePlaces } from "@polaris/core";
import { useRouter } from "next/navigation";
import type { AccessGroupView } from "@polaris/auth";
import { useConfirm } from "@/components/confirm-dialog";
import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import {
    createAccessGroupAction,
    deleteAccessGroupAction,
    saveSignInRulesAction,
    updateAccessGroupAction
} from "./actions";
import {
    AccessRulesEditor,
    accessRulesAreEmpty,
    accessRulesEqual,
    EMPTY_ACCESS_RULES,
    type AccessRulesValue
} from "@/components/access-rules-editor";
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
    Input
} from "@polaris/ui";

/** One-line summary of what a rule set restricts. */
function summarize(value: {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    groupIds?: string[];
}): string {
    const parts: string[] = [];
    if (value.groupIds?.length) parts.push(`${value.groupIds.length} group${value.groupIds.length === 1 ? "" : "s"}`);
    if (value.allowedCidrs.length) {
        parts.push(`${value.allowedCidrs.length} address rule${value.allowedCidrs.length === 1 ? "" : "s"}`);
    }
    const places = value.allowedCountries.length + value.allowedContinents.length;
    if (places) parts.push(`${places} location${places === 1 ? "" : "s"}`);
    return parts.length > 0 ? parts.join(", ") : "No restriction - reachable from anywhere";
}

/**
 * The same rule set spelled out. A count is enough where a dialog can be opened
 * to see the entries; where there is none - the limits an administrator imposed -
 * "1 location" tells a user they are restricted without telling them to what,
 * which is the one thing they need in order to understand a refused sign-in.
 */
function spellOut(value: {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
}): string {
    return [...value.allowedCidrs, ...namePlaces(value.allowedCountries, value.allowedContinents)].join(", ");
}

export function AccessView({
    groups,
    signInRules,
    currentIp,
    enforced
}: {
    groups: AccessGroupView[];
    signInRules: AccessRulesValue;
    currentIp: string | null;
    /** Limits an administrator set on the account, which it cannot edit away. */
    enforced: { allowedCidrs: string[]; allowedCountries: string[]; allowedContinents: string[] };
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [signInOpen, setSignInOpen] = useState(false);
    const [groupDialog, setGroupDialog] = useState<{ mode: "create" } | { mode: "edit"; group: AccessGroupView } | null>(
        null
    );
    const [error, setError] = useState<string | null>(null);
    const enforcedSummary = accessRulesAreEmpty({ ...enforced, groupIds: [] }) ? null : spellOut(enforced);

    async function removeGroup(group: AccessGroupView) {
        const ok = await confirm({
            title: `Delete "${group.name}"?`,
            description:
                group.apiKeyCount > 0 || group.appliedToSignIn
                    ? "It is in use; the rules it contributes will stop applying."
                    : "This cannot be undone.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!ok) return;
        const result = await deleteAccessGroupAction(group.id);
        if (result.error) setError(result.error);
        else router.refresh();
    }

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <Card>
                <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">Sign-in restrictions</h2>
                        <p className="text-xs text-muted-foreground">{summarize(signInRules)}</p>
                        {currentIp ? (
                            <p className="pt-1 text-xs text-muted-foreground">
                                You are connecting from <span className="font-mono">{currentIp}</span>
                            </p>
                        ) : null}
                        {/* Not editable here, but a sign-in it refuses is otherwise
                            unexplainable from this page. */}
                        {enforcedSummary ? (
                            <p className="pt-1 text-xs text-warning">
                                An administrator also limits this account to {enforcedSummary}.
                            </p>
                        ) : null}
                    </div>
                    <Button onClick={() => setSignInOpen(true)}>
                        <Pencil className="size-4" />
                        Edit
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <h2 className="text-sm font-medium">Access groups</h2>
                            <p className="text-xs text-muted-foreground">
                                Named rule sets you can attach to your sign-ins and to API keys.
                            </p>
                        </div>
                        <Button size="sm" onClick={() => setGroupDialog({ mode: "create" })}>
                            <Plus className="size-4" />
                            New group
                        </Button>
                    </div>

                    {groups.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No groups yet. Create one to reuse the same allowlist in more than one place.
                        </p>
                    ) : (
                        groups.map((group) => (
                            <div
                                key={group.id}
                                className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <Globe className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                        <p className="flex items-center gap-2 text-sm">
                                            <span className="truncate">{group.name}</span>
                                            {group.appliedToSignIn ? <Badge variant="primary">Sign-in</Badge> : null}
                                            {group.apiKeyCount > 0 ? (
                                                <Badge>
                                                    {group.apiKeyCount} key{group.apiKeyCount === 1 ? "" : "s"}
                                                </Badge>
                                            ) : null}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {group.description || summarize(group)}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Edit ${group.name}`}
                                        onClick={() => setGroupDialog({ mode: "edit", group })}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Delete ${group.name}`}
                                        onClick={() => void removeGroup(group)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </CardBody>
            </Card>

            <SignInRulesDialog
                open={signInOpen}
                onOpenChange={setSignInOpen}
                groups={groups}
                initial={signInRules}
                onSaved={() => router.refresh()}
            />
            {groupDialog ? (
                <GroupDialog
                    open
                    onOpenChange={(open) => !open && setGroupDialog(null)}
                    group={groupDialog.mode === "edit" ? groupDialog.group : null}
                    onSaved={() => {
                        setGroupDialog(null);
                        router.refresh();
                    }}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

function SignInRulesDialog({
    open,
    onOpenChange,
    groups,
    initial,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    groups: AccessGroupView[];
    initial: AccessRulesValue;
    onSaved: () => void;
}) {
    const [value, setValue] = useState<AccessRulesValue>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        setBusy(true);
        setError(null);
        const result = await saveSignInRulesAction(value);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onSaved();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setValue(initial);
                    setError(null);
                }
            }}
        >
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Sign-in restrictions</DialogTitle>
                    <DialogDescription>
                        Leave everything empty to allow sign-in from anywhere. Otherwise a sign-in must match your
                        address rules and your allowed locations.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <AccessRulesEditor value={value} groups={groups} onChange={setValue} />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    {accessRulesAreEmpty(value) ? (
                        <p className="text-xs text-muted-foreground">
                            No restriction: your account can be signed in from any address.
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void save()} disabled={busy || accessRulesEqual(value, initial)}>
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function GroupDialog({
    open,
    onOpenChange,
    group,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    group: AccessGroupView | null;
    onSaved: () => void;
}) {
    const [name, setName] = useState(group?.name ?? "");
    const [description, setDescription] = useState(group?.description ?? "");
    const [value, setValue] = useState<AccessRulesValue>(
        group
            ? {
                  groupIds: [],
                  allowedCidrs: group.allowedCidrs,
                  allowedCountries: group.allowedCountries,
                  allowedContinents: group.allowedContinents
              }
            : EMPTY_ACCESS_RULES
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** Editing an existing group only offers Save once something actually differs. */
    const unchanged =
        group !== null &&
        name.trim() === group.name &&
        description.trim() === (group.description ?? "") &&
        accessRulesEqual(value, {
            groupIds: [],
            allowedCidrs: group.allowedCidrs,
            allowedCountries: group.allowedCountries,
            allowedContinents: group.allowedContinents
        });

    async function save() {
        setBusy(true);
        setError(null);
        const input = {
            name,
            description: description || undefined,
            allowedCidrs: value.allowedCidrs,
            allowedCountries: value.allowedCountries,
            allowedContinents: value.allowedContinents
        };
        const result = group
            ? await updateAccessGroupAction(group.id, input)
            : await createAccessGroupAction(input);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onSaved();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{group ? `Edit "${group.name}"` : "New access group"}</DialogTitle>
                    <DialogDescription>
                        A named set of addresses and locations you can reuse anywhere access is restricted.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input
                            value={name}
                            placeholder="Home"
                            onChange={(event) => setName(event.target.value)}
                            autoComplete="off"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Description
                        <Input
                            value={description}
                            placeholder="Optional"
                            onChange={(event) => setDescription(event.target.value)}
                            autoComplete="off"
                        />
                    </label>
                    <AccessRulesEditor value={value} groups={[]} onChange={setValue} showGroups={false} />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void save()} disabled={busy || name.trim() === "" || unchanged}>
                            {busy ? "Saving..." : group ? "Save changes" : "Create group"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
