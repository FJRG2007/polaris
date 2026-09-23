/**
 * Which of a server's plugins it refused to load, and what it said about them.
 *
 * A plugin that will not load is the quietest failure a server has. The jar is
 * downloaded, the list on screen says it is installed, the server starts, reaches
 * "Done" and answers players - and the thing it was installed for is simply not
 * there. Found by building the Skyblock blueprint on real Docker: IridiumSkyblock
 * arrived, the server said
 *
 *   UnknownDependencyException: Unknown/missing dependency plugins: [Vault].
 *
 * and then came up as an ordinary flat world. Nothing in Polaris knew, because
 * nothing in Polaris was reading. That blueprint now installs Vault, but the next
 * plugin somebody adds from the browser with a dependency outside Modrinth has
 * exactly the same afternoon ahead of it.
 *
 * Pure, and read off a log tail, so it is testable against a captured log with no
 * container anywhere near it - the same shape as `crash-loop`, which answers the
 * other half of this question: why a server did not start at all.
 */

/** A plugin the server would not load, as the screen says it. */
export interface RefusedPlugin {
    /** The jar, as the server named it: `IridiumSkyblock-4.1.5.jar`. */
    readonly jar: string;
    /** What the plugin is called, with the version and `.jar` taken off - which
     *  is what somebody recognises from the list they installed it from. */
    readonly name: string;
    /** Why, in the server's own words, cut to a sentence. Empty when it gave a
     *  line nobody can act on. */
    readonly why: string;
    /** The plugins it said were missing, when that is what went wrong. This is
     *  the one cause Polaris can do something about. */
    readonly needs: readonly string[];
}

/** `plugins/IridiumSkyblock-4.1.5.jar` on Paper, `plugins\\X.jar` on the odd one. */
const REFUSED = /Could not load '(?:plugins[/\\])?([^']+\.jar)'/i;

/** The dependency it names, when that is the complaint. */
const MISSING = /Unknown\/missing dependency plugins?:\s*\[([^\]]+)\]/i;

/** Anything a Java stack frame starts with, which is never the reason. */
const FRAME = /^\s+at\s/;

/** The version and extension off the end of a jar name. */
export function pluginName(jar: string): string {
    return jar
        .replace(/\.jar$/i, "")
        .replace(/[-_]v?\d+(?:\.\d+)*(?:[-.][A-Za-z0-9]+)*$/, "")
        .trim();
}

/**
 * Every plugin in this log the server refused to load.
 *
 * The reason is the first line after the refusal that is not a stack frame, since
 * that is where the exception says what it was - and a stack frame names a file in
 * the server rather than anything about the plugin.
 *
 * Only the most recent boot counts: a log holding a start from before somebody
 * fixed it would report a plugin that loads perfectly well now. So the reading
 * starts at the last line that says the server is starting, when there is one.
 */
export function refusedPlugins(log: string): RefusedPlugin[] {
    const lines = sinceLastStart(log.split(/\r?\n/));
    const found = new Map<string, RefusedPlugin>();
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const jar = REFUSED.exec(line)?.[1];
        if (!jar) continue;
        const reason = lines.slice(index + 1, index + 4).find((next) => next.trim() && !FRAME.test(next));
        const why = clean(reason ?? "");
        const needs = MISSING.exec(why)?.[1] ?? "";
        found.set(jar, {
            jar,
            name: pluginName(jar),
            why,
            needs: needs
                .split(",")
                .map((one) => one.trim())
                .filter((one) => one.length > 0)
        });
    }
    return [...found.values()];
}

/** The lines from the last start onwards, or all of them when the tail does not
 *  reach one - half a boot is still worth reading. */
function sinceLastStart(lines: readonly string[]): readonly string[] {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (/Starting minecraft server version/i.test(lines[index] ?? "")) return lines.slice(index);
    }
    return lines;
}

/** The exception line as a sentence: no timestamp, no package name, no more than
 *  a screen's worth. */
function clean(line: string): string {
    const said = line
        .replace(/^\[[^\]]*\]:?\s*/, "")
        .replace(/^[a-z0-9_.]+\.([A-Z][A-Za-z0-9]*Exception|Error):\s*/, "")
        .trim();
    return said.length > 300 ? `${said.slice(0, 297)}...` : said;
}
