"use client";

/**
 * Exporting a bag, or every bag, and importing one back: a menu to copy or
 * download, and a dialog that reads a file, shows slot by slot what it would
 * change and writes only once that is confirmed.
 */

import * as actions from "./inventory-transfer-actions";
import { type GameText, useGameText } from "../game-text";
import * as transfer from "../../lib/minecraft/inventory-transfer";
import { slotLabelIn, type InventoryItem } from "../../lib/minecraft/inventory";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
    SegmentedControl,
    Select,
    Textarea
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { Download, FileUp, Loader2, Upload } from "lucide-react";
import { useMemo, useRef, useState, useTransition } from "react";

const { useConfirm } = hostUi.confirmDialog;
const { useDisplayFormat } = hostUi.displayFormat;

function stamp(): string {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function download(name: string, body: string, type: string): void {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function csvOf(t: GameText<"minecraft">, file: transfer.TransferFile): string {
    const header = (["player", "slot", "where", "item", "count", "details"] as const).map((key) =>
        t(`inventoryTransfer.csvHeader.${key}`)
    );
    return transfer.toCsv(file, header, (slot) => slotLabelIn(t, slot));
}

/**
 * Export: one player's bag, or every bag Polaris can read or has kept, copied as
 * JSON or downloaded as JSON or CSV.
 */
export function InventoryExportMenu({
    installedAppId,
    players,
    onMessage
}: {
    installedAppId: string;
    /** One player's name, or `all`. */
    players: string | "all";
    /** What happened, for the screen to show beside it: a note, or an error. */
    onMessage: (message: { note?: string; error?: string }) => void;
}) {
    const t = useGameText("minecraft");
    const [pending, startTransition] = useTransition();
    const all = players === "all";
    const base = all ? "inventories" : `inventory-${players}`;

    const run = (use: (file: transfer.TransferFile) => Promise<void> | void) =>
        startTransition(async () => {
            const result = await actions
                .exportInventoriesAction({ installedAppId, players: all ? "all" : [players] })
                .catch(() => ({ file: undefined, missing: undefined, error: undefined }));
            if (!result.file) {
                onMessage({ error: result.error ?? t("inventoryTransfer.couldNotExport") });
                return;
            }
            onMessage({
                note:
                    result.missing && result.missing.length > 0
                        ? t("inventoryTransfer.missing", { names: result.missing.join(", ") })
                        : undefined
            });
            await use(result.file);
        });

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={pending}>
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                        <Download className="size-4" aria-hidden />
                    )}
                    {all ? t("inventoryTransfer.exportAll") : t("inventoryTransfer.export")}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem
                    onSelect={() =>
                        run(async (file) => {
                            try {
                                await navigator.clipboard.writeText(transfer.toJson(file));
                                onMessage({ note: t("inventoryTransfer.copied") });
                            } catch {
                                onMessage({ error: t("inventoryTransfer.copyFailed") });
                            }
                        })
                    }
                >
                    {t("inventoryTransfer.copyJson")}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onSelect={() =>
                        run((file) =>
                            download(
                                `${base}-${stamp()}.json`,
                                transfer.toJson(file),
                                "application/json"
                            )
                        )
                    }
                >
                    {t("inventoryTransfer.downloadJson")}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onSelect={() =>
                        run((file) =>
                            download(
                                `${base}-${stamp()}.csv`,
                                csvOf(t, file),
                                "text/csv;charset=utf-8"
                            )
                        )
                    }
                >
                    {t("inventoryTransfer.downloadCsv")}
                </DropdownMenuItem>
                <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
                    {t("inventoryTransfer.csvHint")}
                </DropdownMenuLabel>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The button that opens the import dialog, for one player or for every player in a file. */
export function InventoryImportButton({
    installedAppId,
    into,
    onDone
}: {
    installedAppId: string;
    /** The player a single bag goes into; absent, every bag goes to its own player. */
    into?: string;
    onDone: () => void;
}) {
    const t = useGameText("minecraft");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <Upload className="size-4" aria-hidden />
                {into ? t("inventoryTransfer.import") : t("inventoryTransfer.importAll")}
            </Button>
            {open ? (
                <InventoryImportDialog
                    installedAppId={installedAppId}
                    into={into}
                    onClose={() => setOpen(false)}
                    onDone={onDone}
                />
            ) : null}
        </>
    );
}

type Preview = NonNullable<
    Awaited<ReturnType<typeof actions.previewInventoryImportAction>>["previews"]
>[number];

