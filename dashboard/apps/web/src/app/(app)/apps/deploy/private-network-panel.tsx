"use client";

/**
 * A service's Private networking panel, the way Railway's reads: its address
 * with a copy button, the address families, whether it is ready to talk, the
 * short name it also answers to, and an edit field for the name with a live
 * availability check. Then what Railway does not have: calling it with no
 * port, extra names, who can and cannot call it, and the links that let a
 * service of another project in.
 *
 * Its heading draws at once; only the part that waits on the server is a
 * skeleton. Read once and kept for half a minute, dropped on every change.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Badge, Button, CopyButton, Input, Select, Skeleton } from "@polaris/ui";
import type { NamesApplied, PrivateNetworkStatus, PrivateNetworkView } from "@/lib/deploy/private-names";
import { CheckCircle2, CircleAlert, CircleDashed, Clock, Loader2, Network, Pencil, Plus, X } from "lucide-react";
import { FORMER_NAME_GRACE_DAYS, normalizePrivateName, privateNameProblem, type PrivateNameProblem } from "@polaris/core";
import {
    addCrossLinkAction,
    checkPrivateNameAction,
    crossLinkCandidatesAction,
    privateNetworkAction,
    removeCrossLinkAction,
    renamePrivateNameAction,
    setPrivateAliasesAction
} from "./private-network-actions";

type Kind = "application" | "database";

/** How long a read is reused before the server is asked again. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; view: PrivateNetworkView; canEdit: boolean }>();

const PROBLEM_KEYS = {
    empty: "problems.empty",
    tooLong: "problems.tooLong",
    characters: "problems.characters",
    edges: "problems.edges",
    letter: "problems.letter",
    reserved: "problems.reserved"
} as const satisfies Record<PrivateNameProblem, string>;

const APPLIED_RENAME = { now: "renamed", next: "renamedNext", first: "renamedLater" } as const satisfies Record<
    NamesApplied,
    string
>;
const APPLIED_SAVE = { now: "savedRedeploy", next: "savedNext", first: "savedLater" } as const satisfies Record<
    NamesApplied,
    string
>;

const STATUS_TONE: Record<PrivateNetworkStatus, string> = {
    ready: "text-success-ink",
    starting: "text-warning-ink",
    pending: "text-warning-ink",
    offline: "text-muted-foreground",
    taken: "text-warning-ink",
    kept: "text-muted-foreground",
    unsupported: "text-warning-ink"
};

function StatusIcon({ status }: { status: PrivateNetworkStatus }) {
    if (status === "ready") return <CheckCircle2 className="size-4 shrink-0" />;
    if (status === "starting") return <Loader2 className="size-4 shrink-0 animate-spin" />;
    if (status === "pending") return <Clock className="size-4 shrink-0" />;
    if (status === "offline") return <CircleDashed className="size-4 shrink-0" />;
    return <CircleAlert className="size-4 shrink-0" />;
}

const code = (chunks: ReactNode) => <code className="rounded bg-muted px-1 font-mono text-[0.8125rem]">{chunks}</code>;

export function PrivateNetworkPanel({ kind, id }: { kind: Kind; id: string }) {
    const t = useTranslations("deployPrivateNet");
    const key = `${kind}:${id}`;
    const [data, setData] = useState(() => {
        const hit = cache.get(key);
        return hit && Date.now() - hit.at < CACHE_MS ? hit : null;
    });
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(
        async (force: boolean) => {
            const hit = cache.get(key);
            if (!force && hit && Date.now() - hit.at < CACHE_MS) {
                setData(hit);
                return;
            }
            const result = await privateNetworkAction(kind, id);
            if (!result.view) {
                setError(result.error ?? t("loadFailed"));
                return;
            }
            const entry = { at: Date.now(), view: result.view, canEdit: Boolean(result.canEdit) };
            cache.set(key, entry);
            setError(null);
            setData(entry);
        },
        [id, key, kind, t]
    );

    useEffect(() => {
        void load(false);
    }, [load]);

    /** After a change: forget the cached read and take the new one. */
    const changed = useCallback(
        async (message: string | null) => {
            cache.delete(key);
            setNotice(message);
            await load(true);
        },
        [key, load]
    );

    return (
        <section className="flex flex-col gap-3" aria-labelledby={`${key}-private-title`}>
            <div className="flex flex-col gap-0.5">
                <h3 id={`${key}-private-title`} className="flex items-center gap-2 text-sm font-medium">
                    <Network className="size-4 text-muted-foreground" /> {t("title")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("intro")}</p>
            </div>
            {error && !data && (
                <div className="flex items-center gap-2 text-xs text-danger-ink">
                    <span>{error}</span>
                    <Button size="xs" variant="outline" onClick={() => void load(true)}>
                        {t("retry")}
                    </Button>
                </div>
            )}
            {!data && !error && (
                <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
                    <Skeleton className="h-5 w-64" />
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-56" />
                </div>
            )}
            {data && (
                <PanelBody
                    kind={kind}
                    id={id}
                    view={data.view}
                    canEdit={data.canEdit}
                    notice={notice}
                    onChanged={changed}
                />
            )}
        </section>
    );
}

