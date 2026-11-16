/**
 * The color theme Polar Code paints code, diffs and terminal output in, per
 * person. OpenCode ships a list of terminal themes (`content/themes.mdx`); these
 * are four of them, at their published hex values (each cited beside its rule
 * in `globals.css`: nordtheme.com, morhetz/gruvbox, ethanschoonover.com/solarized,
 * folke/tokyonight.nvim and enkia/tokyo-night-vscode-theme), each
 * redefining the syntax and diff tokens of `globals.css` under
 * `[data-code-theme]`, so the highlighter and the diff view need no change.
 * "polaris" is the design system's own palette and redefines nothing.
 *
 * No stored value, or one that is no longer a theme, is "polaris". Client-safe.
 */

import { z } from "zod";

export const CODE_THEMES = ["polaris", "nord", "gruvbox", "solarized", "tokyonight"] as const;

export type CodeTheme = (typeof CODE_THEMES)[number];

export const DEFAULT_CODE_THEME: CodeTheme = "polaris";

export const codeThemeSchema = z.enum(CODE_THEMES);

/** A stored or cached theme read defensively. */
export function codeThemeOf(value: unknown): CodeTheme {
    const parsed = codeThemeSchema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_CODE_THEME;
}
