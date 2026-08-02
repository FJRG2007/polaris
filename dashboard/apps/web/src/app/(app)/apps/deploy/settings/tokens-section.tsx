"use client";

/**
 * Tokens: API access limited to this project.
 *
 * A token is issued against the project owner's account and narrowed twice - to
 * this project, and to reading unless it was asked to do more - so it can never
 * reach further than the person who minted it, and revoking their role shrinks
 * every token with it.
 *
 * The secret is shown once. There is no way to recover it afterwards, which is
 * the point of storing only its hash, so the panel says so plainly rather than
 * letting somebody close the dialog assuming they can come back for it.
 */

import { SettingsCard } from "../project-settings";
import { useEffect, useState, useTransition } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { TOKEN_LIFETIMES, type TokenLifetime } from "@polaris/core";
import type { ProjectTokenView } from "@/lib/deploy-project-service";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import {
    createProjectTokenAction,
    deleteProjectTokenAction,
    listProjectTokensAction,
    revokeProjectTokenAction
} from "../project-actions";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

const LIFETIME_LABELS: Record<TokenLifetime, string> = {
    "30d": "30 days",
    "90d": "90 days",
    "365d": "1 year",
    never: "Never expires"
};

export function TokensSection({ projectId, canManage }: { projectId: string; canManage: boolean }) {
    const display = useDisplayFormat();
    const [tokens, setTokens] = useState<ProjectTokenView[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [issued, setIssued] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<ProjectTokenView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function load() {
        void listProjectTokensAction(projectId).then((result) => {
            if (result.error) {
                setError(result.error);
                setTokens([]);
                return;
            }
            setTokens(result.tokens ?? []);
        });
    }

    useEffect(load, [projectId]);

    function revoke(token: ProjectTokenView) {
        startTransition(async () => {
            const result = await revokeProjectTokenAction({ projectId, tokenId: token.id });
            if (result.error) setError(result.error);
            load();
        });
    }

    function remove() {
        if (!deleting) return;
        startTransition(async () => {
            const result = await deleteProjectTokenAction({ projectId, tokenId: deleting.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setDeleting(null);
            load();
        });
    }

    function state(token: ProjectTokenView): { label: string; className: string } {
        if (token.revokedAt) return { label: "Revoked", className: "text-danger" };
        if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
            return { label: "Expired", className: "text-warning" };
        }
        return { label: "Active", className: "text-success" };
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Project tokens"
                description="Present one as `Authorization: Bearer ...`. It acts on this project only, with the permissions of whoever owns it."
            >
                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="overflow-hidden rounded-md border border-border/60">
                    {tokens === null ? (
                        <div className="flex justify-center py-6 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                        </div>
                    ) : tokens.length === 0 ? (
                        <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
                            <KeyRound className="size-5 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">No tokens for this project.</p>
                        </div>
                    ) : (
                        tokens.map((token) => {
                            const status = state(token);
                            return (
                                <div
                                    key={token.id}
                                    className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{token.name}</p>
                                        <p className="truncate font-mono text-xs text-muted-foreground">
                                            {token.prefix}...
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            <span className={status.className}>{status.label}</span>
                                            {token.scopes.includes("deploy.manage") ? " - can change" : " - read only"}
                                            {token.expiresAt ? ` - expires ${display.date(token.expiresAt)}` : ""}
                                            {token.lastUsedAt ? ` - last used ${display.dateTime(token.lastUsedAt)}` : " - never used"}
                                        </p>
                                    </div>
                                    {canManage && (
                                        <div className="flex shrink-0 items-center gap-1">
                                            {!token.revokedAt && (
                                                <Button variant="ghost" size="sm" onClick={() => revoke(token)} disabled={pending}>
                                                    Revoke
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setDeleting(token)}
                                                aria-label={`Delete ${token.name}`}
                                                title="Delete"
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                {canManage && (
                    <div className="flex justify-end">
                        <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                            <Plus className="size-4" /> New token
                        </Button>
                    </div>
                )}
            </SettingsCard>

            <CreateTokenDialog
                projectId={projectId}
                open={creating}
                onOpenChange={setCreating}
                onIssued={(secret) => {
                    setCreating(false);
                    setIssued(secret);
                    load();
                }}
            />

            <IssuedTokenDialog secret={issued} onClose={() => setIssued(null)} />

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="token"
                description="Anything using it stops working immediately, and the record of what it did goes with it. Revoke instead if you want to keep the trail."
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}

function CreateTokenDialog({
    projectId,
    open,
    onOpenChange,
    onIssued
}: {
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onIssued: (secret: string) => void;
}) {
    const [name, setName] = useState("");
    const [lifetime, setLifetime] = useState<TokenLifetime>("90d");
    const [canManage, setCanManage] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await createProjectTokenAction({
                projectId,
                name: name.trim(),
                lifetime,
                canManage
            });
            if (result.error || !result.secret) {
                setError(result.error ?? "Could not create the token");
                return;
            }
            setName("");
            setCanManage(false);
            onIssued(result.secret);
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New project token</DialogTitle>
                    <DialogDescription>Shown once when it is created, and never again.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Name</span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="CI pipeline"
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Expires</span>
                        <Select
                            value={lifetime}
                            onValueChange={(value) => setLifetime(value as TokenLifetime)}
                            options={TOKEN_LIFETIMES.map((value) => ({ value, label: LIFETIME_LABELS[value] }))}
                            aria-label="Expires"
                        />
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox checked={canManage} onChange={(event) => setCanManage(event.target.checked)} />
                        <span>
                            Allow changes
                            <span className="block text-xs text-muted-foreground">
                                Without this the token can read the project but not deploy, edit, or delete anything in it.
                            </span>
                        </span>
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim()}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Create token
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function IssuedTokenDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
    const [copied, setCopied] = useState(false);

    function copy() {
        if (!secret) return;
        void navigator.clipboard?.writeText(secret).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    }

    return (
        <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Copy your token</DialogTitle>
                    <DialogDescription>
                        This is the only time it is shown. Polaris stores a hash, so it cannot be recovered later.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-xs">
                            {secret}
                        </code>
                        <Button variant="ghost" size="icon" onClick={copy} aria-label="Copy token" title="Copy">
                            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                        </Button>
                    </div>
                    <div className="flex justify-end">
                        <Button onClick={onClose}>Done</Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
