/**
 * The tabs of a Code session's terminal: the agent's own, always first, and the
 * extra shells somebody opened beside it. A tab is a number that is never reused,
 * so a closed shell's terminal is never handed to a new tab. Pure, so it is
 * asserted in a test.
 */

/** Shells one session's terminal may hold open beside the agent. */
export const SHELL_TABS_MAX = 6;

export interface ShellTabs {
    /** The open shells, in the order they were opened. */
    readonly shells: readonly number[];
    /** The tab on screen: `agent`, or a shell's number. */
    readonly active: "agent" | number;
    /** The number the next shell takes. */
    readonly next: number;
}

export const NO_SHELL_TABS: ShellTabs = { shells: [], active: "agent", next: 1 };

/** One more shell, brought forward. Unchanged at the ceiling. */
export function openShellTab(tabs: ShellTabs): ShellTabs {
    if (tabs.shells.length >= SHELL_TABS_MAX) return tabs;
    return { shells: [...tabs.shells, tabs.next], active: tabs.next, next: tabs.next + 1 };
}

/** A shell closed; the one before it comes forward when it was on screen. */
export function closeShellTab(tabs: ShellTabs, shell: number): ShellTabs {
    const at = tabs.shells.indexOf(shell);
    if (at === -1) return tabs;
    const shells = tabs.shells.filter((one) => one !== shell);
    if (tabs.active !== shell) return { ...tabs, shells };
    return { ...tabs, shells, active: shells[at - 1] ?? shells[at] ?? "agent" };
}
