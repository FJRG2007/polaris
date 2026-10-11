"use client";

/**
 * Duplicating a server, as the list draws it: the dialog that asks for the
 * copy's name, and the status a copy shows while it is being made or after it
 * stopped part-way.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import * as plan from "../lib/duplicate-plan";
import { useGameText, useSchemaText } from "./game-text";
import { duplicateGameServerAction, duplicateSetupAction, type DuplicateSetup } from "./actions";

/** Ask what the copy is called, check it as it is typed, and start the copy. */
export function DuplicateServerDialog({
    source,
    knownNames,
    onClose,
    onStarted
}: {
    source: { readonly id: string; readonly name: string };
    /** The names the page already has, so the default and the check work before
     *  the dialog's own read answers. */
    knownNames: readonly string[];
    onClose: () => void;
    onStarted: (installedAppId: string) => void;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const inputId = useId();
    const [setup, setSetup] = useState<DuplicateSetup | null>(null);
    const [setupError, setSetupError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const word = (base: string, count: number | null) =>
        count === null
            ? t("duplicate.defaultName", { name: base })
            : t("duplicate.defaultNameNumbered", { name: base, count });
    const [name, setName] = useState(() => plan.defaultCopyName(source.name, knownNames, word));
    const [edited, setEdited] = useState(false);

    useEffect(() => {
        let live = true;
        void duplicateSetupAction(source.id).then((result) => {
            if (!live) return;
            if (result.error) setSetupError(result.error);
            if (result.setup) setSetup(result.setup);
        });
        return () => {
            live = false;
        };
    }, [source.id]);

    const taken = useMemo(() => [...knownNames, ...(setup?.takenNames ?? [])], [knownNames, setup]);
    // A name somebody has not touched yet follows what the read found taken.
    useEffect(() => {
        if (!edited) setName(plan.defaultCopyName(source.name, taken, word));
        // `word` is a fresh closure every render and reads the same catalog.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [taken, edited, source.name]);

    const parsed = plan.duplicateServerSchema.safeParse({ installedAppId: source.id, name });
    const empty = plan.normalizeServerName(name).length === 0;
    const problem = empty
        ? null
        : !parsed.success
          ? (schemaText(parsed.error.issues[0]?.message) ?? null)
          : plan.nameTaken(name, taken)
            ? t("duplicate.nameTakenShort")
            : null;
    const tooBig = setup?.fits === false;
    const ready = parsed.success && !problem && !tooBig && setupError === null && !pending;

    function submit(): void {
        if (!ready) return;
        setError(null);
        startTransition(async () => {
            const result = await duplicateGameServerAction({ installedAppId: source.id, name });
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.installedAppId) onStarted(result.installedAppId);
        });
    }

    return (
        <Dialog open onOpenChange={(open: boolean) => !open && !pending && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="min-w-0 truncate" title={source.name}>
                        {t("duplicate.title", { name: source.name })}
                    </DialogTitle>
                    <DialogDescription>{t("duplicate.description")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    <div className="flex min-w-0 flex-col gap-1">
                        <label htmlFor={inputId} className="text-sm font-medium">
                            {t("duplicate.name")}
                            <span aria-hidden="true"> *</span>
                        </label>
                        <Input
                            id={inputId}
                            autoFocus
                            required
                            value={name}
                            maxLength={plan.SERVER_NAME_MAX + 20}
                            aria-invalid={problem !== null}
                            aria-describedby={problem ? `${inputId}-problem` : undefined}
                            onChange={(event) => {
                                setEdited(true);
                                setName(event.target.value);
                            }}
                        />
                        {problem && (
                            <p id={`${inputId}-problem`} className="text-xs text-danger">
                                {problem}
                            </p>
                        )}
                    </div>

                    <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                        {setup === null && setupError === null ? (
                            <li className="flex items-center gap-2">
                                <Loader2 className="size-3.5 animate-spin" />{" "}
                                {t("duplicate.checking")}
                            </li>
                        ) : setup ? (
                            <>
                                {setup.running && <li>{t("duplicate.stopsWhileCopying")}</li>}
                                {setup.usedBytes !== null && setup.freeBytes !== null ? (
                                    <li className={tooBig ? "text-danger" : undefined}>
                                        {t(tooBig ? "duplicate.wontFit" : "duplicate.sizes", {
                                            need: plan.formatBytes(setup.usedBytes),
                                            free: plan.formatBytes(setup.freeBytes)
                                        })}
                                    </li>
                                ) : (
                                    <li>{t("duplicate.sizeUnknown")}</li>
                                )}
                                <li>{t("duplicate.whatChanges")}</li>
                            </>
                        ) : null}
                    </ul>

                    {(setupError || error) && (
                        <p role="alert" className="text-sm text-danger">
                            {setupError ?? error}
                        </p>
                    )}

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                            {t("duplicate.cancel")}
                        </Button>
                        <Button type="submit" disabled={!ready} aria-disabled={!ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("duplicate.confirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Where a copy is, in place of the status a running server shows. */
export function CopyStatus({ copy }: { copy: plan.DuplicateState }) {
    const t = useGameText("games");
    if (copy.stage === "failed") {
        const failure = copy.failure ?? "copyFailed";
        return (
            <div className="flex min-w-0 flex-col items-start gap-0.5">
                <Badge variant="danger">{t("duplicate.stage.failed")}</Badge>
                <span className="max-w-64 text-xs text-danger" title={copy.fromName}>
                    {t(`duplicate.failure.${failure}`, {
                        need: plan.formatBytes(copy.needBytes ?? 0),
                        free: plan.formatBytes(copy.freeBytes ?? 0),
                        name: copy.fromName
                    })}
                </span>
            </div>
        );
    }
    const percent = copy.stage === "copying" ? plan.copyPercent(copy) : null;
    return (
        <div className="flex min-w-0 flex-col items-start gap-1">
            <Badge variant="warning">
                <Loader2 className="size-3 animate-spin" /> {t(`duplicate.stage.${copy.stage}`)}
            </Badge>
            <span className="max-w-48 truncate text-xs text-muted-foreground" title={copy.fromName}>
                {t("duplicate.from", { name: copy.fromName })}
            </span>
            {percent !== null && (
                <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={t("duplicate.progress")}
                    className="h-1 w-32 overflow-hidden rounded-full bg-muted"
                >
                    <div
                        className="h-full bg-primary transition-[width]"
                        style={{ width: `${percent}%` }}
                    />
                </div>
            )}
        </div>
    );
}
