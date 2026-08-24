/**
 * `server.cfg`, as something that can be read and changed a line at a time.
 *
 * Everything about a FiveM server that is not a resource lives in this one file:
 * its name in the browser, how many people fit, whether OneSync is on, which
 * resources start, who is an administrator. The server reads it once at boot, so
 * a change here is a change the next start picks up - which is why every screen
 * that writes one says so rather than pretending the running server has moved.
 *
 * It is a list of console commands rather than a settings file, which is the part
 * that makes an editor awkward: the same value can be written three ways
 * (`sv_maxclients 32`, `set sv_maxclients 32`, `sets` for one the browser is told
 * about), a line may be commented out, and a key may appear twice with the last
 * one winning. So this reads the way the console does - last uncommented line for
 * a key is the value - and writes in place rather than appending a second one,
 * because a file that grows a new line every time somebody presses Save is a file
 * that stops being editable by hand.
 *
 * Pure: the rules screen renders from it in the browser and the service writes it
 * back through the container, and the two must not be able to disagree about what
 * a line means.
 */

/** How a directive is spelled. The bare form is a console command; `set` makes a
 *  variable, `sets` makes one the server browser is also told, `setr` one the
 *  connected clients are told. Which one a value wants is the game's business and
 *  is recorded with the setting, never guessed. */
export type CfgPrefix = "" | "set" | "sets" | "setr";

export interface CfgKey {
    readonly key: string;
    readonly prefix: CfgPrefix;
}

/** A line of the file, already split into what it says. */
interface CfgLine {
    readonly index: number;
    readonly prefix: CfgPrefix;
    readonly key: string;
    readonly args: readonly string[];
}

const PREFIXES: readonly CfgPrefix[] = ["set", "sets", "setr"];

/**
 * One line as the console tokenizer reads it: whitespace separates, a double
 * quote starts a run that ignores whitespace, and there is no escape inside one.
 */
export function tokenize(line: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quoted = false;
    let started = false;
    for (const character of line) {
        if (character === "\"") {
            quoted = !quoted;
            started = true;
            continue;
        }
        if (!quoted && /\s/.test(character)) {
            if (started) tokens.push(current);
            current = "";
            started = false;
            continue;
        }
        current += character;
        started = true;
    }
    if (started) tokens.push(current);
    return tokens;
}

/** A value written back the way the console will read it: quoted whenever it
 *  could not survive being split, and refused when it holds a quote of its own -
 *  the format has no escape for one, so there is no honest way to write it. */
