"use client";

/**
 * Data mapping: a text field that may hold `{{path}}` references offers the
 * values earlier steps give, and picking one puts the reference where the
 * caret was. Nothing is evaluated here or anywhere else: the server resolves
 * the same paths against the run's context (`core.interpolate`).
 */

import { Braces } from "lucide-react";
import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    createContext,
    useContext,
    useMemo,
    useRef,
    type ChangeEvent,
    type ComponentProps,
    type ReactNode
} from "react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
    Input,
    Textarea
} from "@polaris/ui";

interface EditorGraph {
    readonly graph: core.AutomationGraph;
    /** The last test run's output by node id. */
    readonly samples: Readonly<Record<string, unknown>>;
    readonly label: (nodeId: string) => string;
}

const GraphContext = createContext<EditorGraph | null>(null);
const ScopeContext = createContext<readonly core.ReferenceGroup[]>([]);

export function EditorGraphProvider({
    value,
    children
}: {
    value: EditorGraph;
    children: ReactNode;
}) {
    return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>;
}

/** The references the fields inside may offer: those of `nodeId`'s place in the graph. */
export function ReferenceScope({ nodeId, children }: { nodeId: string; children: ReactNode }) {
    const editor = useContext(GraphContext);
    const groups = useMemo(
        () => (editor ? core.referenceOptions(editor.graph, nodeId, editor.samples) : []),
        [editor, nodeId]
    );
    return <ScopeContext.Provider value={groups}>{children}</ScopeContext.Provider>;
}

function ReferenceMenu({
    disabled,
    onPick
}: {
    disabled?: boolean;
    onPick: (path: string) => void;
}) {
    const t = useTranslations("automations");
    const groups = useContext(ScopeContext);
    const editor = useContext(GraphContext);
    if (disabled || !editor) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("canvas.insert")}
                    title={t("canvas.insert")}
                >
                    <Braces aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                className="max-h-80 w-72 overflow-y-auto overscroll-contain"
            >
                {groups.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        {t("canvas.noReferences")}
                    </p>
                ) : (
                    groups.map((group) => (
                        <div key={group.nodeId}>
                            <DropdownMenuLabel>
                                <span
                                    className="block truncate"
                                    title={
                                        group.nodeId === "run"
                                            ? t("canvas.runGroup")
                                            : editor.label(group.nodeId)
                                    }
                                >
                                    {group.nodeId === "run"
                                        ? t("canvas.runGroup")
                                        : editor.label(group.nodeId)}
                                    {" - "}
                                    {group.fromSample ? t("canvas.fromSample") : t("canvas.known")}
                                </span>
                            </DropdownMenuLabel>
                            {group.options.map((option) => (
                                <DropdownMenuItem
                                    key={option.path}
                                    onSelect={() => onPick(option.path)}
                                >
                                    <span
                                        className="min-w-0 flex-1 truncate font-mono text-xs"
                                        title={option.path}
                                    >
                                        {option.path}
                                    </span>
                                    {option.preview ? (
                                        <span
                                            className="max-w-[40%] truncate text-xs text-foreground-subtle"
                                            title={option.preview}
                                        >
                                            {option.preview}
                                        </span>
                                    ) : null}
                                </DropdownMenuItem>
                            ))}
                        </div>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Where the caret was when the field last had it, and the insertion that keeps it there. */
function useInsertion<E extends Field>(
    value: string,
    onChange: ((event: ChangeEvent<E>) => void) | undefined
) {
    const ref = useRef<E>(null);
    const caret = useRef<{ start: number; end: number } | null>(null);
    const remember = () => {
        const element = ref.current;
        if (element)
            caret.current = {
                start: element.selectionStart ?? value.length,
                end: element.selectionEnd ?? value.length
            };
    };
    const insert = (path: string) => {
        const at = caret.current ?? { start: value.length, end: value.length };
        const next = core.insertReference(value, at.start, at.end, path);
        // The forms read `event.target.value` only; the field is controlled, so React draws the new text.
        onChange?.({ target: { value: next.text } } as ChangeEvent<E>);
        caret.current = { start: next.caret, end: next.caret };
        setTimeout(() => {
            const element = ref.current;
            if (!element) return;
            element.focus();
            element.setSelectionRange(next.caret, next.caret);
        }, 0);
    };
    return { ref, remember, insert };
}

export function RefInput({ className, ...props }: ComponentProps<typeof Input>) {
    const value = String(props.value ?? "");
    const { ref, remember, insert } = useInsertion<HTMLInputElement>(value, props.onChange);
    return (
        <div className="flex min-w-0 items-center gap-1">
            <Input
                {...props}
                ref={ref}
                className={className ? `min-w-0 flex-1 ${className}` : "min-w-0 flex-1"}
                onSelect={remember}
                onBlur={remember}
                onKeyUp={remember}
            />
            <ReferenceMenu disabled={props.disabled} onPick={insert} />
        </div>
    );
}

export function RefTextarea({ className, ...props }: ComponentProps<typeof Textarea>) {
    const value = String(props.value ?? "");
    const { ref, remember, insert } = useInsertion<HTMLTextAreaElement>(value, props.onChange);
    return (
        <div className="flex min-w-0 items-start gap-1">
            <Textarea
                {...props}
                ref={ref}
                className={className ? `min-w-0 flex-1 ${className}` : "min-w-0 flex-1"}
                onSelect={remember}
                onBlur={remember}
                onKeyUp={remember}
            />
            <ReferenceMenu disabled={props.disabled} onPick={insert} />
        </div>
    );
}
