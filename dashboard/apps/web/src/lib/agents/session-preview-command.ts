/**
 * A repository's preview command: the line that starts its dev server
 * (`npm run dev`, `bin/rails server`), run in a session's checkout when somebody
 * asks for the preview and nothing is listening yet. The preview pane already
 * finds whatever the session listens on (`session-preview.ts`); this is only the
 * button that starts it without asking the agent to.
 *
 * Pure, so the script the container runs is asserted in a test.
 */

import { z } from "zod";

/** Longest preview command a repository may keep: one line, not a script. */
export const PREVIEW_COMMAND_MAX = 500;

/** A preview command as a form sends it: one trimmed line, bounded. Empty is none. */
export const previewCommandSchema = z
    .string()
    .transform((value) => value.trim())
    .pipe(
        z
            .string()
            .max(PREVIEW_COMMAND_MAX)
            // One line: a newline or another control character is a second
            // command nobody sees on the form.
            // eslint-disable-next-line no-control-regex
            .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
    );

/** Where the started server's pid and output are kept inside the container. */
export const PREVIEW_STATE = "/tmp/polaris-preview";

/**
 * The shell that starts the command in the background, in the checkout, as the
 * account the agent runs as. Started at most once: a server still running from
 * the last press is left alone. The command travels base64-encoded, so nothing in
 * it is read by this shell.
 */
export function previewStartScript(command: string): string {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    const f = PREVIEW_STATE;
    return [
        `if [ -f ${f}.pid ] && kill -0 "$(cat ${f}.pid)" 2>/dev/null; then echo running; exit 0; fi`,
        `printf %s '${encoded}' | base64 -d > ${f}.sh`,
        'a="$POLARIS_RUNAS"; h="$POLARIS_HOME"',
        'if [ -n "$h" ] && [ -d "$h" ]; then HOME="$h"; PATH="$h/.npm-global/bin:$PATH"; export HOME PATH; fi',
        `w="$POLARIS_WORKDIR"; case "$w" in '$HOME'/*) w="$HOME/$(printf %s "$w" | cut -c7-)" ;; esac`,
        '[ -n "$w" ] && cd "$w" 2>/dev/null',
        'if [ "$(id -u)" = 0 ] && [ -n "$a" ] && id "$a" >/dev/null 2>&1 && command -v su >/dev/null 2>&1; then',
        `  chown "$a" ${f}.sh 2>/dev/null; nohup su -p "$a" -s /bin/sh -c "sh ${f}.sh" > ${f}.log 2>&1 < /dev/null &`,
        "else",
        `  nohup sh ${f}.sh > ${f}.log 2>&1 < /dev/null &`,
        "fi",
        `echo $! > ${f}.pid`,
        "echo started"
    ].join("\n");
}
