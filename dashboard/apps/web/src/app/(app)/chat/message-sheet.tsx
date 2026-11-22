"use client";

/**
 * A message's actions on a touch screen, rising from the bottom edge the way
 * Discord and WhatsApp open them on a phone after a long press.
 *
 * The faces first, in a row of big tiles with the full picker at the end, then
 * the same groups the right-click menu has (`MessageMenu` builds both from one
 * list - see `message-menu-model.ts`), each a rounded card of full-width lines,
 * the heavy ones last. A submenu - the reminder times, a recording's formats -
 * replaces the list in place with a way back, rather than opening a second
 * sheet over the first.
 *
 * Tapping the dimmed page, pressing Escape or pulling the sheet down by its top
 * closes it. It scrolls when it is taller than the screen, and keeps clear of
 * the phone's home bar.
 */

import * as core from "@polaris/core";
import { EmojiFace, type CustomEmojiSet } from "@/components/rich-text/custom-emoji";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronLeft, ChevronRight, SmilePlus } from "lucide-react";
import { useRef, useState, createContext, useContext, type ReactNode } from "react";
import {
    cn,
    Dialog,
    DialogContent,
    DialogTitle,
    keepFocusOnClose,
    type DropdownMenuItem
} from "@polaris/ui";
import {
    filled,
    type MenuEntry,
    type MenuModel,
    type MenuParts,
    type MenuSection
} from "./message-menu-model";

/** How far the sheet has to be pulled down to close when it is let go. */
const PULL_TO_CLOSE = 80;

const ROW =
    "flex min-h-12 w-full min-w-0 items-center gap-3 px-4 text-start text-sm text-foreground transition-colors active:bg-card-hover disabled:opacity-50 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
const CARD = "flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card";

/** Closes the sheet once a line has done its work. */
const Done = createContext<() => void>(() => undefined);

export function MessageSheet({
    open,
    onOpenChange,
    model,
    emojiSet
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    model: MenuModel;
    emojiSet: CustomEmojiSet | null;
}) {
    const t = useTranslations("chat");
    /** The submenu standing in for the list, when one was opened. */
    const [page, setPage] = useState<MenuEntry | null>(null);
    const sheet = useRef<HTMLDivElement>(null);
    const pull = useRef<{ y: number; id: number } | null>(null);

    /** Every way it closes goes back to the list for the next time. */
    const change = (next: boolean) => {
        if (!next) setPage(null);
        onOpenChange(next);
    };
    const close = () => change(false);

    const moveTo = (dy: number) => {
        if (sheet.current) sheet.current.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    };

    const reactions = model.reactions;
    return (
        <Dialog open={open} onOpenChange={change}>
            <DialogContent
                ref={sheet}
                phone="keep"
                showClose={false}
                aria-describedby={undefined}
                onCloseAutoFocus={keepFocusOnClose}
                className="bottom-0 left-0 right-0 top-auto mx-auto flex max-h-[85dvh] w-full max-w-lg translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-b-none rounded-t-2xl border-x-0 border-b-0 p-0 pb-[var(--safe-bottom)] sm:border-x data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:slide-in-from-bottom-8"
            >
                <DialogTitle className="sr-only">{t("messageMenu.actions")}</DialogTitle>
                {/* The handle: pulling it down closes the sheet. */}
                <div
                    className="flex shrink-0 touch-none justify-center pb-2 pt-3"
                    onPointerDown={(event) => {
                        pull.current = { y: event.clientY, id: event.pointerId };
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                        if (pull.current?.id === event.pointerId)
                            moveTo(event.clientY - pull.current.y);
                    }}
                    onPointerUp={(event) => {
                        const from = pull.current;
                        pull.current = null;
                        moveTo(0);
                        if (from && event.clientY - from.y > PULL_TO_CLOSE) close();
                    }}
                    onPointerCancel={() => {
                        pull.current = null;
                        moveTo(0);
                    }}
                >
                    <span aria-hidden className="h-1 w-10 rounded-full bg-border-strong" />
                </div>
                <Done.Provider value={close}>
                    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-3 pb-3">
                        {page ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setPage(null)}
                                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1 text-start text-sm font-medium text-foreground active:bg-card-hover"
                                >
                                    <ChevronLeft aria-hidden className="size-5 shrink-0" />
                                    <span className="sr-only">{t("messageMenu.back")}</span>
                                    <span className="min-w-0 truncate" title={page.title}>
                                        {page.label}
                                    </span>
                                </button>
                                {(page.sub ?? [])
                                    .filter((group) => group.length > 0)
                                    .map((group, index) => (
                                        <div key={index} className={CARD}>
                                            {group.map((entry) => (
                                                <SheetEntry
                                                    key={entry.key}
                                                    entry={entry}
                                                    onPage={setPage}
                                                />
                                            ))}
                                        </div>
                                    ))}
                            </>
                        ) : (
                            <>
                                {filled(model.target).map((section) => (
                                    <SheetSection
                                        key={section.key}
                                        section={section}
                                        onPage={setPage}
                                    />
                                ))}
                                {reactions && (reactions.quick.length > 0 || reactions.more) && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        {reactions.quick.map((choice) => {
                                            const ref = core.parseCustomEmojiToken(choice);
                                            const named = ref
                                                ? core.customEmojiFallback(ref)
                                                : choice;
                                            return (
                                                <button
                                                    key={choice}
                                                    type="button"
                                                    aria-label={t("messageList.reactWith", {
                                                        emoji: named
                                                    })}
                                                    onClick={() => {
                                                        reactions.react(choice);
                                                        close();
                                                    }}
                                                    className="flex size-12 shrink-0 items-center justify-center rounded-full bg-card text-2xl active:bg-card-hover"
                                                >
                                                    <EmojiFace value={choice} set={emojiSet} />
                                                </button>
                                            );
                                        })}
                                        {reactions.more && (
                                            <button
                                                type="button"
                                                aria-label={t("messageMenu.addReaction")}
                                                onClick={() => {
                                                    close();
                                                    reactions.more?.();
                                                }}
                                                className="flex size-12 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground active:bg-card-hover"
                                            >
                                                <SmilePlus className="size-5" />
                                            </button>
                                        )}
                                    </div>
                                )}
                                {filled(model.sections).map((section) => (
                                    <SheetSection
                                        key={section.key}
                                        section={section}
                                        onPage={setPage}
                                    />
                                ))}
                            </>
                        )}
                    </div>
                </Done.Provider>
            </DialogContent>
        </Dialog>
    );
}