export function quoteValue(value: string): string {
    if (value.includes("\"")) throw new Error("A double quote is not something server.cfg can hold");
    return value.length === 0 || /[\s#]/.test(value) ? `"${value}"` : value;
}

/** Every directive in the file, comments and blank lines left out. */
function directives(cfg: string): CfgLine[] {
    return cfg.split(/\r?\n/).flatMap((raw, index) => {
        const text = raw.trim();
        if (text.length === 0 || text.startsWith("#") || text.startsWith("//")) return [];
        const tokens = tokenize(text);
        if (tokens.length === 0) return [];
        const first = tokens[0]!.toLowerCase();
        const prefixed = PREFIXES.includes(first as CfgPrefix) && tokens.length >= 2;
        return [
            {
                index,
                prefix: prefixed ? (first as CfgPrefix) : ("" as CfgPrefix),
                key: prefixed ? tokens[1]! : tokens[0]!,
                args: prefixed ? tokens.slice(2) : tokens.slice(1)
            }
        ];
    });
}

/** Whether a line is the one this key names. The key is matched case-insensitively
 *  because the console is; the prefix has to match exactly, since `sv_maxclients`
 *  and `set sv_maxclients` are the same variable but `sets tags` is not `set tags`. */
function matches(line: CfgLine, wanted: CfgKey): boolean {
    return line.key.toLowerCase() === wanted.key.toLowerCase() && line.prefix === wanted.prefix;
}

/**
 * What a key is set to, or null when the file does not set it.
 *
 * The last one wins, which is what the console does with a file that sets the
 * same thing twice - and files that have been edited by several hands over a
 * year do exactly that.
 */
export function readSetting(cfg: string, wanted: CfgKey): string | null {
    const found = directives(cfg).filter((line) => matches(line, wanted));
    const last = found[found.length - 1];
    return last ? last.args.join(" ") : null;
}

/** Every value a repeated directive was given, oldest first - for the ones that
 *  are a list rather than a setting, like `ensure` and `add_principal`. */
export function readAll(cfg: string, wanted: CfgKey): string[] {
    return directives(cfg)
        .filter((line) => matches(line, wanted))
        .map((line) => line.args.join(" "));
}

/**
 * The file with one key set to one value, or with it taken out when the value is
 * null.
 *
 * Rewritten where it already was, so the order somebody arranged their file in
 * survives being edited from here, and appended only when the key was not there
 * at all. A key set more than once keeps the last line - the one that was in
 * force - and loses the earlier ones, because leaving a dead line above a live
 * one is how a file starts lying to whoever reads it next.
 */
export function writeSetting(cfg: string, wanted: CfgKey, value: string | null): string {
    const lines = cfg.split(/\r?\n/);
    const found = directives(cfg).filter((line) => matches(line, wanted));
    const written =
        value === null
            ? null
            : [wanted.prefix, wanted.key, quoteValue(value)].filter((part) => part.length > 0).join(" ");
    if (found.length === 0) {
        if (written === null) return cfg;
        // Kept off the last line rather than glued to it: the file usually ends
        // with a newline and appending to that would produce a blank line and then
        // the directive, which reads as a stray.
        const body = cfg.replace(/\s+$/, "");
        return `${body}\n${written}\n`;
    }
    const keep = found[found.length - 1]!.index;
    const dropped = new Set(found.slice(0, -1).map((line) => line.index));
    const next = lines.flatMap((line, index) => {
        if (dropped.has(index)) return [];
        if (index !== keep) return [line];
        if (written === null) return [];
        // The indentation somebody used is theirs; only the directive is ours.
        const indent = line.match(/^\s*/)?.[0] ?? "";
        return [`${indent}${written}`];
    });
    return next.join("\n");
}

/**
 * The file with a whole block of lines replaced.
 *
 * For the parts Polaris owns outright rather than sets - the administrators, the
 * resources it starts - where the answer is a list and editing it line by line
 * would mean working out which of somebody else's lines were ours. The block is
 * fenced by two comments and everything between them is replaced; a file that has
 * never had one gets it at the end.
 */
export function writeBlock(cfg: string, name: string, lines: readonly string[]): string {
    const open = `# ${name} - managed by Polaris, edited from the dashboard`;
    const close = `# end ${name}`;
    const body = lines.length > 0 ? `${open}\n${lines.join("\n")}\n${close}` : `${open}\n${close}`;
    const existing = cfg.split(/\r?\n/);
    const from = existing.findIndex((line) => line.trim() === open);
    const to = existing.findIndex((line) => line.trim() === close);
    if (from === -1 || to === -1 || to < from) {
        return `${cfg.replace(/\s+$/, "")}\n\n${body}\n`;
    }
    return [...existing.slice(0, from), ...body.split("\n"), ...existing.slice(to + 1)].join("\n");
}

/** What a managed block currently holds, for reading back what was written. */
export function readBlock(cfg: string, name: string): string[] {
    const open = `# ${name} - managed by Polaris, edited from the dashboard`;
    const close = `# end ${name}`;
    const lines = cfg.split(/\r?\n/);
    const from = lines.findIndex((line) => line.trim() === open);
    const to = lines.findIndex((line) => line.trim() === close);
    if (from === -1 || to === -1 || to < from) return [];
    return lines
        .slice(from + 1, to)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
