"use client";

/**
 * Tokens: API access limited to this project.
 *
 * A token is issued against the account of whoever minted it and narrowed twice -
 * to this project, and to reading unless it was asked to do more - so it can
 * never reach further than that person can on this project today, and changing
 * or removing their access shrinks or stops every token they made with it.
 *
 * The secret is shown once. There is no way to recover it afterwards, which is
 * the point of storing only its hash, so the panel says so plainly rather than
 * letting somebody close the dialog assuming they can come back for it.
 */

import { SettingsCard } from "../project-settings";
import { useEffect, useState, useTransition } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
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

const LIFETIME_LABELS = {
    "30d": "tokens.lifetimes.days30",
    "90d": "tokens.lifetimes.days90",
    "365d": "tokens.lifetimes.year",
    never: "tokens.lifetimes.never"
} as const satisfies Record<TokenLifetime, string>;

export function TokensSection({ projectId, canManage }: { projectId: string; canManage: boolean }) {
    const t = useTranslations("deploySettings");
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
        if (token.revokedAt) return { label: t("tokens.revoked"), className: "text-danger" };
        if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
            return { label: t("tokens.expired"), className: "text-warning" };
        }
        return { label: t("tokens.active"), className: "text-success" };
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title={t("tokens.title")}
                description={t("tokens.description")}
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
                            <p className="text-sm text-muted-foreground">{t("tokens.empty")}</p>
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
                                            {token.scopes.includes("deploy.manage") ? t("tokens.canChange") : t("tokens.readOnly")}
                                            {t("tokens.madeBy", { name: token.madeBy })}
                                            {token.expiresAt ? t("tokens.expires", { date: display.date(token.expiresAt) }) : ""}
                                            {token.lastUsedAt
                                                ? t("tokens.lastUsed", { date: display.dateTime(token.lastUsedAt) })
                                                : t("tokens.neverUsed")}
                                        </p>
                                    </div>
                                    {canManage && (
                                        <div className="flex shrink-0 items-center gap-1">
                                            {!token.revokedAt && (
                                                <Button variant="ghost" size="sm" onClick={() => revoke(token)} disabled={pending}>
                                                    {t("tokens.revoke")}
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setDeleting(token)}
                                                aria-label={t("tokens.deleteNamed", { name: token.name })}
                                                title={t("tokens.delete")}
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
                            <Plus className="size-4" /> {t("tokens.new")}
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
                title={t("tokens.deleteTitle")}
                confirmLabel={t("tokens.deleteTitle")}
                description={t("tokens.deleteDescription")}
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
    const t = useTranslations("deploySettings");
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
                setError(result.error ?? t("tokens.createFailed"));
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
                    <DialogTitle>{t("tokens.createTitle")}</DialogTitle>
                    <DialogDescription>{t("tokens.createDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("tokens.name")}</span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("tokens.namePlaceholder")}
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("tokens.expiresLabel")}</span>
                        <Select
                            value={lifetime}
                            onValueChange={(value) => setLifetime(value as TokenLifetime)}
                            options={TOKEN_LIFETIMES.map((value) => ({ value, label: t(LIFETIME_LABELS[value]) }))}
                            aria-label={t("tokens.expiresLabel")}
                        />
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox checked={canManage} onChange={(event) => setCanManage(event.target.checked)} />
                        <span>
                            {t("tokens.allowChanges")}
                            <span className="block text-xs text-muted-foreground">{t("tokens.allowChangesHint")}</span>
                        </span>
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("tokens.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim()}>
                            {pending && <Loader2 className="size-4 animate-spin" />} {t("tokens.create")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function IssuedTokenDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
    const t = useTranslations("deploySettings");
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
                    <DialogTitle>{t("tokens.issuedTitle")}</DialogTitle>
                    <DialogDescription>{t("tokens.issuedDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-xs">
                            {secret}
                        </code>
                        <Button variant="ghost" size="icon" onClick={copy} aria-label={t("tokens.copyToken")} title={t("tokens.copy")}>
                            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                        </Button>
                    </div>
                    <div className="flex justify-end">
                        <Button onClick={onClose}>{t("tokens.done")}</Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
