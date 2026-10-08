"use client";

/**
 * Every key the calendar answers to, opened with `?` and from the settings.
 *
 * The same sheet every app in Polaris opens, on the calendar's own actions -
 * where a key can also be moved - so the calendar draws no table of its own.
 */

import { useCalendarT } from "./i18n";
import { hostUi } from "@polaris/app-host/client";

/** Said above the list when the calendar's keys are switched off. */
function OffNote({ enabled }: { enabled: boolean }) {
    const t = useCalendarT();
    return enabled ? null : <p className="text-xs text-muted-foreground">{t("shortcuts.off")}</p>;
}

/** The list itself, for the settings page. */
export function ShortcutsTable({ enabled }: { enabled: boolean }) {
    return (
        <div className="flex flex-col gap-4">
            <OffNote enabled={enabled} />
            <hostUi.shortcuts.ShortcutSettings app="calendar" />
        </div>
    );
}

export function ShortcutsDialog({
    open,
    onOpenChange,
    enabled
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    enabled: boolean;
}) {
    return (
        <hostUi.shortcuts.ShortcutsDialog
            app="calendar"
            open={open}
            onOpenChange={onOpenChange}
            note={<OffNote enabled={enabled} />}
        />
    );
}
