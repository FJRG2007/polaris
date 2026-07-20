/**
 * Shell-quoting for the remote (SSH) path, where an argv has to be flattened into
 * a single bash command line. The local path never uses this - it passes argv
 * arrays to the host daemon, which execs them directly with no shell. Pure.
 */

/** POSIX single-quote one argument so no character in it is interpreted by bash. */
export function quoteArg(arg: string): string {
    if (arg.length > 0 && /^[a-zA-Z0-9_./:=-]+$/.test(arg)) return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join an argv into a single safely-quoted bash command line. */
export function quoteArgv(argv: readonly string[]): string {
    return argv.map(quoteArg).join(" ");
}
