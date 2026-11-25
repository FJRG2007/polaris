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
import * as schemas from "../model/schemas";
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
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Switch,
    Checkbox
} from "@polaris/ui";

function useSecurityT(): SecurityTranslator {
    return securityCatalogs.translator(
        hostUi.i18nProvider.useLocale(),
        "security",
        hostUi.i18nProvider.useClient()
    );
}

type Servers = Extract<
    Awaited<ReturnType<typeof actions.serversAction>>,
    { ok: true }
>["data"]["items"];
type Server = Servers[number];

const { PagedPicker } = hostUi.pagedPicker;
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
    host: ["audit", "packages"],
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

/** A server as the picker names it: the one Polaris runs on says so. */
function serverLabel(server: Server, t: SecurityTranslator): string {
    return server.local ? `${server.name} (${t("thisServer")})` : server.name;
}

export function SecurityView({ landing = NO_LANDING }: { landing?: Landing }) {
    const t = useSecurityT();
    const [servers, setServers] = useState<Servers | null>(() => cacheRead("security:servers"));
    const [serversFailed, setServersFailed] = useState(false);
    const [serverId, setServerId] = useState<string | null>(landing.target);
    // A link names a vulnerability scan: those are on the images tab.
    const [tab, setTab] = useState<Tab>(landing.scan || landing.target ? "images" : "malware");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [focusOpen, setFocusOpen] = useState(true);

    const error = useCallback(
        (code: string) => setNotice(t(`errors.${code}` as never) || t("errors.failed")),
        [t]
    );

    // Never the whole list: the server chosen (or linked), read back by id, and
    // the first one, for when nothing is chosen or the chosen one is gone. The
    // picker reads the rest a page at a time.
    const loadServers = useCallback(async () => {
        const [chosen, first] = await Promise.all([
            serverId ? actions.serversAction({ ids: [serverId] }) : null,
            actions.serversAction({ limit: 1 })
        ]);
        if (!first.ok || (chosen && !chosen.ok)) return setServersFailed(true);
        setServersFailed(false);
        const known = [...(chosen?.ok ? chosen.data.items : []), ...first.data.items];
        const unique = known.filter((s, index) => known.findIndex((o) => o.id === s.id) === index);
        setServers(unique);
        cacheWrite("security:servers", unique);
        // A dependency would read again on every pick; the pick hands its row over.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        void loadServers();
    }, [loadServers]);
    const choose = useCallback((id: string, row: Server | null) => {
        setServerId(id);
        if (row) setServers((known) => [row, ...(known ?? []).filter((s) => s.id !== row.id)]);
    }, []);

    const current = pickServer(servers, serverId);
    // A linked or chosen server that is no longer listed: say so, once.
    const gone = serverId !== null && servers !== null && !servers.some((s) => s.id === serverId);
    useEffect(() => {
        if (gone) setNotice(t("focus.serverGone"));
    }, [gone, t]);

    // The server's overview goes through the shared live read: two tabs on one
    // server ask once between them while a scan runs, and a revisit paints the
    // last overview it showed (the read keeps that copy itself now). Another
    // server is another key, so its overview never paints under this one's.
    const readOverview = useCallback(async (): Promise<Overview> => {
        const result = await actions.overviewAction({ targetId: current! });
        if (!result.ok) throw new Error("failed");
        return result.data;
    }, [current]);
    const live = hostUi.liveRead.useLiveRead<Overview>({
        load: readOverview,
        cacheKey: `security-overview:${current ?? ""}`,
        intervalMs: 5000,
        enabled: current !== null,
        // While something is queued or running, look again every few seconds.
        paused: !busy
    });
    // A kept copy whose first read failed is a failed first read: the screen
    // renders what it rendered before there was a kept copy at all.
    const overview = current && !live.firstFailed ? live.data : null;
    const failed = live.error !== null || live.stale !== null;
    const load = live.refresh;

    const scanning =
        overview?.scans.some((scan) => scan.state === "queued" || scan.state === "running") ??
        false;
    useEffect(() => {
        setBusy(scanning);
    }, [scanning]);

    const submit = useCallback(
        async (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => {
            setNotice(null);
            const result = await work();
            if (!result.ok) return error(result.error ?? "failed");
            if (done) setNotice(done);
            load();
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
                        <span className="min-w-0 max-w-full shrink-0 truncate" title={t("server")}>{t("server")}</span>
                        <PagedPicker<Server>
                            className="h-8 min-w-0 max-w-[16rem]"
                            read={actions.serverOptionsAction}
                            scope={{}}
                            cache="security:server-options"
                            value={current}
                            onValueChange={choose}
                            selectedLabel={server ? serverLabel(server, t) : undefined}
                            itemLabel={(s) => serverLabel(s, t)}
                            aria-label={t("server")}
                            placeholder={t("server")}
                            searchPlaceholder={t("serverSearch")}
                            emptyText={t("serverEmpty")}
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
                                    <Checkbox
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

interface Waiting {
    readonly pending: number | null;
    readonly securityPending: number | null;
    readonly reboot: "none" | "required" | "scheduled";
    readonly rebootAt: string | null;
}

function waitingOf(server: Server | null): Waiting {
    return {
        pending: server?.pending ?? null,
        securityPending: server?.securityPending ?? null,
        reboot: server?.reboot ?? "none",
        rebootAt: server?.rebootAt ?? null
    };
}

/** A fresh read, keeping what it did not say (an older daemon's script). */
function waitingFrom(
    report: {
        pending: number | null;
        securityPending: number | null;
        reboot: Waiting["reboot"] | null;
        rebootAt: Date | string | null;
    },
    last: Waiting
): Waiting {
    if (report.reboot === null) return last;
    return {
        pending: report.pending,
        securityPending: report.securityPending,
        reboot: report.reboot,
        rebootAt: report.rebootAt ? new Date(report.rebootAt).toISOString() : null
    };
}

const NO_HELD: readonly string[] = [];

/** The packages a server keeps on their version, each with Release, and the
 *  dialog that holds one or moves it to another version the server offers. */
function HeldPackages({
    t,
    targetId,
    held,
    submit
}: {
    t: SecurityTranslator;
    targetId: string;
    held: readonly string[];
    submit: Submit;
}) {
    const [shown, setShown] = useState(held);
    const [open, setOpen] = useState(false);
    useEffect(() => setShown(held), [held]);
    const release = async (name: string) => {
        const previous = shown;
        setShown((list) => list.filter((n) => n !== name));
        await submit(async () => {
            const result = await actions.holdPackageAction({ targetId, package: name, hold: false });
            if (!result.ok) setShown(previous);
            return result;
        }, t("held.done"));
    };
    return (
        <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                    <span className="block font-medium">{t("held.title")}</span>
                    <span className="text-muted-foreground">{t("held.hint")}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                    {t("held.manage")}
                </Button>
            </div>
            {shown.length === 0 ? (
                <p className="text-muted-foreground">{t("held.none")}</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {shown.map((name) => (
                        <li key={name} className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono" title={name}>
                                {name}
                            </span>
                            <Button size="xs" variant="ghost" onClick={() => void release(name)}>
                                {t("held.release")}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {open ? (
                <PackageDialog
                    t={t}
                    targetId={targetId}
                    onClose={() => setOpen(false)}
                    submit={submit}
                />
            ) : null}
        </div>
    );
}

type Versions = { installed: string | null; held: boolean; versions: readonly string[]; };

function PackageDialog({
    t,
    targetId,
    onClose,
    submit
}: {
    t: SecurityTranslator;
    targetId: string;
    onClose: () => void;
    submit: Submit;
}) {
    const [name, setName] = useState("");
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [found, setFound] = useState<{ name: string; versions: Versions; } | null>(null);
    const checked = schemas.packageName.safeParse(name);
    const invalid = touched && name.trim() !== "" && !checked.success;
    const lookUp = async () => {
        setTouched(true);
        if (!checked.success || busy) return;
        setBusy(true);
        setFailure(null);
        const result = await actions.packageVersionsAction({ targetId, package: checked.data });
        setBusy(false);
        if (!result.ok) {
            setFound(null);
            return setFailure(t(`errors.${result.error}` as never) || t("errors.failed"));
        }
        setFound({ name: checked.data, versions: result.data });
    };
    const change = async (work: () => Promise<{ ok: boolean; error?: string; }>, done: string) => {
        setBusy(true);
        await submit(async () => {
            const result = await work();
            if (result.ok) onClose();
            return result;
        }, done);
        setBusy(false);
    };
    const others = found
        ? found.versions.versions.filter((v) => v !== found.versions.installed)
        : [];
    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("held.dialogTitle")}</DialogTitle>
                    <DialogDescription>{t("held.dialogHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 text-sm">
                    <form
                        className="flex flex-col gap-1"
                        noValidate
                        onSubmit={(event) => {
                            event.preventDefault();
                            void lookUp();
                        }}
                    >
                        <label htmlFor={`${targetId}-package`} className="font-medium">
                            {t("held.name")} *
                        </label>
                        <div className="flex min-w-0 gap-2">
                            <Input
                                id={`${targetId}-package`}
                                className="min-w-0 flex-1 font-mono"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={t("held.namePlaceholder")}
                                value={name}
                                aria-invalid={invalid || undefined}
                                onChange={(event) => {
                                    setName(event.target.value);
                                    setFound(null);
                                }}
                                onBlur={() => setTouched(true)}
                            />
                            <Button type="submit" disabled={busy} aria-disabled={!checked.success}>
                                {t("held.lookUp")}
                            </Button>
                        </div>
                        {invalid ? <p className="text-danger">{t("held.nameInvalid")}</p> : null}
                    </form>
                    {failure ? <p className="text-danger">{failure}</p> : null}
                    {busy && !found ? <Skeleton className="h-16 w-full" /> : null}
                    {found ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="min-w-0 truncate font-mono" title={found.name}>
                                    {found.name}
                                </span>
                                <span className="text-muted-foreground">
                                    {t("held.installed", {
                                        version: found.versions.installed ?? "-"
                                    })}
                                </span>
                                {found.versions.held ? (
                                    <Badge variant="neutral">{t("held.isHeld")}</Badge>
                                ) : (
                                    <Button
                                        size="xs"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() =>
                                            void change(
                                                () =>
                                                    actions.holdPackageAction({
                                                        targetId,
                                                        package: found.name,
                                                        hold: true
                                                    }),
                                                t("held.done")
                                            )
                                        }
                                    >
                                        {t("held.hold")}
                                    </Button>
                                )}
                            </div>
                            <p className="font-medium">{t("held.versions")}</p>
                            {others.length === 0 ? (
                                <p className="text-muted-foreground">{t("held.noVersions")}</p>
                            ) : (
                                <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                                    {others.map((version) => (
                                        <li key={version} className="flex min-w-0 items-center gap-2">
                                            <span
                                                className="min-w-0 flex-1 truncate font-mono"
                                                title={version}
                                            >
                                                {version}
                                            </span>
                                            <Button
                                                size="xs"
                                                variant="ghost"
                                                disabled={busy}
                                                onClick={() =>
                                                    void change(
                                                        () =>
                                                            actions.rollbackPackageAction({
                                                                targetId,
                                                                package: found.name,
                                                                version
                                                            }),
                                                        t("held.moved", {
                                                            package: found.name,
                                                            version
                                                        })
                                                    )
                                                }
                                            >
                                                {t("held.use")}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t("held.close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
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
    const [waiting, setWaiting] = useState(() => waitingOf(server));
    const [offByHandAt, setOffByHandAt] = useState(server?.offByHandAt ?? null);
    useEffect(() => {
        setUpdates(server?.updates ?? "unknown");
        setEvery(server?.everyHours ?? 0);
        setWaiting(waitingOf(server));
        setOffByHandAt(server?.offByHandAt ?? null);
    }, [server]);
    const restart = async (schedule: boolean) => {
        setPending(true);
        await submit(async () => {
            const result = await actions.restartAction({ targetId, schedule });
            if (result.ok) setWaiting((last) => waitingFrom(result.data, last));
            return result;
        });
        setPending(false);
    };
    const switchUpdates = async (enabled: boolean) => {
        const previous = updates;
        setUpdates(enabled ? "on" : "off");
        setPending(true);
        await submit(async () => {
            const result = await actions.updatesAction({ targetId, enabled });
            if (!result.ok) setUpdates(previous);
            else {
                setUpdates(result.data.state ?? previous);
                setOffByHandAt(enabled ? null : new Date().toISOString());
            }
            return result;
        });
        setPending(false);
    };
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <p className="text-sm text-muted-foreground">{t("host.hint")}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            onClick={() =>
                                void submit(() => actions.auditAction({ targetId }), t("queued"))
                            }
                        >
                            {t("host.run")}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() =>
                                void submit(() => actions.packagesAction({ targetId }), t("queued"))
                            }
                        >
                            {t("packages.run")}
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
                                    if (result.ok)
                                        setWaiting((last) => waitingFrom(result.data, last));
                                    return result;
                                });
                                setPending(false);
                            }}
                        >
                            {t("host.check")}
                        </Button>
                        <Switch
                            checked={updates === "on"}
                            disabled={updates === "unsupported"}
                            onChange={(on) => void switchUpdates(on)}
                            aria-label={t("host.updates")}
                        />
                    </div>
                </div>
                {updates === "off" && offByHandAt ? (
                    <p className="text-sm text-muted-foreground">
                        {t("host.offByHand", { when: new Date(offByHandAt).toLocaleString() })}
                    </p>
                ) : null}
                {updates === "on" || waiting.pending !== null || waiting.reboot !== "none" ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 text-muted-foreground">
                            {waiting.pending === null
                                ? t("host.window")
                                : t("host.waiting", {
                                      count: waiting.pending,
                                      security: waiting.securityPending ?? 0
                                  })}
                            {waiting.reboot === "required" ? ` ${t("host.restartNeeded")}` : ""}
                            {waiting.reboot === "scheduled"
                                ? ` ${t("host.restartAt", {
                                      when: waiting.rebootAt
                                          ? new Date(waiting.rebootAt).toLocaleString()
                                          : "04:30"
                                  })}`
                                : ""}
                        </span>
                        {waiting.reboot === "required" ? (
                            <Button size="sm" disabled={pending} onClick={() => void restart(true)}>
                                {t("host.restart")}
                            </Button>
                        ) : waiting.reboot === "scheduled" ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => void restart(false)}
                            >
                                {t("host.restartCancel")}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
                {updates === "unsupported" ? null : (
                    <HeldPackages
                        t={t}
                        targetId={targetId}
                        held={server?.held ?? NO_HELD}
                        submit={submit}
                    />
                )}
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
    if (scan.kind === "packages") {
        const fix = typeof s.fix === "string" ? s.fix : null;
        return fix ? `${counts} ${t(`packages.fix.${fix}` as never)}` : counts;
    }
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
                                        : scan.kind === "packages"
                                          ? t("packages.label")
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
                                {scan.kind === "packages" &&
                                scan.state === "done" &&
                                Number((scan.summary as { serious?: number }).serious ?? 0) > 0 &&
                                (scan.summary as { fix?: string | null }).fix !== "done" ? (
                                    <Button
                                        size="xs"
                                        variant="outline"
                                        title={t("packages.applyHint")}
                                        onClick={() =>
                                            void submit(
                                                () => actions.fixPackagesAction({ scanId: scan.id }),
                                                t("packages.applied")
                                            )
                                        }
                                    >
                                        {t("packages.apply")}
                                    </Button>
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
                            {open === scan.id &&
                            (scan.kind === "image" ||
                                scan.kind === "deps" ||
                                scan.kind === "packages") ? (
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
                                                            className="ms-2 font-mono text-xs text-muted-foreground"
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
