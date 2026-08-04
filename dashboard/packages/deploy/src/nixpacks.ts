/**
 * The nixpacks.toml Polaris writes into a build context.
 *
 * Nixpacks reads this file from the directory it is pointed at and lets it
 * override what its own providers worked out, which is how Polaris supplies a
 * start command without a Dockerfile and without changing the command the host
 * daemon runs - the file travels inside the build context that is already being
 * tarred and streamed. That matters more than it sounds: the alternative is new
 * flags on the daemon's build endpoint, and a new daemon binary on every enrolled
 * machine before any of this works anywhere.
 *
 * Only the sections that carry a value are written. An empty override is not the
 * same as an override to nothing: leaving the section out is what hands the phase
 * back to nixpacks, and writing an empty one would blank it.
 *
 * The overriding is narrow on purpose, and the reason is a regression this file
 * caused. A phase written here REPLACES the provider's, and the install phase is
 * where nixpacks bootstraps the package manager itself - so an install command
 * that merely restated what nixpacks would have run anyway took the bootstrap out
 * with it, and the build died on "pnpm: command not found". Nothing is written for
 * a phase unless there is a reason it has to differ.
 */

/** What goes into the file. Every field is optional; all absent writes nothing. */
export interface NixpacksConfig {
    /** Extra Nix packages the image needs, beyond what the provider installs. */
    readonly packages?: readonly string[];
    readonly install?: string | null;
    readonly build?: string | null;
    readonly start?: string | null;
}

/** Nixpacks' marker for "and everything that was already here". Without it an
 *  array in this file replaces the provider's rather than adding to it, which for
 *  the setup phase means throwing away the language runtime itself. */
const KEEP_EXISTING = "...";

/** TOML basic-string escaping: the quote and the backslash, plus the control
 *  characters that cannot appear raw. Commands are user-supplied, so a stray
 *  quote must not be able to end the string and start something else. */
function quote(value: string): string {
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
    return `"${escaped}"`;
}

/**
 * Render the file, or null when there is nothing worth writing. Null is the
 * answer for a project nixpacks already understands, and it means no file lands in
 * the context at all - a repository that ships its own nixpacks.toml keeps it.
 */
export function nixpacksConfig(config: NixpacksConfig): string | null {
    const lines: string[] = [];
    if (config.packages && config.packages.length > 0) {
        // Extended, never replaced: this phase is where the language runtime comes
        // from, and a bare list here would leave an image holding a static file
        // server and no Node at all.
        const packages = [KEEP_EXISTING, ...config.packages].map(quote).join(", ");
        lines.push("[phases.setup]", `nixPkgs = [${packages}]`, "");
    }
    if (config.install) lines.push("[phases.install]", `cmds = [${quote(config.install)}]`, "");
    if (config.build) lines.push("[phases.build]", `cmds = [${quote(config.build)}]`, "");
    if (config.start) lines.push("[start]", `cmd = ${quote(config.start)}`, "");
    if (lines.length === 0) return null;

    return [
        "# Written by Polaris from what it found in this repository, and from the",
        "# build settings on the service. Not part of the repository - it exists only",
        "# inside the build context.",
        "",
        ...lines
    ]
        .join("\n")
        .trimEnd()
        .concat("\n");
}
