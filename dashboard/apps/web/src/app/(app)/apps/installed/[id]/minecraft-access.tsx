"use client";

/**
 * Who can reach this server, and the way to let somebody else in.
 *
 * The point of this screen is that it does not need an administrator. Whoever
 * runs the server picks a person and what they may do here, and Polaris writes
 * the grant - so "let them kick players on this one server and nothing else" is
 * something the person who cares about it can actually do.
 *
 * Everything offered is bounded by what the viewer holds themselves, worked out
 * on the server. The dialog is a convenience over that, never the authority: the
 * action behind it resolves the same bounds again.
 */

import { CopyButton } from "@/components/copy-button";
import { AccountInput } from "@/components/account-input";
import { useDisplayFormat } from "@/components/display-format";
import { Crown, Loader2, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { InstallAccessEntry, InstallAccessView } from "@/lib/apps/install-sharing";
import { installAccessAction, revokeInstallAccessAction, shareInstallAction } from "./access-actions";
import { PERMISSION_META, RESOURCE_PRESETS, expandPermissions, presetFor, type Permission } from "@polaris/core";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";

/** How long access may last, in the shape somebody actually thinks about it. */
const DURATIONS: { value: string; label: string; days: number | null }[] = [
    { value: "forever", label: "No end date", days: null },
    { value: "1", label: "24 hours", days: 1 },
    { value: "7", label: "7 days", days: 7 },
    { value: "30", label: "30 days", days: 30 }
];

export function MinecraftAccess({ installedAppId }: { installedAppId: string }) {
    const [view, setView] = useState<InstallAccessView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sharing, setSharing] = useState(false);
    const [removing, setRemoving] = useState<InstallAccessEntry | null>(null);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(() => {
        void installAccessAction(installedAppId).then((result) => {
            if (result.error) {
                setError(result.error);
                return;
            }
            setError(null);
            setView(result.view ?? null);
        });
    }, [installedAppId]);

    useEffect(() => load(), [load]);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                        <h2 className="text-sm font-medium">Who can reach this server</h2>
                        <p className="max-w-xl text-sm text-muted-foreground">
                            Access given here applies to this server only. It does not open anything else in Polaris.
                        </p>
                    </div>
                    {view?.canShare && (
                        <Button size="sm" onClick={() => setSharing(true)}>
                            <UserPlus className="size-4" /> Give access
                        </Button>
                    )}
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}

                {view === null ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                ) : (
                    <div className="flex flex-col divide-y divide-border/60">
                        {view.entries.map((entry) => (
                            <AccessRow
                                key={entry.grantId ?? "owner"}
                                entry={entry}
                                pending={pending}
                                onRemove={() => {
                                    setRemoveError(null);
                                    setRemoving(entry);
                                }}
                            />
                        ))}
                        {view.entries.length === 1 && (
                            <p className="pt-3 text-sm text-muted-foreground">
                                Nobody else has access. Give somebody access to let them help run this server.
                            </p>
                        )}
                    </div>
                )}

                {view && !view.canShare && view.shareRefusal && (
                    <p className="text-xs text-muted-foreground">{view.shareRefusal}</p>
                )}
            </CardBody>

            {view && (
                <ShareDialog
                    open={sharing}
                    onOpenChange={setSharing}
                    installedAppId={installedAppId}
                    grantable={view.grantable}
                    canInvite={view.canInvite}
                    onDone={load}
                />
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !pending && !open && setRemoving(null)}
                name={removing?.label ?? ""}
                kind="access"
                confirmLabel="Remove"
                description="They lose this server the next time a page loads. Nothing else about their account changes."
                error={removeError}
                pending={pending}
                onConfirm={() =>
                    startTransition(async () => {
                        if (!removing?.grantId) return;
                        const result = await revokeInstallAccessAction(installedAppId, removing.grantId);
                        if (result.error) {
                            setRemoveError(result.error);
                            return;
                        }
                        setRemoving(null);
                        load();
                    })
                }
            />
        </Card>
    );
}

/** What a grant lets somebody do, in a phrase rather than a list of keys. */
function summarize(actions: readonly Permission[]): string {
    const preset = presetFor("install", [...actions]);
    if (preset) return preset.label;
    return actions.map((action) => PERMISSION_META[action]?.label ?? action).join(", ");
}

function AccessRow({
    entry,
    pending,
    onRemove
}: {
    entry: InstallAccessEntry;
    pending: boolean;
    onRemove: () => void;
}) {
    const display = useDisplayFormat();
    const isOwner = entry.principalType === "owner";
    return (
        <div className="flex items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                    {isOwner && <Crown className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate text-sm" title={entry.label}>{entry.label}</span>
                    {isOwner && <Badge>owner</Badge>}
                    {entry.canShare && !isOwner && <Badge>can invite others</Badge>}
                    {entry.expired && <Badge className="border-danger/40 text-danger">ended</Badge>}
                </div>
                <span className="text-xs text-muted-foreground">
                    {isOwner ? "Everything on this server" : summarize(entry.actions)}
                    {entry.expiresAt && ` - until ${display.date(entry.expiresAt)}`}
                </span>
            </div>
            {entry.grantId && (
                <Button
                    size="icon"
                    variant="ghost"
                    disabled={pending}
                    onClick={onRemove}
                    aria-label={`Remove ${entry.label}'s access`}
                    title={`Remove ${entry.label}'s access`}
                >
                    <Trash2 className="size-4" />
                </Button>
            )}
        </div>
    );
}

