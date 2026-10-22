"use client";

/**
 * Security scans: pick a server, then its four kinds of scan. The frame (title,
 * server picker, tabs) draws at once; each region waiting on data gets its own
 * skeleton, and the last overview read is kept per server so coming back paints
 * it before the refresh lands. A link from an alert (`?target=&scan=&ids=`)
 * opens on that server's images with the scan it is about on top.
 */

import * as actions from "../actions/security";
import { hostUi } from "@polaris/app-host/client";
import { securityCatalogs } from "../../messages";
import { FindingsTable } from "./findings-table";
import { ImagesPanel } from "./images-panel";
import { FocusCard, verdictLine } from "./focus-card";
import * as subjects from "../model/subjects";
import { NO_LANDING, SECURITY_PATH, type Landing } from "../model/landing";
import type { SecurityTranslator } from "../lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bug, FileDiff, Package, ServerCog, ShieldCheck } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    EmptyState,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";

function useSecurityT(): SecurityTranslator {
    return securityCatalogs.translator(hostUi.i18nProvider.useLocale(), "security");
}

type Servers = Extract<Awaited<ReturnType<typeof actions.serversAction>>, { ok: true }>["data"];
type Overview = Extract<Awaited<ReturnType<typeof actions.overviewAction>>, { ok: true }>["data"];
type Scan = Overview["scans"][number];
type Finding = Extract<
    Awaited<ReturnType<typeof actions.findingsAction>>,
    { ok: true }
>["data"][number];
type Tab = "malware" | "files" | "host" | "images";

const TABS: readonly { id: Tab; icon: typeof Bug }[] = [
    { id: "malware", icon: Bug },
    { id: "files", icon: FileDiff },
    { id: "host", icon: ServerCog },
    { id: "images", icon: Package }
];
/** The scan kinds each tab's history lists. Dependency scans are of an app's
 *  software too, so they sit with the images rather than nowhere. */
const KINDS_OF: Record<Tab, readonly string[]> = {
    malware: ["malware"],
    files: ["files"],
    host: ["audit"],
    images: ["image", "deps"]
};
const SEVERITY_TONE: Record<string, string> = {
    critical: "text-danger",
    high: "text-danger",
    warning: "text-danger",
    found: "text-danger",
    medium: "text-warning",
    changed: "text-warning",
    removed: "text-warning"
};
const SCHEDULES = [0, 6, 12, 24, 168] as const;

function cacheRead<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}
function cacheWrite(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* storage is a convenience only */
    }
}

/**
 * The server the page shows: the one chosen (or linked) while it is still
 * listed - or before the list has arrived, so a link paints its server at
 * once - else the first. Pure.
 */
export function pickServer(
    servers: readonly { readonly id: string }[] | null,
    chosen: string | null
): string | null {
    if (chosen && (servers === null || servers.some((s) => s.id === chosen))) return chosen;
    return servers?.[0]?.id ?? null;
}

