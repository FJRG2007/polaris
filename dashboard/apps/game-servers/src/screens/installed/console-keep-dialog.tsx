"use client";

/**
 * Keeping a console command: the line, its name, and the variables it asks for.
 *
 * Beside the form, the same list of variables the side panel shows
 * (`VariablesHelp`), each one a button that puts it where the caret is - the
 * person's own included, once they have named one. Checked as it is typed with
 * the functions the server checks it with (`console-vars`), so Keep is only
 * offered for a command the server will take.
 */

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { useGameText, useSchemaText } from "../game-text";
import { VariablesHelp } from "../../components/variables-help";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import { MAX_SAVED_COMMAND, MAX_SAVED_LABEL } from "../../lib/console-commands";
import * as vars from "../../lib/console-vars";

/** What the dialog is writing. `id` is set when an existing one is edited. */
export interface KeepDraft {
    readonly id?: string;
    readonly label: string;
    readonly command: string;
    readonly variables: readonly vars.CustomVariable[];
}

export function KeepCommandDialog({
    initial,
    edition,
    hint,
    pending,
    error,
    onClose,
    onKeep
}: {
    initial: KeepDraft;
    edition: MinecraftEdition | null;
    hint?: string;
    pending: boolean;
    error: string;
    onClose: () => void;
    onKeep: (draft: KeepDraft) => void;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const [draft, setDraft] = useState<KeepDraft>(initial);
    const field = useRef<HTMLInputElement | null>(null);

    const set = (patch: Partial<KeepDraft>) => setDraft((current) => ({ ...current, ...patch }));
    const setVariable = (index: number, patch: Partial<vars.CustomVariable>) =>
        set({
            variables: draft.variables.map((declared, at) =>
                at === index ? { ...declared, ...patch } : declared
            )
        });

    // A row still being named is not finished, not wrong: it is left out of the
    // check until it has a name, and Keep waits for it.
    const unnamed = draft.variables.some((declared) => declared.name.trim().length === 0);
    const normalized = useMemo(
        () =>
            draft.variables
                .filter((declared) => declared.name.trim().length > 0)
                .map(vars.normalizeCustomVariable),
        [draft.variables]
    );
    const problem = useMemo(
        () =>
            draft.command.trim()
                ? vars.customVariablesProblem(draft.command.trim(), normalized)
                : null,
        [draft.command, normalized]
    );
    // The ones the command declares itself, `{x}` or `{x=100}`: asked for when
    // it runs, without a row of their own.
    const inline = useMemo(
        () =>
            vars
                .commandVariables(draft.command.trim(), normalized)
                .custom.filter((one) => !normalized.some((declared) => declared.name === one.name)),
        [draft.command, normalized]
    );
    const ready = draft.command.trim().length > 0 && !problem && !unnamed && !pending;

    /** Put a `{name}` where the caret is, and leave the caret after it. */
    function insert(token: string): void {
        const input = field.current;
        const start = input?.selectionStart ?? draft.command.length;
        const end = input?.selectionEnd ?? start;
        const command = (draft.command.slice(0, start) + token + draft.command.slice(end)).slice(
            0,
            MAX_SAVED_COMMAND
        );
        set({ command });
        requestAnimationFrame(() => {
            input?.focus();
            const caret = Math.min(start + token.length, command.length);
            input?.setSelectionRange(caret, caret);
        });
    }

    return (
        <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>
                        {draft.id ? t("console.editTheCommand") : t("console.keepACommand")}
                    </DialogTitle>
                    <DialogDescription>
                        {t.rich<ReactNode>("console.keepHelp", {
                            example: () => (
                                <code key="example">
                                    {/* i18n-ignore: the command by its own name */}
                                    {`Broadcast <${t("console.messagePlaceholder")}>`}
                                </code>
                            )
                        })}
                    </DialogDescription>
                </DialogHeader>
                <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                    <div className="flex min-w-0 flex-col gap-3">
                        <label className="flex flex-col gap-1">
                            <span className="text-sm font-medium">{t("console.command")}</span>
                            <Input
                                ref={field}
                                autoFocus
                                value={draft.command}
                                maxLength={MAX_SAVED_COMMAND}
                                className="font-mono"
                                placeholder={hint ?? t("console.defaultHint")}
                                onChange={(event) => set({ command: event.target.value })}
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("consoleVars.commandHint")}
                            </span>
                            {inline.length > 0 && (
                                <span className="text-xs break-words text-muted-foreground">
                                    {t("consoleVars.fromCommand", {
                                        names: inline
                                            .map((one) =>
                                                one.initial
                                                    ? `${one.name} = ${one.initial}`
                                                    : one.name
                                            )
                                            .join(", ")
                                    })}
                                </span>
                            )}
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className="text-sm font-medium">{t("console.name")}</span>
                            <Input
                                value={draft.label}
                                maxLength={MAX_SAVED_LABEL}
                                placeholder={t("console.theCommandItselfIfYou")}
                                onChange={(event) => set({ label: event.target.value })}
                            />
                        </label>

                        {draft.variables.length > 0 && (
                            <div className="flex flex-col gap-2">
                                <span className="text-sm font-medium">
                                    {t("consoleVars.yourVariables")}
                                </span>
                                {draft.variables.map((declared, index) => (
                                    <VariableEditor
                                        key={index}
                                        declared={declared}
                                        onChange={(patch) => setVariable(index, patch)}
                                        onRemove={() =>
                                            set({
                                                variables: draft.variables.filter(
                                                    (_, at) => at !== index
                                                )
                                            })
                                        }
                                    />
                                ))}
                            </div>
                        )}
                        {draft.variables.length < vars.MAX_CUSTOM_VARIABLES && (
                            <Button
                                size="xs"
                                variant="ghost"
                                className="self-start"
                                onClick={() =>
                                    set({
                                        variables: [
                                            ...draft.variables,
                                            { name: "", label: "", type: "text", initial: "" }
                                        ]
                                    })
                                }
                            >
                                <Plus className="size-3.5" /> {t("consoleVars.addVariable")}
                            </Button>
                        )}
                        {(problem || error) && (
                            <p role="alert" className="text-sm text-danger">
                                {problem ? schemaText(problem) : error}
                            </p>
                        )}
                    </div>
                    <VariablesHelp
                        edition={edition}
                        scope="console"
                        custom={normalized}
                        onInsert={insert}
                        className="max-h-72 lg:max-h-[26rem]"
                    />
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("console.cancel")}
                    </Button>
                    <Button
                        aria-disabled={!ready}
                        className="aria-disabled:opacity-50"
                        disabled={pending}
                        onClick={() =>
                            ready &&
                            onKeep({
                                ...draft,
                                command: draft.command.trim(),
                                variables: normalized
                            })
                        }
                    >
                        {t("console.keepIt")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** One declared variable: how it is written, what it asks, its type and default. */
function VariableEditor({
    declared,
    onChange,
    onRemove
}: {
    declared: vars.CustomVariable;
    onChange: (patch: Partial<vars.CustomVariable>) => void;
    onRemove: () => void;
}) {
    const t = useGameText("games");
    const schemaText = useSchemaText();
    const initial = vars.normalizeValue(declared.type, declared.initial);
    // An empty default is allowed: the run dialog then starts empty.
    const initialProblem = initial.length > 0 ? vars.valueProblem(declared.type, initial) : null;
    const remove = t("consoleVars.removeVariable", { name: declared.name || "?" });
    return (
        <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-2">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
                <label className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                        {t("consoleVars.variableName")}
                    </span>
                    <Input
                        value={declared.name}
                        maxLength={26}
                        className="font-mono"
                        placeholder="amount"
                        onChange={(event) => onChange({ name: event.target.value })}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                        {t("consoleVars.variableLabel")}
                    </span>
                    <Input
                        value={declared.label}
                        maxLength={vars.MAX_VARIABLE_LABEL}
                        placeholder={declared.name}
                        onChange={(event) => onChange({ label: event.target.value })}
                    />
                </label>
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={remove}
                    title={remove}
                    className="rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                >
                    <Trash2 className="size-4" />
                </button>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                        {t("consoleVars.variableType")}
                    </span>
                    <Select
                        value={declared.type}
                        onValueChange={(value) =>
                            onChange({ type: value as vars.CustomVariableType })
                        }
                        options={vars.CUSTOM_VARIABLE_TYPES.map((type) => ({
                            value: type,
                            label: t(`consoleVars.types.${type}`)
                        }))}
                        aria-label={t("consoleVars.variableType")}
                    />
                </div>
                <label className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                        {t("consoleVars.variableDefault")}
                    </span>
                    <Input
                        value={declared.initial}
                        maxLength={vars.MAX_VARIABLE_VALUE}
                        aria-invalid={initialProblem ? true : undefined}
                        onChange={(event) => onChange({ initial: event.target.value })}
                    />
                </label>
            </div>
            {initialProblem && (
                <span role="alert" className="text-xs text-danger">
                    {schemaText(initialProblem)}
                </span>
            )}
        </div>
    );
}
