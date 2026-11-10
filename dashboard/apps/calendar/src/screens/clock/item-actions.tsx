"use client";

/**
 * What every alarm and timer offers from its "More" menu - edit, rename,
 * duplicate, send a copy, delete - and the two small dialogs behind rename and
 * send. The panels say what each one does; this only draws them the same way.
 */

import { useCalendarT } from "../i18n";
import * as model from "../../lib/clock/model";
import { useState, type ReactNode } from "react";
import { mutate, type ClockRead } from "./store";
import * as clockActions from "../../actions/clock";
import { TargetSearch, type Target } from "../sharing/share-dialog";
import { Copy, MoreHorizontal, Pencil, Send, TextCursorInput, Trash2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    useToast
} from "@polaris/ui";

export interface ItemActions {
    readonly onEdit: () => void;
    readonly onRename: () => void;
    readonly onDuplicate: () => void;
    readonly onSend: () => void;
    readonly onDelete: () => void;
}

/** The icon button and its menu. `extra` goes after Edit (an alarm's "Skip"). */
export function ItemMenu({
    actions,
    canDuplicate,
    extra
}: {
    actions: ItemActions;
    canDuplicate: boolean;
    extra?: ReactNode;
}) {
    const t = useCalendarT();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("time.more")}
                    title={t("time.more")}
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={actions.onEdit}>
                    <Pencil />
                    {t("time.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.onRename}>
                    <TextCursorInput />
                    {t("time.rename")}
                </DropdownMenuItem>
                {extra}
                <DropdownMenuItem disabled={!canDuplicate} onSelect={actions.onDuplicate}>
                    <Copy />
                    {t("time.duplicate")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={actions.onSend}>
                    <Send />
                    {t("time.sendCopy")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={actions.onDelete}>
                    <Trash2 />
                    {t("time.delete")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** A label, and nothing else, changed in place. */
export function RenameDialog({
    value,
    onSave,
    onClose
}: {
    value: string;
    onSave: (label: string) => Promise<boolean>;
    onClose: () => void;
}) {
    const t = useCalendarT();
    const [label, setLabel] = useState(value);
    const [busy, setBusy] = useState(false);
    const clean = label.trim();
    const tooLong = clean.length > model.CLOCK_LABEL_MAX;
    const unchanged = clean === value.trim();
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogTitle>{t("time.renameTitle")}</DialogTitle>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (busy || tooLong || unchanged) return;
                        setBusy(true);
                        const ok = await onSave(clean);
                        setBusy(false);
                        if (ok) onClose();
                    }}
                >
                    <label className="flex flex-col gap-1 text-[0.8125rem]">
                        <span>{t("time.label")}</span>
                        <Input
                            autoFocus
                            value={label}
                            maxLength={model.CLOCK_LABEL_MAX + 20}
                            aria-invalid={tooLong || undefined}
                            onChange={(event) => setLabel(event.target.value)}
                        />
                        {tooLong ? (
                            <span className="text-xs text-danger">
                                {t("time.labelTooLong", { max: model.CLOCK_LABEL_MAX })}
                            </span>
                        ) : null}
                    </label>
                    <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                            {t("time.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={tooLong || unchanged || busy}
                            disabled={busy}
                        >
                            {t("time.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Pick a person and send them their own copy of an alarm or a timer. */
export function SendCopyDialog({
    clock,
    kind,
    id,
    onClose
}: {
    clock: ClockRead;
    kind: "alarm" | "timer";
    id: string;
    onClose: () => void;
}) {
    const t = useCalendarT();
    const toast = useToast();
    const [target, setTarget] = useState<Target | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-md">
                <DialogTitle>{t("time.share.title")}</DialogTitle>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (busy || !target) return;
                        setBusy(true);
                        const ok = await mutate(
                            clock,
                            () => clockActions.sendClockCopyAction({ kind, id, to: target.id }),
                            null,
                            (message) =>
                                toast.show({
                                    key: "calendar-time",
                                    title: message || t("screen.failed")
                                })
                        );
                        setBusy(false);
                        if (!ok) return;
                        toast.show({
                            key: "calendar-time",
                            title: t("time.share.sent", { name: target.name })
                        });
                        onClose();
                    }}
                >
                    <p className="text-[0.8125rem] text-muted-foreground">
                        {kind === "alarm" ? t("time.share.alarmBody") : t("time.share.timerBody")}
                    </p>
                    <TargetSearch
                        value={target}
                        onChange={setTarget}
                        peopleOnly
                        label={t("time.share.to")}
                    />
                    <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                            {t("time.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!target || busy} disabled={busy}>
                            <Send />
                            {t("time.share.send")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
