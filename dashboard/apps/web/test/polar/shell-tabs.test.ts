import { describe, expect, it } from "vitest";
import { NO_SHELL_TABS, SHELL_TABS_MAX, closeShellTab, openShellTab } from "@/components/polar/shell-tabs";

describe("shell tabs", () => {
    it("opens a shell and brings it forward", () => {
        const tabs = openShellTab(openShellTab(NO_SHELL_TABS));
        expect(tabs).toEqual({ shells: [1, 2], active: 2, next: 3 });
    });

    it("never reuses a closed shell's number", () => {
        const tabs = openShellTab(closeShellTab(openShellTab(NO_SHELL_TABS), 1));
        expect(tabs.shells).toEqual([2]);
    });

    it("brings the tab before forward when the one on screen closes", () => {
        const three = openShellTab(openShellTab(openShellTab(NO_SHELL_TABS)));
        expect(closeShellTab(three, 3).active).toBe(2);
        expect(closeShellTab({ ...three, active: 1 }, 1).active).toBe(2);
        expect(closeShellTab(openShellTab(NO_SHELL_TABS), 1).active).toBe("agent");
    });

    it("keeps the tab on screen when another closes, and ignores an unknown one", () => {
        const three = openShellTab(openShellTab(openShellTab(NO_SHELL_TABS)));
        expect(closeShellTab(three, 1)).toEqual({ shells: [2, 3], active: 3, next: 4 });
        expect(closeShellTab(three, 9)).toBe(three);
    });

    it("stops at the ceiling", () => {
        let tabs = NO_SHELL_TABS;
        for (let i = 0; i < SHELL_TABS_MAX + 2; i += 1) tabs = openShellTab(tabs);
        expect(tabs.shells).toHaveLength(SHELL_TABS_MAX);
    });
});
