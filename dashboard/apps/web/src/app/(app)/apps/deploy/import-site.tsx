"use client";

/**
 * "Import site": a cPanel full-account backup, sent to the server and turned
 * into a project with its sites, databases and domains. The upload shows its
 * progress; the import after it runs on the server in the background, and is
 * followed here by asking for its row. Closing the dialog, or the page, loses
 * nothing: the button picks up the last day's import when it mounts.
 */

import { z } from "zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { FileArchive, Loader2, Upload } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

/** The largest backup the server takes (`MAX_BACKUP_UPLOAD` in the route). */
const MAX_BACKUP = 5 * 1024 ** 3;

/** What a picked file has to be before it is sent. */
const backupFileSchema = z.object({
    name: z.string().regex(/\.(tar\.gz|tgz)$/i, "type"),
    size: z.number().int().positive("empty").max(MAX_BACKUP, "size")
});

/** What the import came to. */
const resultSchema = z.object({
    projectId: z.string(),
    services: z.number(),
    databases: z.number(),
    domains: z.array(z.string()),
    warnings: z.array(z.object({ code: z.string(), name: z.string().optional() }))
});

/** The warnings the dialog has words for (`IMPORT_WARNING_CODES` on the server);
 *  one it does not know, from a newer server, gets the general sentence. */
const WARNING_CODES = ["noDomains", "noHome", "databaseFailed", "folderMissing", "domainTaken", "notDeploying"] as const;

function warningKey(code: string): `importSite.warning.${(typeof WARNING_CODES)[number] | "unknown"}` {
    const known = WARNING_CODES.find((candidate) => candidate === code);
    return `importSite.warning.${known ?? "unknown"}`;
}

/** One import's row, as the server shows it. */
const importSchema = z.object({
    id: z.string(),
    status: z.enum(["running", "succeeded", "failed"]),
    step: z.enum(["unpacking", "databases", "sites", "finishing"]),
    done: z.number(),
    total: z.number(),
    projectId: z.string().nullable(),
    result: resultSchema.nullable(),
    error: z.string().nullable()
});
type ImportView = z.infer<typeof importSchema>;

type Phase =
    | { kind: "idle" }
    | { kind: "uploading"; percent: number }
    | { kind: "job"; job: ImportView }
    | { kind: "failed"; message: string };

const ENDPOINT = "/api/deploy/import/cpanel";
/** How often a running import is asked after. */
const POLL_MS = 3000;
/** Imports whose ending this viewer has already seen, so a finished one is not
 *  shown again on every visit. A convenience: without storage it shows again. */
const SEEN_KEY = "polaris.deploy.importSite.seen";

function seenImports(): string[] {
    try {
        const parsed = z.array(z.string()).safeParse(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

function markSeen(id: string) {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([id, ...seenImports().filter((other) => other !== id)].slice(0, 20)));
    } catch {
        // Not kept; it shows once more next time.
    }
}

async function fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
}

/** Send the backup, reporting upload progress, and answer the server's verdict. */
function sendBackup(file: File, onProgress: (percent: number) => void): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve) => {
        const request = new XMLHttpRequest();
        request.open("POST", ENDPOINT);
        request.setRequestHeader("content-type", "application/gzip");
        request.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
        };
        request.onload = () => {
            let body: unknown = null;
            try {
                body = JSON.parse(request.responseText);
            } catch {
                body = null;
            }
            resolve({ status: request.status, body });
        };
        request.onerror = () => resolve({ status: 0, body: null });
        request.send(file);
    });
}

