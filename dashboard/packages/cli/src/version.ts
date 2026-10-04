declare const __CLI_VERSION__: string | undefined;

/** The Polaris release this CLI was built with, stamped by the bundler; a run
 *  from source (tests) reports a development version instead. */
export const CLI_VERSION: string =
    typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";

/** What the CLI calls itself on every request, so the server can tell it from a
 *  browser and the approval screen can name the system it runs on. */
export function userAgent(): string {
    return `polaris-cli/${CLI_VERSION} (${process.platform}; ${process.arch}; node ${process.versions.node})`;
}
