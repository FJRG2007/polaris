"use client";

/**
 * The raw editor: a scope's variables as the editor has them, pending changes
 * included, every value in the clear,
 * as a `.env` or as JSON - to read, to copy whole, and, for somebody who may
 * edit them, to change in place, the way Railway's raw editor works.
 *
 * What is typed back is the scope's complete new set (`stageReplacement`): a
 * line deleted is a variable removed. Nothing is saved from here; Update stages
 * the difference into the editor's changes, where it is reviewed and saved like
 * any other edit. The values come from the server in one request
 * (`revealEnvScopeAction`), which writes down which secrets were shown.
 *
 * The text is painted and searched the way the Drive code viewer's is - it is
 * the same surface (`CodeSurface`) and the same find bar, on Ctrl+F - and the
 * set can be downloaded as the `.env` or JSON file it reads as.
 */

import { Check, Copy, Download, Loader2, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeSurface } from "@/components/code-surface";
import { FindBar } from "@/app/(app)/drive/viewer/find-bar";
import { findMatches, stepMatch } from "@/app/(app)/drive/viewer/find-in-file";
import { revealEnvScopeAction } from "./variable-actions";
import type { VariableDraft, VariableRow } from "@/lib/deploy/variable-changes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    draftEntries,
    parseRaw,
    renderRaw,
    type RawEntry,
    type RawFormat,
    type RawRefusal
} from "@/lib/deploy/variable-raw";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    SegmentedControl
} from "@polaris/ui";

/** The highlight.js grammar each format is painted with: a `.env` reads as
 *  INI's key = value lines, comments included. */
const GRAMMAR: Readonly<Record<RawFormat, string>> = { env: "ini", json: "json" };

/** What a download is called: the file each format is. */
const FILE_NAME: Readonly<Record<RawFormat, string>> = { env: ".env", json: "variables.json" };

