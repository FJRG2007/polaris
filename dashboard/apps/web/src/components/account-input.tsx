"use client";

/**
 * A field that names Polaris accounts, with the list of them under the caret.
 *
 * What these fields store is the identity the server matches on later - a
 * username or an email address - so this stays a text field rather than becoming
 * a picker of ids: an address with no account behind it yet is still a valid
 * thing to type where a field invites somebody. All it adds is the list, so
 * nobody has to remember how a colleague spelled their username, and typing "@"
 * opens it the way it does in a description.
 *
 * Uncontrolled by default, because the forms that use it read themselves through
 * FormData and would otherwise all have to grow a piece of state. Picking a name
 * writes through the DOM and fires the same input event a keystroke would, which
 * is what a Save button watching the form for edits is listening for.
 *
 * The list is drawn in a portal, anchored to the field. It has to be: half these
 * fields are inside a dialog, and a dialog scrolls its own content, which means
 * an absolutely positioned list inside one is clipped by it - the suggestions
 * end up below the fold of the dialog, and the field reads as having no
 * autocomplete at all. Fixed positioning is outside every ancestor's clip.
 */

import { cn, Input } from "@polaris/ui";
import { createPortal } from "react-dom";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { TOKEN_SEPARATOR, tokenAt } from "@/lib/token-field";
import { searchAccountsAction } from "@/app/(app)/mention-actions";
import type { AccountCandidate } from "@/lib/rich-text/mention-service";
import { POPUP_CLASS, POPUP_ITEM_CLASS } from "@/components/rich-text/suggestion";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

/** Long enough that the list is not rewritten on every letter, short enough that
 *  it still feels like it is answering the one being typed. */
const DEBOUNCE_MS = 160;

export interface AccountInputProps {
    /** Form field name, for a form read through FormData. */
    name?: string;
    defaultValue?: string;
    /** Set these two together to drive the field from state instead. */
    value?: string;
    onValueChange?: (value: string) => void;
    /**
     * The account behind a row somebody chose from the list.
     *
     * For a field that does something with the person rather than only storing
     * what they are called - looking up the game account they linked, offering
     * the addresses they sign in from. A name that was typed rather than chosen
     * never fires this, because nothing has said which account it is.
     */
    onPick?: (account: AccountCandidate) => void;
    /**
     * Enter pressed with no list open.
     *
     * The field sits in a form, so Enter would submit it. A caller that acts on
     * what was typed - the name nobody picked off the list - is told here instead.
     */
    onEnter?: () => void;
    placeholder?: string;
    /** Several accounts in one field, separated by commas. */
    multiple?: boolean;
    autoFocus?: boolean;
    disabled?: boolean;
    className?: string;
    id?: string;
    "aria-label"?: string;
}

/**
 * Write a value the way a keystroke would.
 *
 * Assigning to `input.value` updates the DOM but leaves React's own change
 * tracking convinced the field never moved, so the synthetic event never fires
 * and a form watching itself for edits never hears that one was made. Going
 * through the prototype's setter is what makes the change visible to both.
 */