export function SecurityView({ landing = NO_LANDING }: { landing?: Landing }) {
    const t = useSecurityT();
    const [servers, setServers] = useState<Servers | null>(() => cacheRead("security:servers"));
    const [serversFailed, setServersFailed] = useState(false);
    const [serverId, setServerId] = useState<string | null>(landing.target);
    // A link names a vulnerability scan: those are on the images tab.
    const [tab, setTab] = useState<Tab>(landing.scan || landing.target ? "images" : "malware");
    const [overview, setOverview] = useState<Overview | null>(null);
    const [failed, setFailed] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [focusOpen, setFocusOpen] = useState(true);

    const error = useCallback(
        (code: string) => setNotice(t(`errors.${code}` as never) || t("errors.failed")),
        [t]
    );

    const loadServers = useCallback(async () => {
        const result = await actions.serversAction();
        if (!result.ok) return setServersFailed(true);
        setServersFailed(false);
        setServers(result.data);
        cacheWrite("security:servers", result.data);
    }, []);
    useEffect(() => {
        void loadServers();
    }, [loadServers]);

    const current = pickServer(servers, serverId);
    // A linked or chosen server that is no longer listed: say so, once.
    const gone = serverId !== null && servers !== null && !servers.some((s) => s.id === serverId);
    useEffect(() => {
        if (gone) setNotice(t("focus.serverGone"));
    }, [gone, t]);

    const load = useCallback(async () => {
        if (!current) return;
        const result = await actions.overviewAction({ targetId: current });
        if (!result.ok) return setFailed(true);
        setFailed(false);
        setOverview(result.data);
        cacheWrite(`security:overview:${current}`, result.data);
    }, [current]);

    useEffect(() => {
        if (!current) return;
        setOverview(cacheRead(`security:overview:${current}`));
        void load();
    }, [current, load]);

    // While something is queued or running, look again every few seconds.
    const busy = overview?.scans.some(
        (scan) => scan.state === "queued" || scan.state === "running"
    );
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [busy, load]);

    const submit = useCallback(
        async (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
            setNotice(null);
            const result = await work();
            if (!result.ok) return error(result.error ?? "failed");
            if (done) setNotice(done);
            await load();
        },
        [error, load]
    );

    const server = servers?.find((s) => s.id === current) ?? null;
    const scans = useMemo(
        () => (overview?.scans ?? []).filter((scan) => KINDS_OF[tab].includes(scan.kind)),
        [overview, tab]
    );

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="flex items-center gap-2 text-xl font-semibold">
                        <ShieldCheck className="size-5 shrink-0" aria-hidden /> {t("title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">{t("intro")}</p>
                </div>
                {servers && servers.length > 0 ? (
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="shrink-0">{t("server")}</span>
                        <Select
                            className="h-8 min-w-0 max-w-[16rem]"
                            value={current ?? ""}
                            onValueChange={setServerId}
                            aria-label={t("server")}
                            options={servers.map((s) => ({
                                value: s.id,
                                label: s.local ? `${s.name} (${t("thisServer")})` : s.name
                            }))}
                        />
                    </div>
                ) : null}
            </header>

            {focusOpen ? (
                <FocusCard
                    t={t}
                    landing={landing}
                    onTarget={(id) => setServerId((chosen) => chosen ?? id)}
                    onClose={() => {
                        setFocusOpen(false);
                        // The link has been read: a reload opens the plain page.
                        try {
                            if (window.location.search)
                                window.history.replaceState(null, "", SECURITY_PATH);
                        } catch {
                            /* the address bar is a convenience */
                        }
                    }}
                    submit={submit}
                />
            ) : null}

            <nav className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
                {TABS.map(({ id, icon: Icon }) => (
                    <button
                        key={id}
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => setTab(id)}
                        className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
                            tab === id
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground"
                        }`}
                    >
                        <Icon className="size-4" aria-hidden /> {t(`tabs.${id}`)}
                    </button>
                ))}
            </nav>

            {failed && overview ? (
                // With results already on screen, a failed refresh is said, not hidden.
                <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
                    {t("refreshFailed")}
                </p>
            ) : null}
            {notice ? (
                <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
                    {notice}
                </p>
            ) : null}

            {servers && servers.length === 0 ? (
                <EmptyState icon={<ShieldCheck />} title={t("noServers")} />
            ) : (serversFailed && !servers) || (failed && !overview) ? (
                // The retry reads whatever failed: the server list, or this server.
                <EmptyState
                    icon={<ShieldCheck />}
                    title={t("loadFailed")}
                    action={
                        <Button
                            onClick={() => {
                                if (!servers) void loadServers();
                                void load();
                            }}
                        >
                            {t("tryAgain")}
                        </Button>
                    }
                />
            ) : !overview || !current ? (
                <Skeleton className="h-48 w-full" />
            ) : (
                <>
                    {tab === "malware" ? (
                        <MalwarePanel
                            t={t}
                            overview={overview}
                            targetId={current}
                            submit={submit}
                        />
                    ) : tab === "files" ? (
                        <FilesPanel t={t} overview={overview} targetId={current} submit={submit} />
                    ) : tab === "host" ? (
                        <HostPanel t={t} targetId={current} server={server} submit={submit} />
                    ) : (
                        <ImagesPanel
                            t={t}
                            apps={overview.apps}
                            targetId={current}
                            submit={submit}
                        />
                    )}
                    <History t={t} scans={scans} submit={submit} />
                </>
            )}
        </div>
    );
}

type Submit = (
    work: () => Promise<{ ok: boolean; error?: string }>,
    done?: string
) => Promise<void>;

function MalwarePanel({
    t,
    overview,
    targetId,
    submit
}: {
    t: SecurityTranslator;
    overview: Overview;
    targetId: string;
    submit: Submit;
}) {
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [folder, setFolder] = useState("");
    const [removing, setRemoving] = useState<string | null>(null);
    const folderBad = folder.split("/").some((part) => part.trim() === "..");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("malware.hint")}</p>
                {overview.volumes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("malware.noVolumes")}</p>
                ) : (
                    <>
                        <fieldset className="flex flex-col gap-1">
                            <legend className="mb-1 text-sm font-medium">
                                {t("malware.pick")}
                            </legend>
                            {overview.volumes.map((volume) => (
                                <label
                                    key={volume.id}
                                    className="flex min-w-0 items-center gap-2 text-sm"
                                >
                                    <input
                                        type="checkbox"
                                        checked={chosen.has(volume.id)}
                                        onChange={(event) => {
                                            const next = new Set(chosen);
                                            if (event.target.checked) next.add(volume.id);
                                            else next.delete(volume.id);
                                            setChosen(next);
                                        }}
                                    />
                                    <span className="truncate" title={volume.label}>
                                        {volume.label}
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("malware.folder")}
                            <input
                                className="h-8 rounded-md border border-border bg-background px-2"
                                value={folder}
                                maxLength={512}
                                aria-invalid={folderBad}
                                onChange={(event) => setFolder(event.target.value)}
                            />
                            {folderBad ? (
                                <span className="text-danger">{t("errors.invalid")}</span>
                            ) : null}
                        </label>
                        <div>
                            <Button
                                disabled={chosen.size === 0 || folderBad}
                                onClick={() =>
                                    void submit(
                                        () =>
                                            actions.scanMalwareAction({
                                                targetId,
                                                volumes: [...chosen].map((volumeId) => ({
                                                    volumeId,
                                                    subpath: folder
                                                }))
                                            }),
                                        t("queued")
                                    )
                                }
                            >
                                {t("malware.run")}
                            </Button>
                        </div>
                    </>
                )}
                <h2 className="mt-2 text-sm font-medium">{t("malware.quarantined")}</h2>
                {overview.quarantine.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("malware.noneHeld")}</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {overview.quarantine.map((item) => (
                            <li key={item.id} className="flex min-w-0 items-center gap-2 text-sm">
                                <span className="min-w-0 flex-1 truncate" title={item.path}>
                                    {item.path}{" "}
                                    <span className="text-muted-foreground">
                                        ({item.signature})
                                    </span>
                                </span>
                                <Button
                                    size="xs"
                                    variant="outline"
                                    onClick={() =>
                                        void submit(() =>
                                            actions.settleQuarantineAction({
                                                quarantineId: item.id,
                                                op: "restore"
                                            })
                                        )
                                    }
                                >
                                    {t("malware.restore")}
                                </Button>
                                <Button
                                    size="xs"
                                    variant="danger"
                                    onClick={() => setRemoving(item.id)}
                                >
                                    {t("malware.delete")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <ConfirmDeleteDialog
                    open={removing !== null}
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={overview.quarantine.find((q) => q.id === removing)?.path ?? ""}
                    kind={t("malware.quarantined")}
                    question={t("malware.deleteConfirm")}
                    onConfirm={() => {
                        const id = removing;
                        setRemoving(null);
                        if (id)
                            void submit(() =>
                                actions.settleQuarantineAction({ quarantineId: id, op: "delete" })
                            );
                    }}
                />
            </CardBody>
        </Card>
    );
}

function FilesPanel({
    t,
    overview,
    targetId,
    submit
}: {
    t: SecurityTranslator;
    overview: Overview;
    targetId: string;
    submit: Submit;
}) {
    const [volumeId, setVolumeId] = useState(overview.volumes[0]?.id ?? "");
    const [folder, setFolder] = useState("");
    const run = (mode: "baseline" | "check", vId = volumeId, subpath = folder) =>
        void submit(
            () => actions.scanFilesAction({ targetId, volumeId: vId, subpath, mode }),
            t("queued")
        );
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("files.hint")}</p>
                {overview.volumes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("malware.noVolumes")}</p>
                ) : null}
                <div
                    className="flex flex-wrap items-end gap-2"
                    hidden={overview.volumes.length === 0}
                >
                    <Select
                        className="h-8 w-auto min-w-0 max-w-full"
                        value={volumeId}
                        onValueChange={setVolumeId}
                        aria-label={t("files.volume")}
                        options={overview.volumes.map((volume) => ({
                            value: volume.id,
                            label: volume.label
                        }))}
                    />
                    <input
                        className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm"
                        placeholder={t("malware.folder")}
                        aria-label={t("malware.folder")}
                        value={folder}
                        maxLength={512}
                        onChange={(event) => setFolder(event.target.value)}
                    />
                    <Button disabled={!volumeId} onClick={() => run("baseline")}>
                        {t("files.baseline")}
                    </Button>
                </div>
                <h2 className="text-sm font-medium">{t("files.baselines")}</h2>
                {overview.baselines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("files.noBaselines")}</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {overview.baselines.map((b) => (
                            <li key={b.id} className="flex min-w-0 items-center gap-2 text-sm">
                                <span className="min-w-0 flex-1 truncate" title={b.label}>
                                    {b.label}{" "}
                                    <span className="text-muted-foreground">
                                        {t("files.fileCount", { count: b.files })}
                                    </span>
                                </span>
                                <Button
                                    size="xs"
                                    variant="outline"
                                    onClick={() => run("check", b.volumeId, b.subpath)}
                                >
                                    {t("files.check")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}

function HostPanel({
    t,
    targetId,
    server,
    submit
}: {
    t: SecurityTranslator;
    targetId: string;
    server: Servers[number] | null;
    submit: Submit;
}) {
    const [updates, setUpdates] = useState(server?.updates ?? "unknown");
    const [every, setEvery] = useState(server?.everyHours ?? 0);
    const [pending, setPending] = useState(false);
    useEffect(() => {
        setUpdates(server?.updates ?? "unknown");
        setEvery(server?.everyHours ?? 0);
    }, [server]);
    const switchUpdates = async (enabled: boolean) => {
        const previous = updates;
        setUpdates(enabled ? "on" : "off");
        setPending(true);
        await submit(async () => {
            const result = await actions.updatesAction({ targetId, enabled });
            if (!result.ok) setUpdates(previous);
            else setUpdates(result.data.state ?? previous);
            return result;
        });
        setPending(false);
    };
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <p className="text-sm text-muted-foreground">{t("host.hint")}</p>
                    <div>
                        <Button
                            onClick={() =>
                                void submit(() => actions.auditAction({ targetId }), t("queued"))
                            }
                        >
                            {t("host.run")}
                        </Button>
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("host.updates")}</p>
                        <p className="text-sm text-muted-foreground">
                            {updates === "unsupported"
                                ? t("host.updatesUnsupported")
                                : updates === "unknown"
                                  ? t("host.updatesUnknown")
                                  : t("host.updatesHint")}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={async () => {
                                setPending(true);
                                await submit(async () => {
                                    const result = await actions.updatesStatusAction({ targetId });
                                    if (result.ok && result.data.state)
                                        setUpdates(result.data.state);
                                    return result;
                                });
                                setPending(false);
                            }}
                        >
                            {t("host.check")}
                        </Button>
                        <Switch
                            checked={updates === "on"}
                            disabled={pending || updates === "unsupported"}
                            onChange={(on) => void switchUpdates(on)}
                            aria-label={t("host.updates")}
                        />
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                        <span className="block font-medium">{t("host.schedule")}</span>
                        <span className="text-muted-foreground">{t("host.scheduleHint")}</span>
                    </span>
                    <Select
                        className="h-8 w-auto"
                        value={String(every)}
                        aria-label={t("host.schedule")}
                        options={SCHEDULES.map((hours) => ({
                            value: String(hours),
                            label: t(`host.every.${hours}` as never)
                        }))}
                        onValueChange={(value) => {
                            const next = Number(value);
                            if (next === every) return;
                            const previous = every;
                            setEvery(next);
                            void submit(async () => {
                                const result = await actions.scheduleAction({
                                    targetId,
                                    everyHours: next
                                });
                                if (!result.ok) setEvery(previous);
                                return result;
                            });
                        }}
                    />
                </div>
            </CardBody>
        </Card>
    );
}

function summaryLine(t: SecurityTranslator, scan: Scan): string {
    const s = scan.summary as Record<string, number | string | boolean | null>;
    if (scan.state === "failed")
        return scan.error ? t(`errors.${scan.error}` as never) : t("state.failed");
    if (scan.state !== "done") return "";
    if (scan.kind === "malware") return t("malware.found", { count: Number(s.found ?? 0) });
    if (scan.kind === "files") {
        return s.mode === "check"
            ? t("files.changes", {
                  added: Number(s.added),
                  removed: Number(s.removed),
                  changed: Number(s.changed)
              })
            : t("files.fileCount", { count: Number(s.files ?? 0) });
    }
    if (scan.kind === "audit") {
        return `${t("host.score")}: ${String(s.score)} / 100, ${t("host.warnings", { count: Number(s.warnings ?? 0) })}`;
    }
    const counts = verdictLine(t, subjects.verdictOf(scan.summary));
    const files = (scan.summary as { files?: unknown }).files;
    if (scan.kind === "deps" && Array.isArray(files) && files.length > 0) {
        return `${counts} ${t("deps.files", {
            files: files
                .filter((f) => typeof f === "string")
                .slice(0, 6)
                .join(", ")
        })}`;
    }
    return counts;
}

function History({ t, scans, submit }: { t: SecurityTranslator; scans: Scan[]; submit: Submit }) {
    const [open, setOpen] = useState<string | null>(null);
    const [findings, setFindings] = useState<Finding[] | null>(null);
    const [findingsFailed, setFindingsFailed] = useState(false);
    const read = async (scanId: string) => {
        setFindings(null);
        setFindingsFailed(false);
        const result = await actions.findingsAction({ scanId });
        if (!result.ok) return setFindingsFailed(true);
        setFindings(result.data);
    };
    const show = async (scanId: string) => {
        if (open === scanId) return setOpen(null);
        setOpen(scanId);
        await read(scanId);
    };
    return (
        <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{t("history")}</h2>
            {scans.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noScans")}</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {scans.map((scan) => (
                        <li key={scan.id} className="rounded-md border border-border p-2 text-sm">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                {scan.kind === "image" || scan.kind === "deps" ? (
                                    <Badge variant="neutral">
                                        {t(`focus.kind.${scan.subject}`)}
                                    </Badge>
                                ) : null}
                                <span
                                    className="min-w-0 flex-1 truncate font-medium"
                                    title={scan.label}
                                >
                                    {scan.kind === "audit"
                                        ? t("thisServer")
                                        : scan.kind === "deps"
                                          ? t("deps.label", { app: scan.label })
                                          : scan.label}
                                </span>
                                <span className="text-muted-foreground">
                                    {t(`state.${scan.state}` as never)}
                                </span>
                                <span className="text-muted-foreground">
                                    {new Date(scan.createdAt).toLocaleString()}
                                </span>
                                {scan.kind === "image" &&
                                (scan.summary as { sbom?: boolean }).sbom ? (
                                    <a
                                        className="text-primary underline"
                                        href={`/api/security/sbom/${scan.id}`}
                                    >
                                        {t("images.download")}
                                    </a>
                                ) : null}
                                {scan.state === "done" ? (
                                    <Button
                                        size="xs"
                                        variant="ghost"
                                        onClick={() => void show(scan.id)}
                                    >
                                        {open === scan.id ? t("hide") : t("details")}
                                    </Button>
                                ) : null}
                            </div>
                            <p className="text-muted-foreground">{summaryLine(t, scan)}</p>
                            {open === scan.id && (scan.kind === "image" || scan.kind === "deps") ? (
                                <div className="mt-2">
                                    <FindingsTable
                                        t={t}
                                        findings={findings}
                                        failed={findingsFailed}
                                        onRetry={() => void read(scan.id)}
                                    />
                                </div>
                            ) : open === scan.id ? (
                                findingsFailed ? (
                                    <p className="mt-2 text-danger">{t("findings.failed")}</p>
                                ) : findings === null ? (
                                    <Skeleton className="mt-2 h-16 w-full" />
                                ) : findings.length === 0 ? (
                                    <p className="mt-2">{t("noFindings")}</p>
                                ) : (
                                    <ul className="mt-2 flex max-h-96 flex-col gap-1 overflow-y-auto">
                                        {findings.map((f) => (
                                            <li
                                                key={f.id}
                                                className="flex min-w-0 flex-wrap items-center gap-2"
                                            >
                                                <span
                                                    className={`shrink-0 font-medium ${SEVERITY_TONE[f.severity] ?? ""}`}
                                                >
                                                    {severityLabel(t, f.severity)}
                                                </span>
                                                <span
                                                    className="min-w-0 flex-1 truncate"
                                                    title={`${f.title} ${f.location}`}
                                                >
                                                    {f.url ? (
                                                        <a
                                                            href={f.url}
                                                            target="_blank"
                                                            rel="noreferrer noopener"
                                                            className="underline"
                                                        >
                                                            {f.title}
                                                        </a>
                                                    ) : (
                                                        f.title
                                                    )}{" "}
                                                    <span className="text-muted-foreground">
                                                        {f.location}
                                                    </span>
                                                    {f.layer ? (
                                                        <span
                                                            className="ml-2 font-mono text-xs text-muted-foreground"
                                                            title={f.layer}
                                                        >
                                                            {t("images.layer", {
                                                                layer: f.layer.slice(7, 19)
                                                            })}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                {scan.kind === "image" ? (
                                                    <span className="shrink-0 text-muted-foreground">
                                                        {f.fixedIn
                                                            ? t("images.fixedIn", {
                                                                  version: f.fixedIn
                                                              })
                                                            : t("images.noFix")}
                                                    </span>
                                                ) : null}
                                                {scan.kind === "malware" && f.volumeId ? (
                                                    <Button
                                                        size="xs"
                                                        variant="danger"
                                                        onClick={() =>
                                                            void submit(() =>
                                                                actions.quarantineAction({
                                                                    findingId: f.id
                                                                })
                                                            )
                                                        }
                                                    >
                                                        {t("malware.quarantine")}
                                                    </Button>
                                                ) : null}
                                            </li>
                                        ))}
                                    </ul>
                                )
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function severityLabel(t: SecurityTranslator, severity: string): string {
    if (severity === "warning" || severity === "suggestion") return t(`host.${severity}`);
    if (severity === "added" || severity === "removed" || severity === "changed")
        return t(`files.${severity}`);
    if (severity === "found") return t("tabs.malware");
    return t(`images.severity.${severity}` as never);
}