function PanelBody({
    kind,
    id,
    view,
    canEdit,
    notice,
    onChanged
}: {
    kind: Kind;
    id: string;
    view: PrivateNetworkView;
    canEdit: boolean;
    notice: string | null;
    onChanged: (message: string | null) => Promise<void>;
}) {
    const t = useTranslations("deployPrivateNet");
    const format = useDisplayFormat();
    const [editing, setEditing] = useState(false);
    const enabled = view.status !== "unsupported";
    // Its names answer, or will once it runs: not while another service keeps
    // its name, nor for a service that keeps its releases side by side.
    const answers = enabled && view.status !== "taken" && view.status !== "kept";
    const settingsHref = `/apps/deploy/${view.projectId}/settings/environments`;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
                {editing ? (
                    <RenameForm
                        kind={kind}
                        id={id}
                        current={view.name}
                        onCancel={() => setEditing(false)}
                        onDone={async (message) => {
                            setEditing(false);
                            await onChanged(message);
                        }}
                    />
                ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-sm" title={view.domain}>
                                {view.domain}
                            </span>
                            <CopyButton value={view.domain} label={t("copyLabel")} />
                        </div>
                        <div className="flex items-center gap-2">
                            {view.family && <Badge variant="neutral">{t(`family.${view.family}`)}</Badge>}
                            {canEdit && enabled && (
                                <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                                    <Pencil /> {t("edit")}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
                <p className={`flex items-center gap-1.5 text-xs font-medium ${STATUS_TONE[view.status]}`}>
                    <StatusIcon status={view.status} /> {t(`status.${view.status}`)}
                </p>
                {view.status === "unsupported" && (
                    <p className="text-xs text-muted-foreground">
                        {t.rich("statusHint.unsupported", {
                            link: (chunks) => (
                                <Link href="/admin/settings" className="text-primary hover:underline">
                                    {chunks}
                                </Link>
                            )
                        })}
                    </p>
                )}
                {(view.status === "pending" || view.status === "offline" || view.status === "kept") && (
                    <p className="text-xs text-muted-foreground">{t(`statusHint.${view.status}`)}</p>
                )}
                {view.status === "taken" && (
                    <p className="text-xs text-muted-foreground">
                        {t("statusHint.taken", { service: view.takenBy ?? "" })}
                    </p>
                )}
                {answers && (
                    <p className="text-xs text-muted-foreground">{t.rich("shortName", { name: view.name, code })}</p>
                )}
                {answers && view.port !== null && (
                    <p className="text-xs text-muted-foreground">
                        {view.portless && view.port !== 80
                            ? t.rich("portless", { url: `http://${view.domain}`, port: view.port, code })
                            : t.rich("port", { port: view.port, address: `${view.domain}:${view.port}`, code })}
                    </p>
                )}
                {view.former.map((entry) => (
                    <p key={entry.name} className="text-xs text-muted-foreground">
                        {t.rich("former", { name: entry.name, date: format.date(entry.until), code })}
                    </p>
                ))}
            </div>
            {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

            {enabled && <AliasEditor kind={kind} id={id} view={view} canEdit={canEdit} onChanged={onChanged} />}

            <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-medium">{t("reach")}</h4>
                {view.linksMode && <p className="text-xs text-muted-foreground">{t("reachLinks")}</p>}
                {view.reach.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("reachNone")}</p>
                ) : (
                    <ul className="flex flex-wrap gap-1.5">
                        {view.reach.map((peer) => (
                            <li key={peer.id}>
                                <Badge variant="neutral" className="max-w-56 truncate" title={peer.name}>
                                    {peer.name}
                                </Badge>
                            </li>
                        ))}
                    </ul>
                )}
                {unreachableByServer(view).map(([server, services]) => (
                    <div key={server} className="flex flex-col gap-0.5">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-warning-ink">
                            <CircleAlert className="size-3.5 shrink-0" /> {t("unreachable", { server })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("unreachableHint", { services: services.join(", ") })}
                        </p>
                    </div>
                ))}
                {view.sharedEnvironment && (
                    <p className="text-xs text-warning-ink">
                        {t.rich("sharedEnvironment", {
                            link: (chunks) => (
                                <Link href={settingsHref} className="text-primary hover:underline">
                                    {chunks}
                                </Link>
                            )
                        })}
                    </p>
                )}
            </div>

            {enabled && <CrossProjectLinks kind={kind} id={id} view={view} canEdit={canEdit} onChanged={onChanged} />}
        </div>
    );
}

/** The services that cannot call it, grouped by the server they are on. */
function unreachableByServer(view: PrivateNetworkView): [string, string[]][] {
    const groups = new Map<string, string[]>();
    for (const peer of view.unreachable) groups.set(peer.serverName, [...(groups.get(peer.serverName) ?? []), peer.name]);
    return [...groups];
}

function RenameForm({
    kind,
    id,
    current,
    onCancel,
    onDone
}: {
    kind: Kind;
    id: string;
    current: string;
    onCancel: () => void;
    onDone: (message: string | null) => Promise<void>;
}) {
    const t = useTranslations("deployPrivateNet");
    const [value, setValue] = useState(current);
    const [check, setCheck] = useState<{ name: string; available: boolean; message?: string } | null>(null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const asked = useRef(0);

    const name = normalizePrivateName(value);
    const problem = privateNameProblem(name);
    const unchanged = name === current;

    // The same rules as the server, as it is typed; the server only for whether
    // another service already answers to it.
    useEffect(() => {
        if (problem || unchanged) {
            setCheck(null);
            setChecking(false);
            return;
        }
        const ticket = ++asked.current;
        setChecking(true);
        const timer = setTimeout(() => {
            void checkPrivateNameAction(kind, id, name).then((result) => {
                if (ticket !== asked.current) return;
                setChecking(false);
                setCheck({ name, available: Boolean(result.available), message: result.message });
            });
        }, 300);
        return () => clearTimeout(timer);
    }, [id, kind, name, problem, unchanged]);

    const available = !problem && !unchanged && check?.name === name && check.available;
    // An emptied field is unfinished, not wrong: no sentence until there is a name.
    const message =
        problem && problem !== "empty"
            ? t(PROBLEM_KEYS[problem])
            : check?.name === name && !check.available
              ? check.message
              : null;

    function submit() {
        if (!available) return;
        setError(null);
        start(async () => {
            const result = await renamePrivateNameAction(kind, id, name);
            if (result.error) {
                setError(result.error);
                return;
            }
            await onDone(t(APPLIED_RENAME[result.applied ?? "first"]));
        });
    }

    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>
                    {t("editLabel")} <span aria-hidden="true">*</span>
                </span>
                <div className="flex min-w-0 items-center rounded-md border border-border focus-within:border-border-strong">
                    <Input
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        maxLength={63}
                        autoFocus
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-invalid={Boolean(message)}
                        className="min-w-0 flex-1 border-0 font-mono focus-visible:ring-0"
                    />
                    <span className="shrink-0 pr-2 font-mono text-sm text-muted-foreground">.polaris.internal</span>
                </div>
            </label>
            <p className="min-h-4 text-xs" aria-live="polite">
                {message ? (
                    <span className="text-danger-ink">{message}</span>
                ) : available ? (
                    <span className="inline-flex items-center gap-1 text-success-ink">
                        <CheckCircle2 className="size-3.5" /> {t("available")}
                    </span>
                ) : checking ? (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> {t("checking")}
                    </span>
                ) : null}
            </p>
            <p className="text-xs text-muted-foreground">{t("renameHint", { days: FORMER_NAME_GRACE_DAYS })}</p>
            {error && <p className="text-xs text-danger-ink">{error}</p>}
            <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
                    {t("cancel")}
                </Button>
                <Button type="submit" size="sm" aria-disabled={!available || pending} disabled={pending}>
                    {pending && <Loader2 className="animate-spin" />} {t("update")}
                </Button>
            </div>
        </form>
    );
}

function AliasEditor({
    kind,
    id,
    view,
    canEdit,
    onChanged
}: {
    kind: Kind;
    id: string;
    view: PrivateNetworkView;
    canEdit: boolean;
    onChanged: (message: string | null) => Promise<void>;
}) {
    const t = useTranslations("deployPrivateNet");
    const [aliases, setAliases] = useState(view.aliases);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();

    useEffect(() => setAliases(view.aliases), [view.aliases]);

    const name = normalizePrivateName(draft);
    const problem = privateNameProblem(name);
    const duplicate = name === view.name || aliases.includes(name);
    const draftMessage = problem && problem !== "empty" ? t(PROBLEM_KEYS[problem]) : null;

    function save(next: string[]) {
        const previous = aliases;
        // Shown at once, put back if the server refuses.
        setAliases(next);
        setError(null);
        start(async () => {
            const result = await setPrivateAliasesAction(kind, id, next);
            if (result.error) {
                setAliases(previous);
                setError(result.error);
                return;
            }
            setDraft("");
            await onChanged(t(APPLIED_SAVE[result.applied ?? "first"]));
        });
    }

    if (!canEdit && aliases.length === 0) return null;
    return (
        <div className="flex flex-col gap-1.5">
            <h4 className="text-xs font-medium">{t("aliases")}</h4>
            <p className="text-xs text-muted-foreground">{t("aliasesHint")}</p>
            {aliases.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                    {aliases.map((alias) => (
                        <li key={alias}>
                            <Badge variant="neutral" className="gap-1 font-mono">
                                {alias}
                                {canEdit && (
                                    <button
                                        type="button"
                                        className="rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
                                        aria-label={t("removeAlias", { name: alias })}
                                        title={t("removeAlias", { name: alias })}
                                        disabled={pending}
                                        onClick={() => save(aliases.filter((one) => one !== alias))}
                                    >
                                        <X className="size-3" />
                                    </button>
                                )}
                            </Badge>
                        </li>
                    ))}
                </ul>
            )}
            {canEdit && (
                <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!problem && !duplicate) save([...aliases, name]);
                    }}
                >
                    <Input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={t("aliasPlaceholder")}
                        maxLength={63}
                        spellCheck={false}
                        autoCapitalize="none"
                        aria-label={t("aliases")}
                        aria-invalid={Boolean(draftMessage)}
                        className="h-7 w-48 font-mono"
                    />
                    <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        aria-disabled={Boolean(problem) || duplicate || pending}
                        disabled={pending}
                    >
                        {pending ? <Loader2 className="animate-spin" /> : <Plus />} {t("addAlias")}
                    </Button>
                </form>
            )}
            {draftMessage && <p className="text-xs text-danger-ink">{draftMessage}</p>}
            {error && <p className="text-xs text-danger-ink">{error}</p>}
        </div>
    );
}