export function VariablesRawDialog({
    scope,
    scopeId,
    rows,
    draft,
    canWrite,
    onClose,
    onUpdate
}: {
    scope: "application" | "environment";
    scopeId: string;
    rows: readonly VariableRow[];
    /** The changes staged so far, written into the text so Update keeps them. */
    draft: VariableDraft;
    canWrite: boolean;
    onClose: () => void;
    /** The whole new set, with every stored value as it was shown, for the
     *  editor to compare against. */
    onUpdate: (
        entries: readonly RawEntry[],
        values: Readonly<Record<string, string>>,
        newAreSecrets: boolean
    ) => void;
}) {
    const t = useTranslations("deployConfig");
    const [values, setValues] = useState<Record<string, string> | null>(null);
    const [format, setFormat] = useState<RawFormat>("env");
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [newAreSecrets, setNewAreSecrets] = useState(true);
    const [copied, setCopied] = useState(false);
    const [finding, setFinding] = useState(false);
    const [query, setQuery] = useState("");
    const [at, setAt] = useState(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const matches = useMemo(() => findMatches(text, query), [text, query]);
    const on = matches.length === 0 ? 0 : Math.min(at, matches.length - 1);

    useEffect(() => {
        let live = true;
        void revealEnvScopeAction({ scope, scopeId })
            .then((result) => {
                if (!live) return;
                if (result.values) {
                    setValues(result.values);
                    setText(renderRaw(draftEntries(rows, draft, result.values), "env"));
                } else setError(result.error ?? t("variables.raw.loadFailed"));
            })
            .catch(() => live && setError(t("variables.raw.loadFailed")));
        return () => {
            live = false;
            if (timer.current) clearTimeout(timer.current);
        };
        // The rows and changes on screen when it opened are the set it shows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, scopeId]);

    function refusal(said: RawRefusal): string {
        if (said.error === "notText") return t("variables.raw.notText", { key: said.key });
        if (said.error === "badKey") return t("variables.raw.badKey", { key: said.key });
        return t(`variables.raw.${said.error}`);
    }

    /** Switch format, carrying what is typed across rather than starting over. */
    function switchTo(next: RawFormat): void {
        if (next === format) return;
        const read = parseRaw(text, format);
        if (!read.ok) {
            setError(refusal(read));
            return;
        }
        setError(null);
        setText(renderRaw(read.entries, next));
        setFormat(next);
    }

    async function copyAll(): Promise<void> {
        if (!navigator.clipboard) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return;
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
    }

    function find(open: boolean): void {
        setFinding(open);
        if (!open) setQuery("");
    }

    function download(): void {
        const url = URL.createObjectURL(
            new Blob([text], { type: format === "json" ? "application/json" : "text/plain" })
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = FILE_NAME[format];
        link.click();
        URL.revokeObjectURL(url);
    }

    function update(): void {
        if (!values) return;
        const read = parseRaw(text, format);
        if (!read.ok) {
            setError(refusal(read));
            return;
        }
        onUpdate(read.entries, values, newAreSecrets);
    }

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent
                className="max-w-2xl"
                onEscapeKeyDown={(event) => {
                    // Escape closes the find bar first, as in every editor; the
                    // dialog only on the next one.
                    if (!finding) return;
                    event.preventDefault();
                    find(false);
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t("variables.raw.title")}</DialogTitle>
                    <DialogDescription>
                        {canWrite ? t("variables.raw.intro") : t("variables.raw.introReadOnly")}
                    </DialogDescription>
                </DialogHeader>
                <div
                    className="flex min-w-0 flex-col gap-2"
                    onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
                            // The browser's own find searches the page behind the
                            // dialog, not the text in it.
                            event.preventDefault();
                            find(true);
                        }
                    }}
                >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <SegmentedControl
                            aria-label={t("variables.raw.format")}
                            size="sm"
                            value={format}
                            onValueChange={(next) => switchTo(next as RawFormat)}
                            options={[
                                // i18n-ignore: the formats' own names
                                { value: "env", label: "ENV" },
                                // i18n-ignore: the formats' own names
                                { value: "json", label: "JSON" }
                            ]}
                        />
                        <div className="flex items-center gap-3">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => find(!finding)}
                                aria-label={t("variables.raw.find")}
                                title={t("variables.raw.findCtrl")}
                            >
                                <Search className="size-4" />
                            </Button>
                            {canWrite && format === "env" && (
                                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
                                    <Upload className="size-3.5" />
                                    {t("variables.upload")}
                                    <input
                                        type="file"
                                        accept=".env,text/plain"
                                        className="hidden"
                                        onChange={(event) => {
                                            const file = event.target.files?.[0];
                                            event.target.value = "";
                                            if (file)
                                                void file
                                                    .text()
                                                    .then((more) =>
                                                        setText((now) =>
                                                            now.trim()
                                                                ? `${now.trimEnd()}\n${more}`
                                                                : more
                                                        )
                                                    );
                                        }}
                                    />
                                </label>
                            )}
                        </div>
                    </div>
                    <div
                        className="relative flex max-h-[55vh] min-h-48 flex-col overflow-hidden rounded-md border border-border bg-surface"
                        aria-busy={values === null && !error ? true : undefined}
                    >
                        {finding && (
                            <FindBar
                                label={t("variables.raw.find")}
                                query={query}
                                onQuery={(value) => {
                                    setQuery(value);
                                    setAt(0);
                                }}
                                total={matches.length}
                                current={on}
                                onStep={(by) => setAt(stepMatch(on, matches.length, by))}
                                onClose={() => find(false)}
                            />
                        )}
                        <CodeSurface
                            code={text}
                            language={GRAMMAR[format]}
                            onChange={setText}
                            readOnly={!canWrite || values === null}
                            ariaLabel={t("variables.raw.text")}
                            matches={matches}
                            currentMatch={on}
                        />
                        {values === null && !error && (
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
                                <Loader2 className="size-5 animate-spin" />
                            </span>
                        )}
                    </div>
                    {error && (
                        <p role="alert" className="text-sm text-danger-ink">
                            {error}
                        </p>
                    )}
                    {canWrite && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Checkbox
                                checked={newAreSecrets}
                                onChange={(event) => setNewAreSecrets(event.target.checked)}
                            />
                            {t("variables.newAreSecrets")}
                        </label>
                    )}
                </div>
                <DialogFooter className="flex-wrap gap-2">
                    <div className="flex flex-wrap gap-2 sm:mr-auto">
                        <Button
                            variant="outline"
                            disabled={values === null}
                            onClick={() => void copyAll()}
                        >
                            {copied ? (
                                <Check className="size-4 text-success-ink" />
                            ) : (
                                <Copy className="size-4" />
                            )}
                            {copied ? t("variables.raw.copied") : t("variables.raw.copyAll")}
                        </Button>
                        <Button variant="outline" disabled={values === null} onClick={download}>
                            <Download className="size-4" />
                            {t("variables.raw.download")}
                        </Button>
                    </div>
                    <Button variant="ghost" onClick={onClose}>
                        {t("variables.raw.close")}
                    </Button>
                    {canWrite && (
                        <Button disabled={values === null} onClick={update}>
                            {t("variables.raw.update")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