function SheetSection({
    section,
    onPage
}: {
    section: MenuSection;
    onPage: (entry: MenuEntry) => void;
}) {
    return (
        <div className={CARD} data-section={section.key}>
            {section.draw?.(SHEET_PARTS)}
            {section.entries?.map((entry) => (
                <SheetEntry key={entry.key} entry={entry} onPage={onPage} />
            ))}
        </div>
    );
}

function SheetEntry({ entry, onPage }: { entry: MenuEntry; onPage: (entry: MenuEntry) => void }) {
    const done = useContext(Done);
    const Icon = entry.icon;
    const body = (
        <>
            {Icon && <Icon aria-hidden />}
            <span className="min-w-0 flex-1 truncate" title={entry.title}>
                {entry.label}
            </span>
            {entry.trailing && (
                <span className="shrink-0 text-xs text-foreground-subtle">{entry.trailing}</span>
            )}
            {entry.sub && <ChevronRight aria-hidden />}
        </>
    );
    const tone = cn(ROW, entry.danger && "text-danger [&>svg]:text-danger");
    if (entry.link)
        return (
            <a
                href={entry.link.href}
                download={entry.link.download}
                data-action={entry.key}
                onClick={done}
                className={tone}
            >
                {body}
            </a>
        );
    return (
        <button
            type="button"
            disabled={entry.disabled}
            data-action={entry.key}
            data-danger={entry.danger ? "" : undefined}
            onClick={(event) => {
                if (entry.sub) return onPage(entry);
                entry.run?.(event.shiftKey);
                done();
            }}
            className={tone}
        >
            {body}
        </button>
    );
}

/**
 * A line of the sheet standing in for a menu item, for the sections already
 * written as menu items (a picture's). It takes the menu item's `onSelect` and
 * `variant` and nothing else those sections use.
 */
function SheetItem({
    onSelect,
    variant,
    disabled,
    children
}: {
    onSelect?: (event: Event) => void;
    variant?: string;
    disabled?: boolean;
    children?: ReactNode;
}) {
    const done = useContext(Done);
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={() => {
                onSelect?.(new Event("select"));
                done();
            }}
            className={cn(ROW, variant === "danger" && "text-danger [&>svg]:text-danger")}
        >
            {children}
        </button>
    );
}

/** Groups are cards in the sheet, so a separator inside one draws nothing. */
function SheetSeparator() {
    return null;
}

const SHEET_PARTS: MenuParts = {
    Item: SheetItem as unknown as typeof DropdownMenuItem,
    Separator: SheetSeparator as unknown as MenuParts["Separator"]
};