function CrossProjectLinks({
    kind,
    id,
    view,
    canEdit,
    onChanged
}: {
    kind: Kind;
    id: string;
    view: PrivateNetworkView;
    canEdit: boolean;
    onChanged: (message: string | null) => Promise<void>;
}) {
    const t = useTranslations("deployPrivateNet");
    const [choosing, setChoosing] = useState(false);
    const [candidates, setCandidates] = useState<{ value: string; label: string }[] | null>(null);
    const [picked, setPicked] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();

    function open() {
        setChoosing(true);
        setError(null);
        start(async () => {
            const result = await crossLinkCandidatesAction(kind, id);
            if (result.error) {
                setError(result.error);
                return;
            }
            setCandidates(
                (result.candidates ?? []).map((one) => ({
                    value: one.id,
                    label: t("allowOption", {
                        service: one.name,
                        project: one.projectName,
                        environment: one.environmentName
                    })
                }))
            );
        });
    }

    function allow() {
        if (!picked) return;
        start(async () => {
            const result = await addCrossLinkAction(kind, id, picked);
            if (result.error) {
                setError(result.error);
                return;
            }
            setChoosing(false);
            setPicked("");
            setCandidates(null);
            await onChanged(null);
        });
    }

    function remove(linkId: string) {
        setError(null);
        start(async () => {
            const result = await removeCrossLinkAction(kind, id, linkId);
            if (result.error) {
                setError(result.error);
                return;
            }
            await onChanged(null);
        });
    }

    if (!canEdit && view.crossLinks.length === 0) return null;
    return (
        <div className="flex flex-col gap-1.5">
            <h4 className="text-xs font-medium">{t("projects")}</h4>
            <p className="text-xs text-muted-foreground">{t("projectsHint")}</p>
            {view.crossLinks.length > 0 && (
                <ul className="flex flex-col gap-1">
                    {view.crossLinks.map((link) => (
                        <li key={link.id} className="flex items-start justify-between gap-2 text-xs">
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-muted-foreground">
                                    {t.rich(link.direction === "in" ? "linkIn" : "linkOut", {
                                        service: link.serviceName,
                                        project: link.projectName,
                                        domain: link.domain,
                                        code
                                    })}
                                </span>
                                {!link.sameServer && <span className="text-warning-ink">{t("linkOtherServer")}</span>}
                            </div>
                            {canEdit && (
                                <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={t("removeLink", { service: link.serviceName })}
                                    title={t("removeLink", { service: link.serviceName })}
                                    disabled={pending}
                                    onClick={() => remove(link.id)}
                                >
                                    <X />
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {canEdit && !choosing && (
                <Button size="sm" variant="outline" className="w-fit" onClick={open}>
                    <Plus /> {t("allow")}
                </Button>
            )}
            {canEdit && choosing && (
                <div className="flex flex-wrap items-center gap-2">
                    {candidates === null ? (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : candidates.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("allowNone")}</p>
                    ) : (
                        <>
                            <Select
                                value={picked}
                                onValueChange={setPicked}
                                options={candidates}
                                placeholder={t("allowPick")}
                                aria-label={t("allowPick")}
                                className="w-full sm:w-72"
                            />
                            <Button size="sm" onClick={allow} aria-disabled={!picked || pending} disabled={pending}>
                                {pending && <Loader2 className="animate-spin" />} {t("allowConfirm")}
                            </Button>
                        </>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setChoosing(false)} disabled={pending}>
                        {t("cancel")}
                    </Button>
                </div>
            )}
            {error && <p className="text-xs text-danger-ink">{error}</p>}
        </div>
    );
}
