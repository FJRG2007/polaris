/**
 * How a surface that floats arrives and leaves.
 *
 * Menus, submenus and selects all open from something the reader just pressed,
 * so they come in from that side - a few pixels, faded - and that is what tells
 * the eye which control the list belongs to. They leave faster than they came:
 * a closing menu is already in the way of whatever was chosen. One string, so the
 * dropdown, the right-click menu and the select cannot drift apart, and the
 * duration and the curve are the design system's own (see tokens.css), so a
 * reader who asked for less motion gets none of it.
 */
export const FLOATING_MOTION =
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1";
