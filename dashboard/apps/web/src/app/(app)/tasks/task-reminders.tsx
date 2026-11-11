"use client";

/**
 * "Remind me" on a task, the way a chat message offers it: a few presets read
 * on the account's own clock, and a custom time.
 *
 * The same presets and the same dialog as Chat (`reminder-times.ts`,
 * `schedule-dialog.tsx`), so "tomorrow" is nine in the morning in both. The row
 * menu and the task's own header each draw the presets with their own menu item,
 * and share what a pick does.
 */

import { AlarmClock, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ScheduleDialog } from "@/app/(app)/chat/schedule-dialog";
import { useDisplayFormat, useDisplayPreferences } from "@/components/display-format";
import {
    REMINDER_PRESETS,
    reminderMoment,
    type ReminderPreset
} from "@/app/(app)/chat/reminder-times";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    keepFocusOnClose,
    useToast
} from "@polaris/ui";

/** A pending reminder, as the server lists it. */
export interface PendingReminder {
    readonly id: string;
    readonly remindAt: string;
}

/**
 * The server actions, fetched on first use. Every task row draws this menu, and
 * importing them up front pulled the server's configuration into every screen
 * and test that draws a row.
 */
const serverActions = () => import("./actions");

const PRESET_LABELS = {
    in15Minutes: "reminders.in15Minutes",
    in1Hour: "reminders.in1Hour",
    in3Hours: "reminders.in3Hours",
    tomorrow: "reminders.tomorrow",
    nextMonday: "reminders.nextMonday"
} as const satisfies Record<ReminderPreset, string>;

/** What a pick does: set it, and say back when it is for. The custom-time dialog
 *  is returned to be drawn by the caller, since it outlives the menu. */
export function useTaskReminder(taskId: string, onSet?: () => void) {
    const t = useTranslations("tasksDetail");
    const tt = useTranslations("tasks");
    const format = useDisplayFormat();
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [choosing, setChoosing] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const remind = async (when: Date): Promise<boolean> => {
        setBusy(true);
        const result = await serverActions()
            .then((actions) => actions.addReminderAction(taskId, when.toISOString(), ""))
            .catch(() => ({ error: tt("errors.setReminder") }));
        setBusy(false);
        if (result.error) {
            if (choosing) setError(result.error);
            else toast.show({ title: result.error });
            return false;
        }
        toast.show({
            title: t("reminders.set", { date: format.date(when), time: format.time(when) })
        });
        onSet?.();
        return true;
    };

    const dialog = (
        <ScheduleDialog
            open={choosing}
            onOpenChange={(open) => {
                setChoosing(open);
                if (!open) setError(undefined);
            }}
            presets={false}
            busy={busy}
            error={error}
            words={{
                title: t("reminders.title"),
                description: t("reminders.description"),
                confirm: t("reminders.confirm"),
                busy: t("reminders.busy"),
                summary: (date, time) => t("reminders.summary", { date, time })
            }}
            onConfirm={(at) =>
                void remind(new Date(at)).then((done) => done && setChoosing(false))
            }
        />
    );

    return { remind, busy, choose: () => setChoosing(true), dialog };
}

/** Any menu's item: the row's context menu and the header's dropdown both fit. */
type MenuItem = (props: {
    onSelect?: () => void;
    disabled?: boolean;
    children?: ReactNode;
}) => ReactNode;

/** The presets, then "Custom...", drawn with the menu's own item. */
export function ReminderPresetItems({
    Item,
    Separator,
    busy,
    onPick,
    onCustom
}: {
    Item: MenuItem;
    Separator: (props: { className?: string }) => ReactNode;
    busy: boolean;
    onPick: (when: Date) => void;
    onCustom: () => void;
}) {
    const t = useTranslations("tasksDetail");
    const format = useDisplayFormat();
    const { timeZone } = useDisplayPreferences();
    return (
        <>
            {REMINDER_PRESETS.map((preset) => {
                const moment = reminderMoment(preset, new Date(), timeZone);
                const clock = preset === "tomorrow" || preset === "nextMonday";
                return (
                    <Item key={preset} disabled={busy} onSelect={() => onPick(moment)}>
                        <span className="min-w-0 truncate">{t(PRESET_LABELS[preset])}</span>
                        {clock && (
                            <span className="ml-auto shrink-0 pl-4 text-xs text-foreground-subtle">
                                {format.time(moment)}
                            </span>
                        )}
                    </Item>
                );
            })}
            <Separator />
            <Item onSelect={onCustom}>{t("reminders.custom")}</Item>
        </>
    );
}

/** The header's "Remind me": the reader's pending reminders on this task, each
 *  one called off from here, above the presets. Read when it opens. */
export function TaskReminderButton({ taskId }: { taskId: string }) {
    const t = useTranslations("tasksDetail");
    const tt = useTranslations("tasks");
    const format = useDisplayFormat();
    const toast = useToast();
    const [pending, setPending] = useState<readonly PendingReminder[] | null>(null);

    const load = async () => {
        const result = await serverActions()
            .then((actions) => actions.taskRemindersAction(taskId))
            .catch(() => ({ error: tt("errors.loadReminders"), reminders: undefined }));
        if (result.reminders) setPending(result.reminders);
        else if (result.error) toast.show({ title: result.error });
    };
    const reminder = useTaskReminder(taskId, () => void load());

    const cancel = async (row: PendingReminder) => {
        const before = pending;
        setPending((rows) => rows?.filter((entry) => entry.id !== row.id) ?? null);
        const result = await serverActions()
            .then((actions) => actions.deleteReminderAction(row.id))
            .catch(() => ({ error: tt("errors.cancelReminder") }));
        if (result.error) {
            setPending(before);
            toast.show({ title: result.error });
        }
    };

    const due = (row: PendingReminder) => {
        const when = new Date(row.remindAt);
        return t("reminders.due", { date: format.date(when), time: format.time(when) });
    };

    return (
        <>
            {reminder.dialog}
            <DropdownMenu onOpenChange={(open) => open && void load()}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={t("reminders.remindMe")}
                        title={t("reminders.remindMe")}
                        className="relative rounded-md p-1.5 text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground active:bg-muted/70 data-[state=open]:bg-muted data-[state=open]:text-foreground"
                    >
                        <AlarmClock className="size-4" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="end"
                    className="w-60"
                    onCloseAutoFocus={keepFocusOnClose}
                >
                    {pending && pending.length > 0 && (
                        <>
                            <DropdownMenuLabel>{t("reminders.pending")}</DropdownMenuLabel>
                            {pending.map((row) => (
                                <DropdownMenuItem
                                    key={row.id}
                                    aria-label={t("reminders.cancel", { when: due(row) })}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        void cancel(row);
                                    }}
                                >
                                    <span className="min-w-0 truncate">{due(row)}</span>
                                    <X className="ml-auto size-3.5 shrink-0" />
                                </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <ReminderPresetItems
                        Item={DropdownMenuItem}
                        Separator={DropdownMenuSeparator}
                        busy={reminder.busy}
                        onPick={(when) => void reminder.remind(when)}
                        onCustom={reminder.choose}
                    />
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}
