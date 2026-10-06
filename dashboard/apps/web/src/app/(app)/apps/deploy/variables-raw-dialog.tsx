"use client";

/**
 * The raw editor: a scope's variables as they are, every value in the clear,
 * as a `.env` or as JSON - to read, to copy whole, and, for somebody who may
 * edit them, to change in place, the way Railway's raw editor works.
 *
 * What is typed back is the scope's complete new set (`stageReplacement`): a
 * line deleted is a variable removed. Nothing is saved from here; Update stages
 * the difference into the editor's changes, where it is reviewed and saved like
 * any other edit. The values come from the server in one request
 * (`revealEnvScopeAction`), which writes down which secrets were shown.
 */

import { Loader2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { revealEnvScopeAction } from "./variable-actions";
import type { VariableRow } from "@/lib/deploy/variable-changes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
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
    SegmentedControl,
    Textarea
} from "@polaris/ui";

export function VariablesRawDialog({
    scope,
    scopeId,
    rows,
    canWrite,
    onClose,
    onUpdate
}: {
    scope: "application" | "environment";
    scopeId: string;
    rows: readonly VariableRow[];
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
    const [newAreSecrets, setNewAreSecrets] = useState(false);
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let live = true;
        void revealEnvScopeAction({ scope, scopeId })
            .then((result) => {
                if (!live) return;
                if (result.values) {
                    setValues(result.values);
                    setText(renderRaw(rows, result.values, "env"));
                } else setError(result.error ?? t("variables.raw.loadFailed"));
            })
            .catch(() => live && setError(t("variables.raw.loadFailed")));
        return () => {
            live = false;
            if (timer.current) clearTimeout(timer.current);
        };
        // The rows on screen when it opened are the set it shows.
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
        const asRows = read.entries.map((entry) => ({
            id: entry.key,
            key: entry.key,
            isSecret: false,
            value: entry.value
        }));
        setText(renderRaw(asRows, {}, next));
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
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("variables.raw.title")}</DialogTitle>
                    <DialogDescription>
                        {canWrite ? t("variables.raw.intro") : t("variables.raw.introReadOnly")}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-2">
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
                                                        now.trim() ? `${now.trimEnd()}\n${more}` : more
                                                    )
                                                );
                                    }}
                                />
                            </label>
                        )}
                    </div>
                    <div className="relative">
                        <Textarea
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            readOnly={!canWrite || values === null}
                            rows={14}
                            spellCheck={false}
                            autoComplete="off"
                            aria-label={t("variables.raw.text")}
                            aria-busy={values === null && !error ? true : undefined}
                            className="max-h-[55vh] min-h-48 font-mono text-xs"
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
                    <Button
                        variant="outline"
                        className="sm:mr-auto"
                        disabled={values === null}
                        onClick={() => void copyAll()}
                    >
                        {copied ? t("variables.raw.copied") : t("variables.raw.copyAll")}
                    </Button>
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
