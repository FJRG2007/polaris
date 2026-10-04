/**
 * A failure the CLI explains, as opposed to one it did not expect.
 *
 * Every message is written to be acted on: what went wrong in the reader's terms
 * and what to run next. `main` prints these as they are and anything else as a
 * generic line, so an internal stack never reaches somebody's terminal.
 */
export class CliError extends Error {
    /** The process exit code. 1 for a failure, 2 for a usage mistake. */
    readonly exitCode: number;

    constructor(message: string, exitCode = 1) {
        super(message);
        this.name = "CliError";
        this.exitCode = exitCode;
    }
}

/** A command used wrongly - the help names the right way. */
export function usage(message: string): CliError {
    return new CliError(`${message}\nRun plr help for the commands and their options.`, 2);
}
