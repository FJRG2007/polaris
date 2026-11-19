"use client";

/**
 * The buttons and forms under a message Polar or an app wrote - see
 * `lib/chat/message-components`.
 *
 * A link goes where it says. A button or a form's answers go to the server by
 * the component's position, and the server reads what it does from the stored
 * message. One kept for somebody else is drawn disabled, with who it is for.
 * A select menu sends what was picked the same way. An ephemeral message
 * carries "Only you can see this" and a way to dismiss it, as Discord's does.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "./actions";
import {
    AlertTriangle,
    Check,
    ChevronDown,
    Eye,
    Info,
    Link2,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Settings,
    Trash2,
    X,
    type LucideIcon
} from "lucide-react";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    componentLook,
    type ComponentIcon,
    type FormField,
    type MessageComponent
} from "@/lib/chat/message-components";
import {
    Button,
    Checkbox,
    cn,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea
} from "@polaris/ui";

const ICONS: Record<ComponentIcon, LucideIcon> = {
    check: Check,
    x: X,
    plus: Plus,
    refresh: RefreshCw,
    pencil: Pencil,
    trash: Trash2,
    info: Info,
    alert: AlertTriangle,
    link: Link2,
    settings: Settings
};

function ComponentIconMark({ name }: { name?: ComponentIcon }) {
    const Icon = name ? ICONS[name] : null;
    return Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null;
}

type SelectComponent = Extract<MessageComponent, { type: "select" }>;

export function MessageComponents({
    messageId,
    components,
    onError
}: {
    messageId: string;
    components: readonly MessageComponent[];
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const { viewerId } = useChat();
    const [busy, setBusy] = useState<number | null>(null);
    const [form, setForm] = useState<number | null>(null);

    const press = async (
        index: number,
        fields?: Record<string, string>,
        values?: readonly string[]
    ): Promise<boolean> => {
        setBusy(index);
        const result = await runAction(
            () =>
                actions.pressComponentAction({
                    messageId,
                    index,
                    ...(fields ? { fields } : {}),
                    ...(values ? { values: [...values] } : {})
                }),
            onError
        );
        setBusy(null);
        if (result?.error) onError(result.error);
        return Boolean(result && !result.error);
    };

    const opened = form === null ? null : components[form];
    return (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
            {components.map((component, index) => {
                const look = componentLook(component);
                if (component.type === "link") {
                    if (component.disabled) {
                        return (
                            <Button key={index} size="sm" variant={look.variant} disabled className="min-w-0 max-w-full">
                                <ComponentIconMark name={component.icon} />
                                <span className="truncate" title={component.label}>{component.label}</span>
                            </Button>
                        );
                    }
                    return (
                        <Button key={index} asChild size="sm" variant={look.variant} className="min-w-0 max-w-full">
                            <Link href={component.href} prefetch={false}>
                                <ComponentIconMark name={component.icon} />
                                <span className="truncate" title={component.label}>{component.label}</span>
                            </Link>
                        </Button>
                    );
                }
                const notMine = Boolean(component.for && component.for !== viewerId);
                if (component.type === "select") {
                    return (
                        <ComponentSelect
                            key={index}
                            select={component}
                            disabled={notMine || Boolean(component.disabled) || busy !== null}
                            busy={busy === index}
                            title={notMine ? t("appCommands.onlyFor") : undefined}
                            onPick={(values) => press(index, undefined, values)}
                        />
                    );
                }
                return (
                    <Button
                        key={index}
                        size="sm"
                        variant={look.variant}
                        className={cn("min-w-0 max-w-full", look.className)}
                        disabled={notMine || Boolean(component.disabled) || busy !== null}
                        title={notMine ? t("appCommands.onlyFor") : undefined}
                        aria-busy={busy === index}
                        onClick={() => (component.type === "form" ? setForm(index) : void press(index))}
                    >
                        {busy === index ? (
                            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        ) : (
                            <ComponentIconMark name={component.icon} />
                        )}
                        <span className="truncate" title={component.label}>
                            {busy === index ? t("appCommands.working") : component.label}
                        </span>
                    </Button>
                );
            })}
            {opened?.type === "form" && form !== null && (
                <ComponentForm
                    key={`${messageId}:${form}`}
                    title={opened.title}
                    submit={opened.submit}
                    fields={opened.fields}
                    busy={busy === form}
                    onClose={() => setForm(null)}
                    onSubmit={async (fields) => {
                        if (await press(form, fields)) setForm(null);
                    }}
                />
            )}
        </div>
    );
}

function ComponentForm({
    title,
    submit,
    fields,
    busy,
    onClose,
    onSubmit
}: {
    title: string;
    submit: string;
    fields: readonly FormField[];
    busy: boolean;
    onClose: () => void;
    onSubmit: (fields: Record<string, string>) => Promise<void>;
}) {
    const t = useTranslations("chat");
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(fields.map((field) => [field.name, field.value ?? ""]))
    );
    // The same rule the server checks: a required field with nothing in it.
    const incomplete = fields.some((field) => field.required && !(values[field.name] ?? "").trim());
    const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!incomplete && !busy) void onSubmit(values);
                    }}
                >
                    {fields.map((field, at) => (
                        <label key={field.name} className="flex min-w-0 flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                                {field.label}
                                {field.required && <span aria-hidden> *</span>}
                            </span>
                            {field.kind === "choice" ? (
                                <Select
                                    value={values[field.name] ?? ""}
                                    onValueChange={(value) => set(field.name, value)}
                                    aria-label={field.label}
                                    options={(field.options ?? []).map((option) => ({
                                        value: option.value,
                                        label: option.label
                                    }))}
                                />
                            ) : field.kind === "long" ? (
                                <Textarea
                                    value={values[field.name] ?? ""}
                                    maxLength={field.max}
                                    rows={4}
                                    placeholder={field.placeholder}
                                    onChange={(event) => set(field.name, event.target.value)}
                                />
                            ) : (
                                <Input
                                    value={values[field.name] ?? ""}
                                    maxLength={field.max}
                                    autoFocus={at === 0}
                                    required={field.required}
                                    placeholder={field.placeholder}
                                    onChange={(event) => set(field.name, event.target.value)}
                                />
                            )}
                        </label>
                    ))}
                    <DialogFooter>
                        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                            {t("appCommands.cancel")}
                        </Button>
                        <Button type="submit" size="sm" aria-disabled={incomplete || busy} disabled={busy}>
                            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
                            {submit}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A select menu under a message. One choice sends on the pick, as Discord's
 * does; several are ticked in the menu and sent together.
 */