function ShareDialog({
    open,
    onOpenChange,
    installedAppId,
    grantable,
    canInvite,
    onDone
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    installedAppId: string;
    grantable: readonly Permission[];
    canInvite: boolean;
    onDone: () => void;
}) {
    const presets = RESOURCE_PRESETS.install.filter((preset) =>
        preset.actions.every((action) => grantable.includes(action))
    );
    const [identifier, setIdentifier] = useState("");
    const [actions, setActions] = useState<Permission[]>([]);
    const [duration, setDuration] = useState("forever");
    const [canShare, setCanShare] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issued, setIssued] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reset() {
        setIdentifier("");
        setActions([]);
        setDuration("forever");
        setCanShare(false);
        setError(null);
        setIssued(null);
    }

    function toggle(action: Permission) {
        setActions((current) =>
            current.includes(action)
                ? current.filter((held) => held !== action)
                : expandPermissions([...current, action])
        );
    }

    function submit() {
        setError(null);
        startTransition(async () => {
            const days = DURATIONS.find((entry) => entry.value === duration)?.days ?? null;
            const result = await shareInstallAction({
                installedAppId,
                identifier,
                actions,
                canShare,
                expiresInDays: days
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.invite?.url) {
                setIssued(result.invite.url);
                onDone();
                return;
            }
            if (result.invite?.sendError) {
                setError(result.invite.sendError);
                return;
            }
            onDone();
            onOpenChange(false);
            reset();
        });
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                onOpenChange(next);
                if (!next) reset();
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Give access</DialogTitle>
                    <DialogDescription>
                        They get what you tick, on this server. Nothing else in Polaris opens.
                    </DialogDescription>
                </DialogHeader>

                {issued ? (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm">
                            Send them this link. It is shown once, and it expires if it is not used.
                        </p>
                        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-surface px-3 py-2">
                            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={issued}>{issued}</code>
                            <CopyButton value={issued} label="Copy the invite link" />
                        </div>
                        <Button
                            className="self-end"
                            onClick={() => {
                                onOpenChange(false);
                                reset();
                            }}
                        >
                            Done
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Email or username</span>
                            <AccountInput
                                value={identifier}
                                onValueChange={setIdentifier}
                                placeholder="ana@example.com"
                                aria-label="Email or username"
                            />
                            <span className="text-xs text-muted-foreground">
                                {canInvite
                                    ? "If they have no account yet, they get an invite link to make one."
                                    : "They need a Polaris account already. Ask an administrator to invite them otherwise."}
                            </span>
                        </label>

                        <div className="flex flex-col gap-2">
                            <span className="text-sm font-medium">What they may do</span>
                            <div className="flex flex-wrap gap-2">
                                {presets.map((preset) => (
                                    <Button
                                        key={preset.slug}
                                        size="sm"
                                        variant={
                                            presetFor("install", actions)?.slug === preset.slug
                                                ? "primary"
                                                : "secondary"
                                        }
                                        onClick={() => setActions(expandPermissions([...preset.actions]))}
                                        title={preset.hint}
                                    >
                                        {preset.label}
                                    </Button>
                                ))}
                            </div>
                            <div className="flex flex-col gap-1 pt-1">
                                {grantable.map((action) => (
                                    <label key={action} className="flex items-center gap-2 text-sm">
                                        <Checkbox
                                            checked={actions.includes(action)}
                                            onChange={() => toggle(action)}
                                        />
                                        <span>{PERMISSION_META[action]?.label ?? action}</span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Access ends</span>
                            <Select
                                value={duration}
                                onValueChange={setDuration}
                                options={DURATIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
                                aria-label="When their access ends"
                            />
                        </label>

                        <label className="flex items-center justify-between gap-3 text-sm">
                            <span className="flex flex-col">
                                <span className="font-medium">Let them give access to others</span>
                                <span className="text-xs text-muted-foreground">
                                    They can pass on the same things you gave them, and no more.
                                </span>
                            </span>
                            <Switch checked={canShare} onChange={setCanShare} />
                        </label>

                        {error && <p className="text-sm text-danger">{error}</p>}

                        <div className="flex justify-end gap-2">
                            <Button
                                variant="secondary"
                                disabled={pending}
                                onClick={() => {
                                    onOpenChange(false);
                                    reset();
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                disabled={pending || identifier.trim() === "" || actions.length === 0}
                                onClick={submit}
                            >
                                {pending && <Loader2 className="size-4 animate-spin" />}
                                Give access
                            </Button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
