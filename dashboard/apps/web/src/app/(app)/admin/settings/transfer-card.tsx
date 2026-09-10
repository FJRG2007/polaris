"use client";

/**
 * Moving this Polaris to another machine: export everything into one file sealed
 * with a passphrase, or - on a fresh install - read one in.
 *
 * Importing is shown what the file holds before anything is written, and asks for
 * the word "replace", because it replaces every account and setting here,
 * including the one doing it.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { usePasswordSafety } from "@/lib/use-password-safety";
import { useDisplayFormat } from "@/components/display-format";
import type { TransferSummary } from "@/lib/instance-transfer/transfer";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import { applyImportAction, exportInstanceAction, previewImportAction } from "./transfer-actions";

const MIN_PASSPHRASE = 12;

function passphraseProblem(value: string): string | null {
    if (!value) return null;
    return value.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters` : null;
}

export function TransferCard({ identity }: { identity: readonly string[] }) {
    const format = useDisplayFormat();
    const [exportPass, setExportPass] = useState("");
    const [exportConfirm, setExportConfirm] = useState("");
    const [exporting, setExporting] = useState(false);
    const [exported, setExported] = useState<{ id: string; summary: TransferSummary } | null>(null);

    const [file, setFile] = useState<File | null>(null);
    const [importPass, setImportPass] = useState("");
    const [uploadId, setUploadId] = useState<string | null>(null);
    const [busy, setBusy] = useState<"upload" | "preview" | "apply" | null>(null);
    const [preview, setPreview] = useState<{
        summary: TransferSummary;
        refused: string | null;
    } | null>(null);
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);

    // The file is only as safe as this passphrase once it leaves: one already in a
    // breach list, or made of this deployment's own name, is the first guess.
    const unsafe = usePasswordSafety(exportPass, ["polaris", ...identity]);
    const exportProblem =
        passphraseProblem(exportPass) ??
        unsafe ??
        (exportConfirm && exportConfirm !== exportPass ? "The two passphrases differ" : null);

    async function runExport() {
        setError(null);
        setExporting(true);
        const result = await exportInstanceAction(exportPass);
        setExporting(false);
        if (result.error !== undefined) {
            setError(result.error);
            return;
        }
        setExported(result);
        setExportPass("");
        setExportConfirm("");
        window.location.assign(`/api/admin/transfer/${result.id}/download`);
    }

    async function runPreview() {
        if (!file) return;
        setError(null);
        setPreview(null);
        let id = uploadId;
        if (!id) {
            setBusy("upload");
            const response = await fetch("/api/admin/transfer/upload", {
                method: "POST",
                headers: { "x-polaris-transfer": "1", "content-type": "application/octet-stream" },
                body: file
            }).catch(() => null);
            const answer = (await response?.json().catch(() => null)) as {
                id?: string;
                error?: string;
            } | null;
            if (!response?.ok || !answer?.id) {
                setBusy(null);
                setError(answer?.error ?? "The file could not be uploaded");
                return;
            }
            id = answer.id;
            setUploadId(id);
        }
        setBusy("preview");
        const result = await previewImportAction(id, importPass);
        setBusy(null);
        if (result.error !== undefined) setError(result.error);
        else setPreview(result);
    }

    async function runApply() {
        if (!uploadId) return;
        setError(null);
        setBusy("apply");
        const result = await applyImportAction(uploadId, importPass, confirm);
        setBusy(null);
        if (result.error !== undefined) {
            setError(result.error);
            return;
        }
        // Every account here was replaced, this one included.
        window.location.assign("/oauth/login");
    }

    const rows = preview?.summary.tables.reduce((sum, table) => sum + table.rows, 0) ?? 0;

    return (
        <Card className="mt-4">
            <CardHeader>
                <CardTitle>Move to another machine</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-5 text-sm">
                <section className="flex flex-col gap-2">
                    <p className="text-muted-foreground">
                        Everything this Polaris knows - accounts, services, settings and secrets -
                        in one file, sealed with a passphrase. Sessions and metrics stay behind.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {/* enigma:allow-identity-password - the refusal is usePasswordSafety above,
                            fed this account's name and address, and exportInstanceAction repeats it. */}
                        <Input
                            type="password"
                            value={exportPass}
                            onChange={(event) => setExportPass(event.target.value)}
                            placeholder="Passphrase"
                            autoComplete="new-password"
                            className="min-w-0 flex-1"
                        />
                        <Input
                            type="password"
                            value={exportConfirm}
                            onChange={(event) => setExportConfirm(event.target.value)}
                            placeholder="Passphrase again"
                            autoComplete="new-password"
                            className="min-w-0 flex-1"
                        />
                        <Button
                            onClick={() => void runExport()}
                            disabled={
                                exporting ||
                                !exportPass ||
                                exportConfirm !== exportPass ||
                                exportProblem !== null
                            }
                        >
                            {exporting && <Loader2 className="size-4 animate-spin" />} Export
                        </Button>
                    </div>
                    {exportProblem && <p className="text-xs text-danger">{exportProblem}</p>}
                    {exported && (
                        <p className="text-xs text-muted-foreground">
                            Exported{" "}
                            {exported.summary.tables.reduce((sum, table) => sum + table.rows, 0)}{" "}
                            rows.
                            {exported.summary.unreadableSecrets > 0 &&
                                ` ${exported.summary.unreadableSecrets} saved secrets could not be opened here and will need entering again.`}{" "}
                            Without the passphrase the file cannot be opened.
                        </p>
                    )}
                </section>

                <section className="flex flex-col gap-2 border-t border-border pt-4">
                    <p className="text-muted-foreground">
                        On a fresh install: read an export in. It replaces every account and setting
                        here, this one included.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <input
                            type="file"
                            accept=".polaris"
                            onChange={(event) => {
                                setFile(event.target.files?.[0] ?? null);
                                setUploadId(null);
                                setPreview(null);
                            }}
                            className="min-w-0 flex-1 text-xs"
                        />
                        <Input
                            type="password"
                            value={importPass}
                            onChange={(event) => {
                                setImportPass(event.target.value);
                                setPreview(null);
                            }}
                            placeholder="Its passphrase"
                            autoComplete="off"
                            className="min-w-0 flex-1"
                        />
                        <Button
                            variant="secondary"
                            onClick={() => void runPreview()}
                            disabled={busy !== null || !file || importPass.length < MIN_PASSPHRASE}
                        >
                            {(busy === "upload" || busy === "preview") && (
                                <Loader2 className="size-4 animate-spin" />
                            )}{" "}
                            {busy === "upload" ? "Uploading" : "Check file"}
                        </Button>
                    </div>
                    {preview && (
                        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
                            <p>
                                Exported {format.dateTime(preview.summary.exportedAt)}: {rows} rows
                                in {preview.summary.tables.length} tables,{" "}
                                {preview.summary.carriedSecrets} secrets.
                            </p>
                            {preview.summary.unreadableSecrets > 0 && (
                                <p className="text-warning">
                                    {preview.summary.unreadableSecrets} secrets could not be opened
                                    where it was exported and will need entering again.
                                </p>
                            )}
                            {preview.summary.unknownTables.length > 0 && (
                                <p className="text-warning">
                                    Skipped, this version does not have them:{" "}
                                    {preview.summary.unknownTables.join(", ")}.
                                </p>
                            )}
                            {preview.refused ? (
                                <p className="text-danger">{preview.refused}</p>
                            ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Input
                                        value={confirm}
                                        onChange={(event) => setConfirm(event.target.value)}
                                        placeholder='Type "replace"'
                                        className="max-w-48"
                                    />
                                    <Button
                                        variant="danger"
                                        onClick={() => void runApply()}
                                        disabled={busy !== null || confirm !== "replace"}
                                    >
                                        {busy === "apply" && (
                                            <Loader2 className="size-4 animate-spin" />
                                        )}{" "}
                                        Import
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </section>
                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}
