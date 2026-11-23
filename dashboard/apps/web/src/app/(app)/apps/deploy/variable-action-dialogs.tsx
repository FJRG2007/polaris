"use client";

/**
 * The dialogs behind three actions of a variable's menu: seal it, share it
 * with every service, and give it a generator. Each says in one sentence what
 * it does before anything is written, since sealing cannot be undone and
 * sharing moves the value somewhere else.
 */

import { Loader2, RotateCw } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    DEFAULT_ALPHABET,
    DEFAULT_LENGTH,
    formatGenerator,
    generateValue,
    generatorSpecSchema,
    MAX_LENGTH,
    parseGenerator
} from "@/lib/deploy/variable-generator";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

export type VariableDialog = "seal" | "promote" | "generator";

/** A confirm-shaped dialog: a title, one sentence, the action, and any refusal. */
function ConfirmVariableDialog({
    title,
    body,
    action,
    danger,
    onConfirm,
    onClose
}: {
    title: string;
    body: string;
    action: string;
    danger?: boolean;
    onConfirm: () => Promise<{ error?: string; }>;
    onClose: () => void;
}) {
    const t = useTranslations("deployConfig");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function confirm(): void {
        setError(null);
        startTransition(async () => {
            const result = await onConfirm().catch(() => ({ error: t("variables.dialog.failed") }));
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="break-words">{title}</DialogTitle>
                    <DialogDescription>{body}</DialogDescription>
                </DialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" disabled={pending} onClick={onClose}>
                        {t("variables.dialog.cancel")}
                    </Button>
                    <Button
                        variant={danger ? "danger" : "primary"}
                        disabled={pending}
                        onClick={confirm}
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" /> : action}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function SealVariableDialog({
    name,
    onSeal,
    onClose
}: {
    name: string;
    onSeal: () => Promise<{ error?: string; }>;
    onClose: () => void;
}) {
    const t = useTranslations("deployConfig");
    return (
        <ConfirmVariableDialog
            title={t("variables.seal.title", { name })}
            body={t("variables.seal.body")}
            action={t("variables.seal.action")}
            danger
            onConfirm={onSeal}
            onClose={onClose}
        />
    );
}

export function PromoteVariableDialog({
    name,
    onPromote,
    onClose
}: {
    name: string;
    onPromote: () => Promise<{ error?: string; }>;
    onClose: () => void;
}) {
    const t = useTranslations("deployConfig");
    return (
        <ConfirmVariableDialog
            title={t("variables.promoteDialog.title", { name })}
            body={t("variables.promoteDialog.body", { reference: `\${{shared.${name}}}` })}
            action={t("variables.promoteDialog.action")}
            onConfirm={onPromote}
            onClose={onClose}
        />
    );
}

/**
 * Choose how a variable's value is drawn - how long, from which characters -
 * with a sample of what it gives, and whether the value here is replaced now
 * too. Checked as it is typed against the schema the server checks it with.
 */
export function GeneratorDialog({
    name,
    current,
    onSave,
    onClose
}: {
    name: string;
    /** The generator it has, if any. */
    current: string | null;
    onSave: (generator: string | null, regenerate: boolean) => Promise<{ error?: string; }>;
    onClose: () => void;
}) {
    const t = useTranslations("deployConfig");
    const initial = (current ? parseGenerator(current) : null) ?? {
        length: DEFAULT_LENGTH,
        alphabet: DEFAULT_ALPHABET
    };
    const [length, setLength] = useState(String(initial.length));
    const [alphabet, setAlphabet] = useState(initial.alphabet);
    const [regenerate, setRegenerate] = useState(false);
    const [sample, setSample] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const lengthValid = /^\d{1,3}$/.test(length.trim())
        ? generatorSpecSchema.shape.length.safeParse(Number(length)).success
        : false;
    const alphabetValid = generatorSpecSchema.shape.alphabet.safeParse(alphabet).success;
    const spec = lengthValid && alphabetValid ? { length: Number(length), alphabet } : null;
    const expression = spec ? formatGenerator(spec) : null;
    // Drawn again when asked, so a reader can see what kind of value it gives.
    const preview = useMemo(() => (spec ? generateValue(spec) : null), [expression, sample]);
    const unchanged = expression === current && !regenerate;

    function save(generator: string | null): void {
        setError(null);
        startTransition(async () => {
            const result = await onSave(generator, generator !== null && regenerate).catch(() => ({
                error: t("variables.dialog.failed")
            }));
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="break-words">
                        {t("variables.generator.title", { name })}
                    </DialogTitle>
                    <DialogDescription>{t("variables.generator.body")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap gap-3">
                        <label className="flex w-24 flex-col gap-1.5 text-sm font-medium">
                            {t("variables.generator.length")}
                            <Input
                                inputMode="numeric"
                                value={length}
                                onChange={(event) => setLength(event.target.value)}
                                aria-invalid={!lengthValid}
                                className="h-8 font-mono text-xs"
                            />
                        </label>
                        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5 text-sm font-medium">
                            {t("variables.generator.characters")}
                            <Input
                                value={alphabet}
                                onChange={(event) => setAlphabet(event.target.value)}
                                aria-invalid={!alphabetValid}
                                className="h-8 font-mono text-xs"
                            />
                        </label>
                    </div>
                    {!lengthValid && (
                        <p className="text-xs text-danger-ink">
                            {t("variables.generator.lengthInvalid", { max: MAX_LENGTH })}
                        </p>
                    )}
                    {!alphabetValid && (
                        <p className="text-xs text-danger-ink">
                            {t("variables.generator.charactersInvalid")}
                        </p>
                    )}
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">
                            {t("variables.generator.preview")}
                        </span>
                        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5">
                            <code className="min-w-0 flex-1 truncate text-xs" title={preview ?? ""}>
                                {preview ?? "-"}
                            </code>
                            <button
                                type="button"
                                disabled={!spec}
                                onClick={() => setSample((value) => value + 1)}
                                aria-label={t("variables.generator.another")}
                                title={t("variables.generator.another")}
                                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                                <RotateCw className="size-3.5" />
                            </button>
                        </div>
                        {expression && (
                            <code className="truncate text-xs text-muted-foreground">
                                {expression}
                            </code>
                        )}
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                            checked={regenerate}
                            onChange={(event) => setRegenerate(event.target.checked)}
                        />
                        <span className="min-w-0">{t("variables.generator.regenerate")}</span>
                    </label>
                    {error && (
                        <p role="alert" className="text-sm text-danger-ink">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    {current && (
                        <Button
                            variant="ghost"
                            disabled={pending}
                            onClick={() => save(null)}
                            className="me-auto"
                        >
                            {t("variables.generator.remove")}
                        </Button>
                    )}
                    <Button variant="ghost" disabled={pending} onClick={onClose}>
                        {t("variables.dialog.cancel")}
                    </Button>
                    <Button
                        disabled={pending || !expression || unchanged}
                        onClick={() => expression && save(expression)}
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            t("variables.generator.save")
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
