"use client";

/**
 * A service's SFTP accounts, under its volumes: who can reach these files from
 * an SFTP client, at which address, and whether they may only read. The server
 * behind them runs only while an account exists.
 *
 * enigma:allow-no-breach-check - the breach check runs on the server when the
 * account is created (`lib/deploy/file-access.ts`), and its refusal is shown here.
 */

import * as core from "@polaris/core";
import { useProjectCan } from "./access-context";
import { useEffect, useState, useTransition } from "react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { KeyRound, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    CopyButton,
    Input,
    Switch,
    Textarea
} from "@polaris/ui";
import {
    createFileAccessAccountAction,
    deleteFileAccessAccountAction,
    fileAccessAction
} from "./file-access-actions";

type View = NonNullable<Awaited<ReturnType<typeof fileAccessAction>>["view"]>;
type Account = View["accounts"][number];

const EMPTY = { username: "", password: "", publicKey: "", readOnly: false };

export function FileAccessPanel({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployData");
    const can = useProjectCan();
    const write = can("files.write");
    const [view, setView] = useState<View | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState(EMPTY);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<Account | null>(null);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function load() {
        void fileAccessAction(applicationId).then((result) => {
            if (result.view) {
                setView(result.view);
                setLoadError(null);
            } else setLoadError(result.error ?? t("fileAccess.unreadable"));
        });
    }
    useEffect(load, [applicationId]);

    // Checked as it is typed, against the schema the server parses with. An
    // untouched form is incomplete, not wrong.
    const touched = form.username !== "" || form.password !== "" || form.publicKey !== "";
    const parsed = core.fileAccessAccountSchema.safeParse(form);
    const issueKey = touched && !parsed.success ? parsed.error.issues[0]?.message : null;
    const issue = issueKey
        ? t.has(issueKey)
            ? t(issueKey as NamespaceKey<"deployData">)
            : t("fileAccess.issues.invalid")
        : null;

    function submit() {
        if (!parsed.success) return;
        setError(null);
        startTransition(async () => {
            const result = await createFileAccessAccountAction(applicationId, parsed.data);
            if (result.error) {
                setError(result.error);
                return;
            }
            setForm(EMPTY);
            setAdding(false);
            load();
        });
    }

    function remove() {
        if (!removing) return;
        const target = removing;
        setRemoveError(null);
        startTransition(async () => {
            const result = await deleteFileAccessAccountAction(applicationId, target.id);
            if (result.error) {
                setRemoveError(result.error);
                return;
            }
            setRemoving(null);
            load();
        });
    }

    if (!can("files.read")) return null;

    const address = view?.server?.host ? `sftp://${view.server.host}:${view.server.port}` : null;

    return (
        <section
            className="flex min-w-0 flex-col gap-3 border-t border-border pt-4"
            aria-labelledby={`sftp-${applicationId}`}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                    <h3 id={`sftp-${applicationId}`} className="text-sm font-medium">
                        {t("fileAccess.title")}
                    </h3>
                    <p className="text-xs text-muted-foreground">{t("fileAccess.intro")}</p>
                </div>
                {write && view && view.folders.length > 0 ? (
                    <Button size="sm" onClick={() => setAdding((open) => !open)}>
                        <Plus className="size-4" /> {t("fileAccess.add")}
                    </Button>
                ) : null}
            </div>

            {loadError ? <p className="text-sm text-danger">{loadError}</p> : null}
            {!view && !loadError ? (
                <div className="h-10 animate-pulse rounded-md bg-muted" />
            ) : null}

            {view && view.folders.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("fileAccess.noVolumes")}</p>
            ) : null}

            {view?.server ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{t("fileAccess.address")}</span>
                    {address ? (
                        <>
                            <code className="min-w-0 truncate" title={address}>
                                {address}
                            </code>
                            <CopyButton value={address} />
                        </>
                    ) : (
                        <span>{t("fileAccess.port", { port: view.server.port })}</span>
                    )}
                    {view.server.lastError ? (
                        <p className="w-full text-xs text-danger">{view.server.lastError}</p>
                    ) : null}
                </div>
            ) : null}

            {adding && write ? (
                <form
                    className="flex flex-col gap-3 rounded-md border border-border p-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("fileAccess.username")} <span aria-hidden="true">*</span>
                        </span>
                        <Input
                            value={form.username}
                            autoComplete="off"
                            onChange={(event) => setForm({ ...form, username: event.target.value })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("fileAccess.password")}</span>
                        <Input
                            type="password"
                            value={form.password}
                            autoComplete="new-password"
                            onChange={(event) => setForm({ ...form, password: event.target.value })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("fileAccess.publicKey")}</span>
                        <Textarea
                            rows={2}
                            value={form.publicKey}
                            // i18n-ignore: an example key line
                            placeholder="ssh-ed25519 AAAA..."
                            onChange={(event) =>
                                setForm({ ...form, publicKey: event.target.value })
                            }
                        />
                    </label>
                    <div className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={form.readOnly}
                            onChange={(readOnly) => setForm({ ...form, readOnly })}
                            aria-label={t("fileAccess.readOnly")}
                        />
                        <span>{t("fileAccess.readOnly")}</span>
                    </div>
                    {issue ? <p className="text-xs text-danger">{issue}</p> : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    {!view?.server ? (
                        <p className="text-xs text-muted-foreground">
                            {t("fileAccess.firstStarts")}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setAdding(false)}
                        >
                            {t("fileAccess.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            disabled={pending || !parsed.success}
                            aria-disabled={!parsed.success}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("fileAccess.create")}
                        </Button>
                    </div>
                </form>
            ) : null}

            {view && view.accounts.length > 0 ? (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {view.accounts.map((account) => (
                        <li
                            key={account.id}
                            className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm"
                        >
                            <span
                                className="min-w-0 flex-1 truncate font-mono"
                                title={account.username}
                            >
                                {account.username}
                            </span>
                            {account.hasPassword ? (
                                <span
                                    title={t("fileAccess.withPassword")}
                                    aria-label={t("fileAccess.withPassword")}
                                >
                                    <Lock className="size-4 shrink-0 text-muted-foreground" />
                                </span>
                            ) : null}
                            {account.hasKey ? (
                                <span
                                    title={t("fileAccess.withKey")}
                                    aria-label={t("fileAccess.withKey")}
                                >
                                    <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                                </span>
                            ) : null}
                            <Badge className="shrink-0">
                                {account.readOnly
                                    ? t("fileAccess.readOnlyBadge")
                                    : t("fileAccess.readWriteBadge")}
                            </Badge>
                            {write ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    title={t("fileAccess.remove")}
                                    aria-label={t("fileAccess.removeNamed", {
                                        name: account.username
                                    })}
                                    onClick={() => {
                                        setRemoveError(null);
                                        setRemoving(account);
                                    }}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : view && view.folders.length > 0 ? (
                <p className="text-sm text-muted-foreground">{t("fileAccess.empty")}</p>
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.username}
                    kind={t("fileAccess.kind")}
                    description={
                        view && view.accounts.length === 1 ? t("fileAccess.lastStops") : undefined
                    }
                    onConfirm={remove}
                    error={removeError}
                    pending={pending}
                />
            ) : null}
        </section>
    );
}