export function ImportSiteButton() {
    const t = useTranslations("deploySafety");
    const router = useRouter();
    const input = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [pickError, setPickError] = useState<string | null>(null);
    const [over, setOver] = useState(false);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const [tick, setTick] = useState(0);
    const job = phase.kind === "job" ? phase.job : null;
    const running = job?.status === "running";
    const busy = phase.kind === "uploading" || running;

    // The last day's import, running or ended but not yet seen, is picked up again.
    useEffect(() => {
        let live = true;
        fetchJson(ENDPOINT)
            .then((body) => {
                const parsed = z.object({ imports: z.array(importSchema) }).safeParse(body);
                const latest = parsed.success ? parsed.data.imports[0] : undefined;
                if (!live || !latest) return;
                if (latest.status === "running" || !seenImports().includes(latest.id)) {
                    setPhase((current) => (current.kind === "idle" ? { kind: "job", job: latest } : current));
                }
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);

    // A running import is asked after until it ends.
    const jobId = job?.id;
    useEffect(() => {
        if (!jobId || !running) return;
        let live = true;
        const timer = setTimeout(() => {
            fetchJson(`${ENDPOINT}?id=${encodeURIComponent(jobId)}`)
                .then((body) => {
                    const parsed = importSchema.safeParse(body);
                    if (!live || !parsed.success) return;
                    setPhase({ kind: "job", job: parsed.data });
                    if (parsed.data.status === "succeeded") router.refresh();
                })
                // A missed answer is asked again on the next turn.
                .catch(() => undefined)
                .finally(() => live && setTick((count) => count + 1));
        }, POLL_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [jobId, running, tick, router]);

    const reset = useCallback(() => {
        setFile(null);
        setPickError(null);
        setPhase((current) => {
            if (current.kind === "job" && current.job.status !== "running") markSeen(current.job.id);
            // A running import stays followed after the dialog closes.
            return current.kind === "job" && current.job.status === "running" ? current : { kind: "idle" };
        });
    }, []);

    function pick(next: File | undefined) {
        if (!next || busy) return;
        if (job) markSeen(job.id);
        const parsed = backupFileSchema.safeParse({ name: next.name, size: next.size });
        if (!parsed.success) {
            const reason = parsed.error.issues[0]?.message;
            setFile(null);
            setPickError(
                reason === "size"
                    ? t("importSite.tooLarge")
                    : reason === "empty"
                      ? t("importSite.emptyFile")
                      : t("importSite.wrongType")
            );
            return;
        }
        setPickError(null);
        setPhase({ kind: "idle" });
        setFile(next);
    }

    function dropped(event: DragEvent<HTMLDivElement>) {
        event.preventDefault();
        setOver(false);
        pick(event.dataTransfer.files[0]);
    }

    async function start() {
        if (!file || busy) return;
        setPhase({ kind: "uploading", percent: 0 });
        const { status, body } = await sendBackup(file, (percent) => setPhase({ kind: "uploading", percent }));
        if (status === 0) {
            setPhase({ kind: "failed", message: t("importSite.unreachable") });
            return;
        }
        const started = z.object({ id: z.string() }).safeParse(body);
        if (status >= 200 && status < 300 && started.success) {
            const id = started.data.id;
            setFile(null);
            setPhase({
                kind: "job",
                job: { id, status: "running", step: "unpacking", done: 0, total: 0, projectId: null, result: null, error: null }
            });
            return;
        }
        const error = z.object({ error: z.string().min(1) }).safeParse(body);
        setPhase({ kind: "failed", message: error.success ? error.data.error : t("importSite.failed") });
    }

    return (
        <>
            <Button variant="outline" onClick={() => setOpen(true)}>
                {running ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {running
                    ? t("importSite.running")
                    : job?.status === "succeeded"
                      ? t("importSite.finished")
                      : job?.status === "failed"
                        ? t("importSite.stopped")
                        : t("importSite.open")}
            </Button>
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    // An upload under way is not abandoned by a stray click outside;
                    // an import on the server keeps going whatever happens here.
                    if (phase.kind === "uploading") return;
                    setOpen(next);
                    if (!next) reset();
                }}
            >
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t("importSite.title")}</DialogTitle>
                        <DialogDescription>{t("importSite.description")}</DialogDescription>
                    </DialogHeader>

                    {job?.status === "running" ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <p className="flex items-center gap-2 font-medium">
                                <Loader2 className="size-4 shrink-0 animate-spin" />
                                {t(`importSite.step.${job.step}`, { done: Math.min(job.done + 1, job.total), total: job.total })}
                            </p>
                            <p className="text-muted-foreground">{t("importSite.importing")}</p>
                            <div className="flex justify-end">
                                <Button variant="ghost" onClick={() => setOpen(false)}>
                                    {t("importSite.close")}
                                </Button>
                            </div>
                        </div>
                    ) : job?.status === "succeeded" && job.result ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <p>
                                {t("importSite.done", {
                                    services: job.result.services,
                                    databases: job.result.databases,
                                    domains: job.result.domains.length
                                })}
                            </p>
                            {job.result.warnings.length > 0 && (
                                <div className="rounded-lg border border-warning-edge bg-warning-soft px-3 py-2 text-warning-ink">
                                    <p className="font-medium">{t("importSite.warnings")}</p>
                                    <ul className="mt-1 list-disc pl-5">
                                        {job.result.warnings.map((warning, index) => (
                                            <li key={`${warning.code}-${warning.name ?? index}`} className="break-words">
                                                {t(warningKey(warning.code), {
                                                    name: warning.name ?? ""
                                                })}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <div className="flex justify-end gap-2">
                                <Button
                                    variant="ghost"
                                    onClick={() => {
                                        setOpen(false);
                                        reset();
                                    }}
                                >
                                    {t("importSite.close")}
                                </Button>
                                <Button asChild>
                                    <Link href={`/apps/deploy/${job.result.projectId}`} onClick={reset}>{t("importSite.openProject")}</Link>
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3 text-sm">
                            <div
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    if (!busy) setOver(true);
                                }}
                                onDragLeave={() => setOver(false)}
                                onDrop={dropped}
                                className={cn(
                                    "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-center",
                                    over && "border-primary bg-primary/5"
                                )}
                            >
                                <FileArchive className="size-5 text-muted-foreground" />
                                {file ? (
                                    <span className="w-full min-w-0 truncate font-medium" title={file.name}>
                                        {file.name}
                                        <span className="block text-xs font-normal text-muted-foreground">
                                            {formatBytes(file.size)}
                                        </span>
                                    </span>
                                ) : (
                                    <span className="text-muted-foreground">{t("importSite.drop")}</span>
                                )}
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
                                    {t("importSite.choose")}
                                </Button>
                                <input
                                    ref={input}
                                    type="file"
                                    accept=".tar.gz,.tgz,application/gzip"
                                    className="hidden"
                                    onChange={(event) => {
                                        pick(event.target.files?.[0]);
                                        event.target.value = "";
                                    }}
                                />
                            </div>

                            {pickError && <p className="text-danger-ink">{pickError}</p>}

                            {phase.kind === "uploading" && (
                                <div className="flex flex-col gap-1">
                                    <span className="text-muted-foreground">{t("importSite.uploading", { percent: phase.percent })}</span>
                                    <div
                                        role="progressbar"
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={phase.percent}
                                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                                    >
                                        <div className="h-full bg-primary transition-[width]" style={{ width: `${phase.percent}%` }} />
                                    </div>
                                </div>
                            )}
                            {(phase.kind === "failed" || job?.status === "failed") && (
                                <p className="rounded-lg border border-danger-edge bg-danger-soft px-3 py-2 break-words text-danger-ink">
                                    {phase.kind === "failed" ? phase.message : (job?.error ?? t("importSite.failed"))}
                                </p>
                            )}

                            <div className="flex justify-end gap-2">
                                <Button
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() => {
                                        setOpen(false);
                                        reset();
                                    }}
                                >
                                    {t("importSite.cancel")}
                                </Button>
                                <Button disabled={!file || busy} onClick={() => void start()}>
                                    {busy && <Loader2 className="size-4 animate-spin" />}
                                    {phase.kind === "failed" || job?.status === "failed" ? t("importSite.retry") : t("importSite.start")}
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
