"use client";

/**
 * A database's Users and Processes tabs: the accounts inside the instance and
 * what each may reach, and the connections open on it right now.
 *
 * A generated password is shown once, in the answer that made it, and is gone
 * when the notice is closed. The connection list refreshes while the tab is
 * open; ending one is confirmed in the panel's own dialog, and the connection
 * that made the listing is marked and cannot be ended.
 */

import * as core from "@polaris/core";
import { CopyRow } from "./deploy-view";
import * as actions from "./database-actions";
import * as polls from "./deploy-polls";
import { useUnmountSignal } from "@/lib/poll-fetch";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Badge, Button, Input, Select, Skeleton } from "@polaris/ui";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";

/** A pending confirmation, as the Manage panel's dialog takes it. */
interface Confirmation {
    title: string;
    body: ReactNode;
    label: string;
    danger?: boolean;
    run: () => Promise<{ error?: string }>;
}
type Ask = (confirmation: Confirmation) => void;

type Listing = NonNullable<
    Awaited<ReturnType<typeof actions.listDatabaseAccountsAction>>["accounts"]
>;
type Process = NonNullable<
    Awaited<ReturnType<typeof actions.listDatabaseProcessesAction>>["processes"]
>[number];

/** The engines and layouts these tabs work on. */
export function hasAccountTabs(overview: {
    engine: string;
    hosted: boolean;
    topology: unknown;
}): boolean {
    return core.isAccountEngine(overview.engine) && !overview.hosted && !overview.topology;
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
    const t = useTranslations("deployData");
    return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 text-danger">{message}</span>
            <Button size="sm" variant="ghost" onClick={onRetry}>
                <RefreshCw className="size-4" />
                {t("database.users.retry")}
            </Button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function UsersSection({
    databaseId,
    manage,
    ask
}: {
    databaseId: string;
    manage: boolean;
    ask: Ask;
}) {
    const t = useTranslations("deployData");
    const [accounts, setAccounts] = useState<Listing | null>(null);
    const [databases, setDatabases] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [createError, setCreateError] = useState<string | null>(null);
    const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
    const [granting, setGranting] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback(async () => {
        const result = await actions.listDatabaseAccountsAction(databaseId);
        if (result.accounts) {
            setAccounts(result.accounts);
            setDatabases(result.databases ?? []);
            setError(null);
        } else setError(result.error ?? t("database.users.unreadable"));
    }, [databaseId]);

    useEffect(() => {
        void load();
    }, [load]);

    const parsed = core.dbAccountCreateSchema.safeParse({ username: name });
    const nameIssue =
        name.trim() && !parsed.success
            ? /^[a-z_][a-z0-9_]{0,31}$/.test(name.trim().toLowerCase())
                ? t("database.users.nameReserved")
                : t("database.users.nameInvalid")
            : null;

    function create() {
        if (!parsed.success) return;
        setCreateError(null);
        startTransition(async () => {
            const result = await actions.createDatabaseAccountAction({
                databaseId,
                username: parsed.data.username
            });
            if (result.error || !result.username || !result.password) {
                setCreateError(result.error ?? t("database.users.unreadable"));
                return;
            }
            setCreated({ username: result.username, password: result.password });
            setName("");
            await load();
        });
    }

    /** The panel's dialog, with this list read again once it has run. */
    function confirmThen(confirmation: Confirmation) {
        ask({
            ...confirmation,
            run: async () => {
                const result = await confirmation.run();
                if (!result.error) await load();
                return result;
            }
        });
    }

    return (
        <section className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-medium">{t("database.users.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("database.users.hint")}</p>
            </div>

            {manage ? (
                <form
                    className="flex flex-wrap items-start gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        create();
                    }}
                >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <Input
                            aria-label={t("database.users.name")}
                            placeholder={t("database.users.namePlaceholder")}
                            value={name}
                            maxLength={32}
                            onChange={(event) => setName(event.target.value)}
                            aria-invalid={nameIssue ? true : undefined}
                        />
                        {nameIssue ? <p className="text-xs text-danger">{nameIssue}</p> : null}
                    </div>
                    <Button
                        type="submit"
                        size="sm"
                        disabled={pending || !parsed.success}
                        aria-disabled={!parsed.success}
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Plus className="size-4" />
                        )}
                        {t("database.users.add")}
                    </Button>
                </form>
            ) : null}
            {createError ? <p className="text-sm text-danger">{createError}</p> : null}

            {created ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0">
                            {t("database.users.created", { name: created.username })}
                        </p>
                        <button
                            type="button"
                            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={t("database.users.dismiss")}
                            title={t("database.users.dismiss")}
                            onClick={() => setCreated(null)}
                        >
                            <X className="size-4" />
                        </button>
                    </div>
                    <CopyRow value={created.password} />
                    <p className="text-xs text-muted-foreground">{t("database.users.shownOnce")}</p>
                </div>
            ) : null}

            {error && !accounts ? <LoadError message={error} onRetry={() => void load()} /> : null}
            {!accounts && !error ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : null}
            {accounts && accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("database.users.empty")}</p>
            ) : null}
            {accounts && accounts.length > 0 ? (
                <ul className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border">
                    {accounts.map((account) => (
                        <li key={account.username} className="flex flex-col gap-2 p-3">
                            <div className="flex items-center gap-2">
                                <span
                                    className="min-w-0 truncate font-mono text-sm"
                                    title={account.username}
                                >
                                    {account.username}
                                </span>
                                {account.protected ? (
                                    <Badge>{t("database.users.protected")}</Badge>
                                ) : null}
                                <span className="flex-1" />
                                {manage && !account.protected ? (
                                    <>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={databases.length === 0}
                                            title={
                                                databases.length === 0
                                                    ? t("database.users.noDatabases")
                                                    : undefined
                                            }
                                            onClick={() =>
                                                setGranting(
                                                    granting === account.username
                                                        ? null
                                                        : account.username
                                                )
                                            }
                                        >
                                            {t("database.users.grant")}
                                        </Button>
                                        <button
                                            type="button"
                                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                                            aria-label={t("database.users.remove", {
                                                name: account.username
                                            })}
                                            title={t("database.users.remove", {
                                                name: account.username
                                            })}
                                            onClick={() =>
                                                confirmThen({
                                                    title: t("database.users.removeTitle", {
                                                        name: account.username
                                                    }),
                                                    body: t("database.users.removeBody"),
                                                    label: t("database.users.removeConfirm"),
                                                    danger: true,
                                                    run: () =>
                                                        actions.dropDatabaseAccountAction({
                                                            databaseId,
                                                            username: account.username
                                                        })
                                                })
                                            }
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </>
                                ) : null}
                            </div>
                            {account.databases.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                    {account.databases.map((database) => (
                                        <span
                                            key={database}
                                            className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
                                        >
                                            <span className="min-w-0 truncate" title={database}>
                                                {database}
                                            </span>
                                            {manage && !account.protected ? (
                                                <button
                                                    type="button"
                                                    className="shrink-0 text-muted-foreground hover:text-danger"
                                                    aria-label={t("database.users.revoke", {
                                                        database
                                                    })}
                                                    title={t("database.users.revoke", { database })}
                                                    onClick={() =>
                                                        confirmThen({
                                                            title: t("database.users.revokeTitle", {
                                                                database
                                                            }),
                                                            body: t("database.users.revokeBody", {
                                                                name: account.username,
                                                                database
                                                            }),
                                                            label: t(
                                                                "database.users.revokeConfirm"
                                                            ),
                                                            danger: true,
                                                            run: () =>
                                                                actions.revokeDatabaseAccountAction(
                                                                    {
                                                                        databaseId,
                                                                        username: account.username,
                                                                        database
                                                                    }
                                                                )
                                                        })
                                                    }
                                                >
                                                    <X className="size-3" />
                                                </button>
                                            ) : null}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {t("database.users.noAccess")}
                                </p>
                            )}
                            {granting === account.username ? (
                                <GrantForm
                                    databaseId={databaseId}
                                    username={account.username}
                                    databases={databases}
                                    onDone={async () => {
                                        setGranting(null);
                                        await load();
                                    }}
                                />
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

function GrantForm({
    databaseId,
    username,
    databases,
    onDone
}: {
    databaseId: string;
    username: string;
    databases: string[];
    onDone: () => Promise<void>;
}) {
    const t = useTranslations("deployData");
    const [database, setDatabase] = useState(databases[0] ?? "");
    const [privileges, setPrivileges] = useState<core.DbPrivilege>("readwrite");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const privilegeLabel: Record<core.DbPrivilege, string> = {
        owner: t("database.users.privileges.owner"),
        readwrite: t("database.users.privileges.readwrite"),
        readonly: t("database.users.privileges.readonly")
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
                <Select
                    aria-label={t("database.users.database")}
                    value={database}
                    onValueChange={setDatabase}
                    options={databases.map((value) => ({ value, label: value }))}
                />
            </div>
            <div className="min-w-0 flex-1">
                <Select
                    aria-label={t("database.users.access")}
                    value={privileges}
                    onValueChange={(value) => setPrivileges(value as core.DbPrivilege)}
                    options={core.DB_PRIVILEGES.map((value) => ({
                        value,
                        label: privilegeLabel[value]
                    }))}
                />
            </div>
            <Button
                size="sm"
                disabled={pending || !database}
                onClick={() =>
                    startTransition(async () => {
                        const result = await actions.grantDatabaseAccountAction({
                            databaseId,
                            username,
                            database,
                            privileges
                        });
                        if (result.error) setError(result.error);
                        else await onDone();
                    })
                }
            >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("database.users.grantConfirm")}
            </Button>
            {error ? <p className="w-full text-xs text-danger">{error}</p> : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** How often the list is read again while the tab is open. */
const PROCESS_REFRESH_MS = 5000;

export function ProcessesSection({
    databaseId,
    manage,
    ask
}: {
    databaseId: string;
    manage: boolean;
    ask: Ask;
}) {
    const t = useTranslations("deployData");
    const [processes, setProcesses] = useState<Process[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const signal = useUnmountSignal();
    const load = useCallback(async () => {
        const result = await polls.databaseProcesses(databaseId, signal());
        if (result.processes) {
            setProcesses(result.processes);
            setError(null);
        } else setError(result.error ?? t("database.processes.unreadable"));
    }, [databaseId]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, PROCESS_REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    return (
        <section className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-medium">{t("database.processes.title")}</h3>
                <p className="text-xs text-muted-foreground">
                    {t("database.processes.hint", { count: core.PROCESS_LIMIT })}
                </p>
            </div>
            {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
            {!processes && !error ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            ) : null}
            {processes && processes.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("database.processes.empty")}</p>
            ) : null}
            {processes && processes.length > 0 ? (
                <ul className="flex max-h-[28rem] flex-col divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border">
                    {processes.map((process) => (
                        <li key={process.id} className="flex items-start gap-2 p-3 text-sm">
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="font-mono text-xs text-muted-foreground">
                                        #{process.id}
                                    </span>
                                    <span
                                        className="min-w-0 truncate font-medium"
                                        title={process.user}
                                    >
                                        {process.user || t("database.processes.system")}
                                    </span>
                                    {process.database ? (
                                        <span
                                            className="min-w-0 truncate text-muted-foreground"
                                            title={process.database}
                                        >
                                            {process.database}
                                        </span>
                                    ) : null}
                                    {process.self ? (
                                        <Badge>{t("database.processes.self")}</Badge>
                                    ) : null}
                                    {process.state ? <Badge>{process.state}</Badge> : null}
                                    <span className="text-xs text-muted-foreground">
                                        {t("database.processes.seconds", {
                                            seconds: process.seconds
                                        })}
                                    </span>
                                </div>
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={process.client}
                                >
                                    {process.client}
                                </span>
                                {process.query ? (
                                    <code className="block truncate text-xs" title={process.query}>
                                        {process.query}
                                    </code>
                                ) : null}
                            </div>
                            {manage && !process.self ? (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        ask({
                                            title: t("database.processes.killTitle", {
                                                id: process.id
                                            }),
                                            body: t("database.processes.killBody", {
                                                user: process.user || t("database.processes.system")
                                            }),
                                            label: t("database.processes.killConfirm"),
                                            danger: true,
                                            run: async () => {
                                                const result =
                                                    await actions.killDatabaseProcessAction({
                                                        databaseId,
                                                        processId: process.id
                                                    });
                                                if (!result.error) await load();
                                                return result;
                                            }
                                        })
                                    }
                                >
                                    {t("database.processes.kill")}
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