function writeValue(node: HTMLInputElement, next: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(node, next);
    else node.value = next;
    node.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The identity to store for an account: its username, or its address when it
 *  never chose one. Both are accepted wherever these fields are checked. */
function identityOf(account: AccountCandidate): string {
    return account.username || account.email;
}

export function AccountInput({
    name,
    defaultValue,
    value,
    onValueChange,
    onPick,
    onEnter,
    placeholder,
    multiple = false,
    autoFocus = false,
    disabled = false,
    className,
    id,
    "aria-label": ariaLabel
}: AccountInputProps) {
    const listId = useId();
    const field = useRef<HTMLInputElement | null>(null);
    /** Where to draw the list. Null before the first measurement, and while the
     *  list is shut. */
    const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
    const [results, setResults] = useState<AccountCandidate[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);

    // Which lookup the answers on screen belong to. An answer that arrives after
    // the next letter has been typed describes a query nobody is asking any more.
    const asked = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Set while this field writes to itself. The write announces itself as an
    // edit, which is the point, but that announcement comes back through the
    // change handler and would open the list again on the name just chosen.
    const writing = useRef(false);

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);

    const showing = open && results.length > 0;

    /**
     * Follow the field.
     *
     * Measured on a layout effect so the list is never painted at the previous
     * position, and re-measured on any scroll - `true` for the capture phase,
     * because the thing that scrolls is usually an ancestor rather than the
     * window, and a listener on the window alone would never hear it.
     */
    useLayoutEffect(() => {
        if (!showing) {
            setAnchor(null);
            return;
        }
        const measure = (): void => {
            const node = field.current;
            if (!node) return;
            const box = node.getBoundingClientRect();
            setAnchor({ left: box.left, top: box.bottom + 4, width: box.width });
        };
        measure();
        window.addEventListener("scroll", measure, true);
        window.addEventListener("resize", measure);
        return () => {
            window.removeEventListener("scroll", measure, true);
            window.removeEventListener("resize", measure);
        };
    }, [showing]);

    /** Look the token under the caret up, after the typing has paused. */
    function refresh(): void {
        const node = field.current;
        if (!node || disabled) return;
        const token = tokenAt(node.value, node.selectionStart ?? node.value.length, multiple);
        // The "@" people are used to writing in a description is welcome here and
        // is not part of the identity, so it opens the list without narrowing it.
        const query = token.value.replace(/^@+/, "");
        if (timer.current) clearTimeout(timer.current);

        // Nothing typed in this slot and no "@" asking for the list: the field is
        // empty or the caret is between two names, which is not a question.
        if (query === "" && !token.value.startsWith("@")) {
            setOpen(false);
            setResults([]);
            return;
        }

        const ticket = ++asked.current;
        timer.current = setTimeout(async () => {
            const answer = await runAction(() => searchAccountsAction({ query }), () => undefined);
            if (ticket !== asked.current) return;
            const found = answer?.results ?? [];
            setResults(found);
            setActive(0);
            setOpen(found.length > 0);
        }, DEBOUNCE_MS);
    }

    /** Put an account into the slot the caret is in. */
    function choose(account: AccountCandidate): void {
        const node = field.current;
        if (!node) return;
        const text = node.value;
        const token = tokenAt(text, node.selectionStart ?? text.length, multiple);
        const identity = identityOf(account);
        // A field that holds several gets the comma it is about to need, unless
        // the next name is already sitting there behind one.
        const tail = text.slice(token.end);
        const separate = multiple && !TOKEN_SEPARATOR.test(tail.charAt(0));
        const next = `${text.slice(0, token.start)}${identity}${separate ? ", " : ""}${tail}`;
        const caret = token.start + identity.length + (separate ? 2 : 0);

        // Anything still on its way describes the half-typed name that has just
        // been replaced, so it is dropped rather than allowed to reopen the list.
        if (timer.current) clearTimeout(timer.current);
        asked.current += 1;
        setOpen(false);
        setResults([]);
        if (onValueChange) {
            onValueChange(next);
        } else {
            writing.current = true;
            try {
                writeValue(node, next);
            } finally {
                writing.current = false;
            }
        }
        node.focus();
        // A controlled field has not been given the new value yet, so moving the
        // caret is left until React has written it.
        if (!onValueChange) node.setSelectionRange(caret, caret);
        // Last, so whatever this starts sees the field already holding the name.
        onPick?.(account);
    }

    function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
        if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
            return;
        }
        if (!open || results.length === 0) {
            // Nothing to take off a list that is not there, so Enter belongs to
            // whoever is listening for it - and to the form otherwise.
            if (event.key === "Enter" && onEnter) {
                event.preventDefault();
                onEnter();
            }
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((current) => (current + 1) % results.length);
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => (current + results.length - 1) % results.length);
            return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
            const account = results[active];
            if (!account) return;
            // Enter would submit the form this field is sitting in, and Tab would
            // leave it, before the name it is showing had been taken.
            event.preventDefault();
            choose(account);
        }
    }

    return (
        <div className="relative">
            <Input
                id={id}
                ref={field}
                name={name}
                value={value}
                defaultValue={defaultValue}
                placeholder={placeholder}
                disabled={disabled}
                autoFocus={autoFocus}
                autoComplete="off"
                aria-label={ariaLabel}
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                role="combobox"
                className={className}
                onChange={(event) => {
                    if (writing.current) return;
                    onValueChange?.(event.target.value);
                    refresh();
                }}
                onKeyUp={(event) => {
                    // The caret moved along the line without the value changing,
                    // so the entry it sits in - and the list that belongs to that
                    // entry - moved with it. Up and down are the list's own keys
                    // while it is open and must not restart the search.
                    const moved =
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight" ||
                        event.key === "Home" ||
                        event.key === "End";
                    if (moved) refresh();
                }}
                // Given up on rather than closed: the click that opened whatever
                // took the focus is already handled by the row's own mouse down.
                onBlur={() => setOpen(false)}
                onKeyDown={onKeyDown}
            />
            {showing && anchor
                ? createPortal(
                <ul
                    id={listId}
                    role="listbox"
                    // Above the dialog it is usually inside, which sits at z-50.
                    style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
                    className={cn(POPUP_CLASS, "fixed z-[60]")}
                >
                    {results.map((account, index) => {
                        const identity = identityOf(account);
                        return (
                            <li key={account.id}>
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={index === active}
                                    // Mouse down rather than click: the blur that
                                    // follows would have closed the list before a
                                    // click ever landed.
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        choose(account);
                                    }}
                                    onMouseEnter={() => setActive(index)}
                                    className={cn(
                                        POPUP_ITEM_CLASS,
                                        index === active ? "bg-muted" : "hover:bg-muted/60"
                                    )}
                                >
                                    <Avatar
                                        person={{ id: account.id, name: account.name, image: account.image }}
                                        size={20}
                                    />
                                    <span className="min-w-0 flex-1 truncate" title={account.name}>
                                        {account.name}
                                    </span>
                                    <span
                                        className="max-w-[9rem] shrink-0 truncate text-[0.6875rem] text-muted-foreground"
                                        title={identity}
                                    >
                                        {identity}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>,
                document.body
              )
                : null}
        </div>
    );
}