function stackText(t: GameText<"minecraft">, item: InventoryItem | null): string {
    if (!item) return t("inventoryTransfer.empty");
    const details = transfer.summarize(item);
    return `${item.count} x ${item.id.replace(/^minecraft:/, "")}${details ? ` (${details})` : ""}`;
}

function InventoryImportDialog({
    installedAppId,
    into,
    onClose,
    onDone
}: {
    installedAppId: string;
    into?: string;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useGameText("minecraft");
    const display = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [text, setText] = useState("");
    const [from, setFrom] = useState<string | null>(null);
    const [mode, setMode] = useState<transfer.ImportMode>("replace");
    const [previews, setPreviews] = useState<Preview[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<string[]>([]);
    const [pending, startTransition] = useTransition();
    const fileInput = useRef<HTMLInputElement>(null);

    // Read as it is typed or chosen, with the same check the server makes.
    const read = useMemo(() => (text.trim() ? transfer.parseTransfer(text) : null), [text]);
    const names = read?.ok ? read.file.players.map((player) => player.name) : [];
    const source = into ? (from && names.includes(from) ? from : (names[0] ?? null)) : null;
    const problem = read && !read.ok ? t(`inventoryTransfer.problems.${read.problem}`) : null;
    const single = into && source ? { from: source, into } : null;
    const ready = read?.ok === true && (!into || single !== null);

    const reset = () => {
        setPreviews(null);
        setResults([]);
        setError(null);
    };

    const preview = () =>
        startTransition(async () => {
            reset();
            const result = await actions
                .previewInventoryImportAction({ installedAppId, text, mode, single })
                .catch(() => ({
                    previews: undefined,
                    error: t("inventoryTransfer.couldNotImport")
                }));
            if (result.error) setError(result.error);
            else setPreviews(result.previews ?? []);
        });

    const writes = previews?.reduce((sum, one) => sum + transfer.writesOf(one.plan).length, 0) ?? 0;

    const apply = async () => {
        if (!previews) return;
        const agreed = await confirm({
            title: t("inventoryTransfer.confirmTitle"),
            description: t("inventoryTransfer.confirmBody"),
            confirmLabel: t("inventoryTransfer.confirm"),
            danger: mode === "replace"
        });
        if (!agreed) return;
        startTransition(async () => {
            const result = await actions
                .importInventoriesAction({
                    installedAppId,
                    text,
                    mode,
                    single,
                    seen: previews.map((one) => ({
                        player: one.player,
                        online: one.online,
                        items: one.plan.flatMap((slot) => (slot.before ? [slot.before] : []))
                    }))
                })
                .catch(() => ({
                    outcomes: undefined,
                    error: t("inventoryTransfer.couldNotImport")
                }));
            if (result.error) {
                setError(result.error);
                return;
            }
            const lines: string[] = [];
            for (const outcome of result.outcomes ?? []) {
                if (outcome.queued)
                    lines.push(t("inventoryTransfer.queued", { name: outcome.player }));
                else
                    lines.push(
                        t("inventoryTransfer.done", {
                            name: outcome.player,
                            count: outcome.written
                        })
                    );
                if (outcome.skipped.length > 0)
                    lines.push(
                        t("inventoryTransfer.skipped", {
                            name: outcome.player,
                            count: outcome.skipped.length
                        })
                    );
            }
            setResults(lines);
            setPreviews(null);
            onDone();
        });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>
                        {into
                            ? t("inventoryTransfer.importTitle")
                            : t("inventoryTransfer.importAllTitle")}
                    </DialogTitle>
                    <DialogDescription>
                        {into
                            ? t("inventoryTransfer.importHint")
                            : t("inventoryTransfer.importAllHint")}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Textarea
                        value={text}
                        onChange={(event) => {
                            setText(event.target.value);
                            reset();
                        }}
                        placeholder={t("inventoryTransfer.pasteHere")}
                        aria-label={t("inventoryTransfer.pasteHere")}
                        aria-invalid={problem ? true : undefined}
                        rows={5}
                        className="font-mono text-xs"
                        spellCheck={false}
                    />
                    {problem ? <p className="text-xs text-danger">{problem}</p> : null}
                    <div className="flex flex-wrap items-center gap-3">
                        <input
                            ref={fileInput}
                            type="file"
                            accept="application/json,.json"
                            className="hidden"
                            onChange={async (event) => {
                                const chosen = event.target.files?.[0];
                                event.target.value = "";
                                if (!chosen) return;
                                setText(await chosen.text());
                                reset();
                            }}
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fileInput.current?.click()}
                        >
                            <FileUp className="size-4" aria-hidden />
                            {t("inventoryTransfer.chooseFile")}
                        </Button>
                        {into && names.length > 1 ? (
                            <label className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">
                                    {t("inventoryTransfer.fromFile")}
                                </span>
                                <Select
                                    value={source ?? ""}
                                    onValueChange={(value) => {
                                        setFrom(value);
                                        reset();
                                    }}
                                    options={names.map((name) => ({ value: name, label: name }))}
                                    aria-label={t("inventoryTransfer.fromFile")}
                                />
                            </label>
                        ) : null}
                        {into && source ? (
                            <span className="text-sm text-muted-foreground">
                                {source} → {t("inventoryTransfer.into")} {into}
                            </span>
                        ) : null}
                    </div>
                    <SegmentedControl
                        value={mode}
                        onValueChange={(value) => {
                            setMode(value as transfer.ImportMode);
                            reset();
                        }}
                        options={transfer.IMPORT_MODES.map((value) => ({
                            value,
                            label: t(`inventoryTransfer.modes.${value}`)
                        }))}
                        aria-label={t("inventoryTransfer.mode")}
                    />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    {results.length > 0 ? (
                        <ul className="flex flex-col gap-1 text-sm">
                            {results.map((line) => (
                                <li key={line}>{line}</li>
                            ))}
                        </ul>
                    ) : null}
                    {previews?.map((one) => {
                        const changes = one.plan.filter((slot) => slot.change !== "keep");
                        return (
                            <section key={one.player} className="flex flex-col gap-2">
                                <p className="text-sm">
                                    <span className="font-medium">{one.player}</span>{" "}
                                    <span className="text-muted-foreground">
                                        {one.online
                                            ? t("inventoryTransfer.applyNow", { name: one.player })
                                            : t("inventoryTransfer.waitsForJoin", {
                                                  name: one.player
                                              })}
                                    </span>
                                </p>
                                {!one.online && one.basis === "none" ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t("inventoryTransfer.basisNone")}
                                    </p>
                                ) : null}
                                {!one.online && one.basis === "kept" && one.keptAt ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t("inventoryTransfer.basisKept", {
                                            when: display.dateTime(one.keptAt)
                                        })}
                                    </p>
                                ) : null}
                                {changes.length === 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t("inventoryTransfer.nothingChanges", {
                                            name: one.player
                                        })}
                                    </p>
                                ) : (
                                    <table className="w-full text-left text-xs">
                                        <thead className="text-muted-foreground">
                                            <tr>
                                                <th className="py-1 pr-2 font-normal">
                                                    {t("inventoryTransfer.slot")}
                                                </th>
                                                <th className="py-1 pr-2 font-normal">
                                                    {t("inventoryTransfer.now")}
                                                </th>
                                                <th className="py-1 pr-2 font-normal">
                                                    {t("inventoryTransfer.after")}
                                                </th>
                                                <th className="py-1 font-normal" />
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {changes.map((slot) => (
                                                <tr
                                                    key={slot.slot}
                                                    className="border-t border-border/60 align-top"
                                                >
                                                    <td className="py-1 pr-2 whitespace-nowrap">
                                                        {slotLabelIn(t, slot.slot)}
                                                    </td>
                                                    <td className="py-1 pr-2 break-all">
                                                        {stackText(t, slot.before)}
                                                    </td>
                                                    <td className="py-1 pr-2 break-all">
                                                        {stackText(
                                                            t,
                                                            slot.change === "refused"
                                                                ? (slot.wanted ?? null)
                                                                : slot.after
                                                        )}
                                                        {slot.refused ? (
                                                            <span className="block text-danger">
                                                                {t(
                                                                    `inventoryTransfer.refusals.${slot.refused}`
                                                                )}
                                                            </span>
                                                        ) : null}
                                                    </td>
                                                    <td className="py-1">
                                                        <Badge
                                                            variant={
                                                                slot.change === "refused"
                                                                    ? "danger"
                                                                    : "neutral"
                                                            }
                                                        >
                                                            {t(
                                                                `inventoryTransfer.changes.${slot.change as Exclude<transfer.SlotChange, "keep">}`
                                                            )}
                                                        </Badge>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </section>
                        );
                    })}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("players.close")}
                    </Button>
                    {previews && writes > 0 ? (
                        <Button onClick={apply} disabled={pending}>
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : null}
                            {t("inventoryTransfer.confirm")}
                        </Button>
                    ) : (
                        <Button
                            onClick={preview}
                            disabled={!ready || pending}
                            aria-disabled={!ready || pending}
                        >
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : null}
                            {t("inventoryTransfer.preview")}
                        </Button>
                    )}
                </DialogFooter>
                {confirmElement}
            </DialogContent>
        </Dialog>
    );
}
