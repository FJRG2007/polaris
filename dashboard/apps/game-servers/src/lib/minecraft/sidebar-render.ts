/**
 * The side panel as it reads at one moment: which text of each line is up, the
 * lists spread over their rows, the values filled in, and each line's effect at
 * its step.
 *
 * One function for the server and the preview, so what the editor shows moving
 * is what the players see moving. The values are filled by the caller - the live
 * ones on the server, samples in the editor - and everything else is decided
 * here from the settings and the clock.
 *
 * Pure.
 */

import { spreadListRows } from "./rankings";
import { javaComponent } from "./announcement";
import { applyEffect } from "./sidebar-effects";
import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";
import { SIDEBAR_LINES_MAX, frameAt, type SidebarConfig, type SidebarLine } from "./sidebar";

/** The longest command a line is written with, less its text: the holder's
 *  name and the objective's are fixed, so this is what is left for the text. */
const LINE_COMMAND = "scoreboard players display name polaris.line.00 polaris_side ";
const TITLE_COMMAND = "scoreboard objectives modify polaris_side displayname ";

const fitsAfter = (prefix: string) => (text: string) =>
    commandBytes(`${prefix}${javaComponent(text, false)}`) <= COMMAND_BYTES_MAX;

/** Which step of its effect a line is at. A line that takes turns starts its
 *  effect again with each of them, so typing types each text from its start. */
function stepOf(line: SidebarLine, now: number): number {
    const since = line.frames.length > 1 ? now % (line.every * 1000) : now;
    return Math.floor(since / line.effect.speed);
}

export interface RenderedSidebar {
    readonly title: string;
    readonly lines: string[];
}

export function renderSidebar(
    sidebar: SidebarConfig,
    now: number,
    fill: (text: string) => string,
    lists: Readonly<Record<string, readonly string[]>>
): RenderedSidebar {
    const title = applyEffect(
        fill(frameAt(sidebar.title, now)),
        sidebar.title.effect,
        stepOf(sidebar.title, now),
        fitsAfter(TITLE_COMMAND)
    );
    const rows = spreadListRows(
        sidebar.lines.map((line) => frameAt(line, now)),
        lists,
        SIDEBAR_LINES_MAX
    );
    const lines = rows.map((row) => {
        const line = sidebar.lines[row.from]!;
        return applyEffect(fill(row.text), line.effect, stepOf(line, now), fitsAfter(LINE_COMMAND));
    });
    return { title, lines };
}
