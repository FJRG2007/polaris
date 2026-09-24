/**
 * The small marks the popup draws inside its buttons.
 *
 * Kept apart from the screens so each one is drawn in one place: the copy mark
 * on a login's line and the copy button on the generator are the same mark, and
 * two copies of an icon are how two buttons that do the same thing end up looking
 * as if they do different things. Every one is `aria-hidden` - the button around
 * it carries the name.
 */

/**
 * The mark on a line that can be copied.
 *
 * Hidden until the row is hovered or something in it has focus, which is what
 * lets a login be three readable lines instead of a name and a row of buttons
 * named after the thing they copy. `aria-hidden`, because the line it sits in is
 * already a button with a name of its own - announcing it again would read the
 * same action twice.
 */
export function CopyMark(): React.JSX.Element {
    return (
        <svg className="copy-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
    );
}

/** What the copy mark turns into once the value is on the clipboard: a green
 *  check that pops in, as Polaris's copy buttons do. */
export function CheckMark(): React.JSX.Element {
    return (
        <svg className="copy-mark done" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
        </svg>
    );
}

/** Make another: two arrows chasing each other round. */
export function AgainMark(): React.JSX.Element {
    return (
        <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
            <path d="M3 21v-5h5" />
            <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
            <path d="M21 3v5h-5" />
        </svg>
    );
}

/** Show what is hidden: an open eye, or a struck-through one for hiding it. */
export function EyeMark({ struck }: { struck: boolean }): React.JSX.Element {
    return (
        <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {struck ? <path d="m3 3 18 18" /> : null}
        </svg>
    );
}

/** Put it away: the chevron that folds a panel back up. */
export function FoldMark(): React.JSX.Element {
    return (
        <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m18 15-6-6-6 6" />
        </svg>
    );
}