function ComponentSelect({
    select,
    disabled,
    busy,
    title,
    onPick
}: {
    select: SelectComponent;
    disabled: boolean;
    busy: boolean;
    title?: string;
    onPick: (values: readonly string[]) => Promise<boolean>;
}) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState<readonly string[]>(() =>
        select.options.filter((option) => option.default).map((option) => option.value)
    );
    const single = select.max === 1;
    const labelOf = (value: string) => select.options.find((option) => option.value === value)?.label ?? value;
    const shown =
        picked.length === 0
            ? (select.placeholder ?? t("appCommands.selectPlaceholder"))
            : picked.length === 1
              ? labelOf(picked[0]!)
              : t("appCommands.selected", { count: picked.length });
    const tooFew = picked.length < select.min;
    const toggle = (value: string) =>
        setPicked((current) =>
            current.includes(value)
                ? current.filter((one) => one !== value)
                : current.length < select.max
                  ? [...current, value]
                  : current
        );
    const send = async (values: readonly string[]) => {
        const previous = picked;
        setPicked(values);
        setOpen(false);
        // Put back what was showing when the server refuses it.
        if (!(await onPick(values))) setPicked(previous);
    };

    return (
        <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
            <PopoverTrigger asChild>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    title={title}
                    aria-busy={busy}
                    className="min-w-0 max-w-full justify-between sm:min-w-48"
                >
                    <span className={cn("truncate", picked.length === 0 && "text-muted-foreground")} title={shown}>
                        {busy ? t("appCommands.working") : shown}
                    </span>
                    {busy ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                    ) : (
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="flex max-h-80 w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 p-1">
                <div className="min-h-0 overflow-y-auto overscroll-contain" role="listbox" aria-multiselectable={!single}>
                    {select.options.map((option) => {
                        const on = picked.includes(option.value);
                        return (
                            <button
                                key={option.value}
                                type="button"
                                role="option"
                                aria-selected={on}
                                onClick={() => (single ? void send([option.value]) : toggle(option.value))}
                                className={cn(
                                    "flex w-full min-w-0 items-start gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-card-hover",
                                    on && "bg-muted"
                                )}
                            >
                                {!single && (
                                    <Checkbox checked={on} readOnly tabIndex={-1} aria-hidden className="mt-0.5" />
                                )}
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate" title={option.label}>
                                        {option.label}
                                    </span>
                                    {option.description && (
                                        <span className="truncate text-xs text-muted-foreground" title={option.description}>
                                            {option.description}
                                        </span>
                                    )}
                                </span>
                                {single && on && <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                            </button>
                        );
                    })}
                </div>
                {!single && (
                    <div className="flex justify-end border-t border-border p-1">
                        <Button size="sm" aria-disabled={tooFew} onClick={() => !tooFew && void send(picked)}>
                            {t("appCommands.apply")}
                        </Button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

/** Under an ephemeral message: who sees it, and the way to put it away. */
export function EphemeralNote({ messageId, onError }: { messageId: string; onError: (message: string) => void }) {
    const t = useTranslations("chat");
    const [busy, setBusy] = useState(false);
    return (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Eye className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t("appCommands.onlyYou")}</span>
            <span aria-hidden>-</span>
            <button
                type="button"
                disabled={busy}
                className="shrink-0 rounded text-primary underline-offset-2 hover:underline disabled:opacity-60"
                onClick={async () => {
                    setBusy(true);
                    const result = await runAction(() => actions.dismissEphemeralAction(messageId), onError);
                    setBusy(false);
                    if (result?.error) onError(result.error);
                }}
            >
                {t("appCommands.dismiss")}
            </button>
        </div>
    );
}
