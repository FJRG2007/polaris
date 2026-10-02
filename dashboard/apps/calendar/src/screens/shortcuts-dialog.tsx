"use client";

/** Every key the calendar answers to, opened with `?` and from the settings. */

import { useCalendarT } from "./i18n";
import {
    CLIPBOARD_SHORTCUT_ROWS,
    EDITOR_SHORTCUT_ROWS,
    GRID_SHORTCUT_ROWS,
    SHORTCUT_ROWS
} from "./shortcuts";
import {
    applePlatform,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

function Keys({ keys, modifier }: { keys: readonly string[]; modifier?: string }) {
    const t = useCalendarT();
    return (
        <span className="flex flex-wrap items-center justify-end gap-1">
            {keys.map((key, index) => (
                <span key={key} className="flex items-center gap-1">
                    {index > 0 ? (
                        <span className="text-xs text-foreground-subtle">{t("shortcuts.or")}</span>
                    ) : null}
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                        {modifier ? `${modifier}+` : ""}
                        {key}
                    </kbd>
                </span>
            ))}
        </span>
    );
}

/** The table itself, shared by the dialog and the settings page. */
export function ShortcutsTable({ enabled }: { enabled: boolean }) {
    const t = useCalendarT();
    const modifier = typeof navigator !== "undefined" && applePlatform() ? "Cmd" : "Ctrl";
    return (
        <div className="flex flex-col gap-4">
            {!enabled ? (
                <p className="text-xs text-muted-foreground">{t("shortcuts.off")}</p>
            ) : null}
            <table className="w-full text-[0.8125rem]">
                <thead>
                    <tr>
                        <th className="pb-1 text-left">{t("shortcuts.action")}</th>
                        <th className="pb-1 text-right">{t("shortcuts.keys")}</th>
                    </tr>
                </thead>
                <tbody>
                    {SHORTCUT_ROWS.map((row) => (
                        <tr key={row.label} className="border-t border-border">
                            <td className="py-1.5 pr-3">{t(`shortcuts.labels.${row.label}`)}</td>
                            <td className="py-1.5">
                                <Keys keys={row.keys} />
                            </td>
                        </tr>
                    ))}
                    {GRID_SHORTCUT_ROWS.map((row) => (
                        <tr key={`grid-${row.label}`} className="border-t border-border">
                            <td className="py-1.5 pr-3">{t(`shortcuts.labels.${row.label}`)}</td>
                            <td className="py-1.5">
                                <Keys keys={row.keys} />
                            </td>
                        </tr>
                    ))}
                    {CLIPBOARD_SHORTCUT_ROWS.map((row) => (
                        <tr key={`clipboard-${row.label}`} className="border-t border-border">
                            <td className="py-1.5 pr-3">{t(`shortcuts.labels.${row.label}`)}</td>
                            <td className="py-1.5">
                                <Keys keys={row.keys} modifier={modifier} />
                            </td>
                        </tr>
                    ))}
                    {EDITOR_SHORTCUT_ROWS.map((row) => (
                        <tr key={`editor-${row.keys[0]}`} className="border-t border-border">
                            <td className="py-1.5 pr-3">{t(`shortcuts.labels.${row.label}`)}</td>
                            <td className="py-1.5">
                                <Keys keys={row.keys} modifier={modifier} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
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
    const t = useCalendarT();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-full max-w-md">
                <DialogHeader className="pr-8">
                    <DialogTitle>{t("shortcuts.title")}</DialogTitle>
                    <DialogDescription>{t("shortcuts.description")}</DialogDescription>
                </DialogHeader>
                <ShortcutsTable enabled={enabled} />
            </DialogContent>
        </Dialog>
    );
}
