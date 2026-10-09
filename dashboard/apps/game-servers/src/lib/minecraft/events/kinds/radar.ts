/**
 * Xaero's Minimap fair-play codes, sent in chat to one player: the first turns
 * its cave view (minimap and world map) and its radar of players and mobs off
 * for this server, the second puts back whatever the server allows. Formatting
 * codes alone, so they show as nothing. Used where a minimap would give the
 * game away: hide and seek's hiders, a maze's corridors under its roof.
 */

import * as speech from "../../speech";
import * as commands from "../commands";

export const RADAR_OFF = "\u00a7f\u00a7a\u00a7i\u00a7r\u00a7x\u00a7a\u00a7e\u00a7r\u00a7o";
export const RADAR_RESET = "\u00a7r\u00a7e\u00a7s\u00a7e\u00a7t\u00a7x\u00a7a\u00a7e\u00a7r\u00a7o";

/** A line to one player carrying one of the codes, after the sentence in their
 *  language when there is one. */
export function radarLine(
    name: string,
    code: string,
    sentence?: (language: speech.Language) => string
): string {
    const each = Object.fromEntries(
        speech.LANGUAGES.map((language) => {
            const parts: unknown[] = [""];
            if (sentence) parts.push(JSON.parse(commands.text(sentence(language))) as unknown);
            parts.push({ text: code });
            return [language, commands.asciiJson(JSON.stringify(parts))];
        })
    ) as Record<speech.Language, string>;
    return `tellraw ${name} ${speech.perLanguage(each)}`;
}
