"use client";

/**
 * "Import site": a cPanel full-account backup, sent to the server and turned
 * into a project with its sites, databases and domains. The upload shows its
 * progress; the import after it runs on the server and is waited on here.
 */

import { z } from "zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { useRef, useState, type DragEvent } from "react";
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

/** What the server answers once the import is done. */
const resultSchema = z.object({
    projectId: z.string(),
    services: z.number(),
    databases: z.number(),
    domains: z.array(z.string()),
    warnings: z.array(z.string())
});
type ImportResult = z.infer<typeof resultSchema>;

type Phase =
    | { kind: "idle" }
    | { kind: "uploading"; percent: number }
    | { kind: "importing" }
    | { kind: "done"; result: ImportResult }
    | { kind: "failed"; message: string };

/** Send the backup, reporting upload progress, and answer the server's verdict. */
function sendBackup(file: File, onProgress: (percent: number) => void): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/deploy/import/cpanel");
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
    const busy = phase.kind === "uploading" || phase.kind === "importing";

    function reset() {
        setFile(null);
        setPickError(null);
        setPhase({ kind: "idle" });
    }

    function pick(next: File | undefined) {
        if (!next || busy) return;
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
        const { status, body } = await sendBackup(file, (percent) =>
            setPhase(percent >= 100 ? { kind: "importing" } : { kind: "uploading", percent })
        );
        if (status === 0) {
            setPhase({ kind: "failed", message: t("importSite.unreachable") });
            return;
        }
        const result = resultSchema.safeParse(body);
        if (status >= 200 && status < 300 && result.success) {
            setPhase({ kind: "done", result: result.data });
            router.refresh();
            return;
        }
        const error = z.object({ error: z.string().min(1) }).safeParse(body);
        setPhase({ kind: "failed", message: error.success ? error.data.error : t("importSite.failed") });
    }

    return (
        <>
            <Button variant="outline" onClick={() => setOpen(true)}>
                <Upload className="size-4" />
                {t("importSite.open")}
            </Button>
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    // An import under way is not abandoned by a stray click outside.
                    if (busy) return;
                    setOpen(next);
                    if (!next) reset();
                }}
            >
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t("importSite.title")}</DialogTitle>
                        <DialogDescription>{t("importSite.description")}</DialogDescription>
                    </DialogHeader>

                    {phase.kind === "done" ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <p>
                                {t("importSite.done", {
                                    services: phase.result.services,
                                    databases: phase.result.databases,
                                    domains: phase.result.domains.length
                                })}
                            </p>
                            {phase.result.warnings.length > 0 && (
                                <div className="rounded-lg border border-warning-edge bg-warning-soft px-3 py-2 text-warning-ink">
                                    <p className="font-medium">{t("importSite.warnings")}</p>
                                    <ul className="mt-1 list-disc pl-5">
                                        {phase.result.warnings.map((warning) => (
                                            <li key={warning} className="break-words">
                                                {warning}
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
                                    <Link href={`/apps/deploy/${phase.result.projectId}`}>{t("importSite.openProject")}</Link>
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
                            {phase.kind === "importing" && (
                                <p className="flex items-center gap-2 text-muted-foreground">
                                    <Loader2 className="size-4 shrink-0 animate-spin" />
                                    {t("importSite.importing")}
                                </p>
                            )}
                            {phase.kind === "failed" && (
                                <p className="rounded-lg border border-danger-edge bg-danger-soft px-3 py-2 break-words text-danger-ink">
                                    {phase.message}
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
                                    {phase.kind === "failed" ? t("importSite.retry") : t("importSite.start")}
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
