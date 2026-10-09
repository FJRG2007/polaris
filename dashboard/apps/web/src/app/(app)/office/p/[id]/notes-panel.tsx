"use client";

/**
 * The speaker notes under the slide, as in Google Slides and PowerPoint: a
 * field that says "Click to add speaker notes", folded away with one press and
 * remembered folded on this browser.
 *
 * Uncontrolled, like the words of a box: what somebody else types meanwhile
 * never moves this caret. Written a moment after typing stops and again on
 * leaving the field, so the presenter view in another window - and anybody
 * else in the deck - sees the notes while they are being written, without a
 * change on the wire per keystroke.
 */

import * as deck from "@/lib/office/deck";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** How long typing has to pause before the notes are written. */
const WRITE_AFTER_MS = 500;

const FOLDED_KEY = "polaris.office.slides.notesFolded";

function readFolded(): boolean | null {
    try {
        const kept = localStorage.getItem(FOLDED_KEY);
        return kept === null ? null : kept === "1";
    } catch {
        return null;
    }
}

function keepFolded(folded: boolean): void {
    try {
        localStorage.setItem(FOLDED_KEY, folded ? "1" : "0");
    } catch {
        // A browser that keeps nothing opens them unfolded next time.
    }
}

export function NotesPanel({
    slideId,
    notes,
    editable,
    onWrite
}: {
    slideId: string;
    notes: string;
    editable: boolean;
    /** Written with the slide they were typed on, which by the time they are
     *  written may no longer be the slide on screen. */
    onWrite: (slideId: string, text: string) => void;
}) {
    const t = useTranslations("office");
    // Folded on a phone unless somebody unfolded them there before: the slide
    // needs the room more. Read after mount, since the server has no screen.
    const [folded, setFolded] = useState(false);
    useEffect(() => {
        setFolded(readFolded() ?? !window.matchMedia("(min-width: 640px)").matches);
    }, []);

    const field = useRef<HTMLTextAreaElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const write = useRef(onWrite);
    write.current = onWrite;

    const flushField = (one: HTMLTextAreaElement | null): void => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (one && one.dataset.dirty === "1" && one.dataset.slide) {
            one.dataset.dirty = "0";
            write.current(one.dataset.slide, one.value);
        }
    };
    const flush = (): void => flushField(field.current);

    // The field is made again for every slide; the one going away - another
    // slide chosen, the notes folded, the deck left - writes what was typed in
    // it first, under its own slide.
    const attach = useCallback((one: HTMLTextAreaElement | null) => {
        if (field.current && field.current !== one) flushField(field.current);
        field.current = one;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
    }, []);

    // Somebody else's notes arrive in the field unless it is being typed in.
    useEffect(() => {
        const one = field.current;
        if (!one || document.activeElement === one) return;
        if (one.value !== notes) one.value = notes;
    }, [notes]);

    const toggle = (): void => {
        flush();
        setFolded((was) => {
            keepFolded(!was);
            return !was;
        });
    };

    if (!editable && !notes.trim()) return null;

    return (
        <div className="shrink-0 border-t border-border bg-background">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={!folded}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground hover:text-foreground"
            >
                {folded ? (
                    <ChevronUp className="size-3.5 shrink-0" aria-hidden />
                ) : (
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 truncate">{t("slides.notes.title")}</span>
            </button>
            {folded ? null : (
                <textarea
                    key={slideId}
                    ref={attach}
                    data-slide={slideId}
                    defaultValue={notes}
                    readOnly={!editable}
                    maxLength={deck.NOTES_MAX}
                    aria-label={t("slides.notes.title")}
                    placeholder={editable ? t("slides.notes.placeholder") : undefined}
                    spellCheck
                    onInput={(event) => {
                        event.currentTarget.dataset.dirty = "1";
                        if (timer.current) clearTimeout(timer.current);
                        timer.current = setTimeout(flush, WRITE_AFTER_MS);
                    }}
                    onBlur={flush}
                    className="block h-24 w-full resize-none bg-transparent px-3 pb-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground max-sm:h-20"
                />
            )}
        </div>
    );
}
