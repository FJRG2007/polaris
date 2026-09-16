/**
 * Reading and writing a game server's own files inside its container.
 *
 * Several of the things these panels offer are files rather than commands - the
 * settings a server boots with, its admin list, its survivor profiles, a FiveM
 * server's whole configuration - and no game here has a way of being asked about
 * any of them over its console. So they are read and written where they live.
 *
 * Through the container's own shell rather than through the daemon's file API:
 * that one only reaches containers on the local host, and a game server
 * registered on another machine is exactly the case that has to keep working.
 * `run` already works on both, so a write is a base64 blob handed to `base64 -d` -
 * the bytes never touch a shell as text, and the only thing interpolated into the
 * command is a path this module's callers own and a string of base64 characters.
 *
 * A write lands in a temporary file first and is then poured into the real one, so
 * a half-written file is never what the server boots from, and the file keeps
 * whatever ownership it already had - it is read by the game's own account, not by
 * the one this command runs as.
 */

import type { ServerContainer } from "@/lib/apps/minecraft/service";

/** Paths are the callers' own constants, never anything typed. Proved rather than
 *  assumed, because everything below puts one in a shell command. */
export function assertSafePath(path: string): void {
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) {
        throw new Error("That is not a path Polaris will read");
    }
}

/**
 * What a read found, for a caller that has to tell an absent file from one it
 * could not see.
 *
 * `cat` exits non-zero for both, and they mean opposite things to anybody about
 * to write the file back: a file that is not there is an empty one, where a read
 * that failed - a container on its way down, an exec the machine refused - is a
 * file whose contents are still in there and would be written over by whatever
 * was built on the assumption it was empty. What `cat` complained about is the
 * only thing that separates them.
 */
export type ContainerFileRead =
    | { readonly state: "read"; readonly content: string }
    | { readonly state: "missing" }
    | { readonly state: "unreadable" };

export async function readContainerFileState(server: ServerContainer, path: string): Promise<ContainerFileRead> {
    assertSafePath(path);
    const result = await server.run(["cat", "--", path]);
    if (result.code === 0) return { state: "read", content: result.output };
    // Both spellings, because the images do not agree: coreutils says "No such
    // file or directory" and busybox prefixes it with "can't open".
    return /no such file|can't open/i.test(result.output) ? { state: "missing" } : { state: "unreadable" };
}

/** One of the server's files as text, or null when it is not there. A file that
 *  does not exist is not a failure: a server nobody has made an admin has no admin
 *  list, and a server that has never started has no settings file. */
export async function readContainerFile(server: ServerContainer, path: string): Promise<string | null> {
    const read = await readContainerFileState(server, path);
    return read.state === "read" ? read.content : null;
}

/**
 * Write one of the server's files, keeping who owns it, in one step.
 *
 * The file is built beside the real one and then moved onto it. A move within a
 * directory is a rename: no reader ever sees half of it, and nothing is destroyed
 * until the new contents are complete on disk. That matters more than it used to,
 * because the files coming through here now include the ones the server is closed
 * by - and a `whitelist.json` caught halfway through a write is every player on it
 * locked out of a server that says they are welcome.
 *
 * Pouring into the existing file instead (`cat tmp > file`) truncates it before
 * writing a byte, so a command that dies midway - a container stopping, a
 * connection dropping, a full disk - leaves a short file or an empty one. The
 * reason it was written that way is real, though: a plain `mv` hands the file to
 * whoever ran the command, and the game's own account then cannot rewrite its
 * settings when it shuts down. So the owner and mode are copied onto the new file
 * from the one it replaces before the move, and taken from the folder when there
 * is nothing there to copy from.
 */
export async function writeContainerFile(server: ServerContainer, path: string, content: string): Promise<void> {
    assertSafePath(path);
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const temporary = `${path}.polaris-new`;
    // Ownership is copied rather than asked for with --reference, which busybox
    // does not carry. Never fatal: a file written but left owned by the wrong
    // account is a problem the next boot may survive, where refusing the write is
    // one it certainly will not.
    const takeOwner = `chown "$(stat -c %u:%g ${path})" ${temporary} || true; chmod "$(stat -c %a ${path})" ${temporary} || true`;
    const inheritOwner = `chown "$(stat -c %u:%g "$(dirname ${path})")" ${temporary} || true`;
    const script = [
        `mkdir -p "$(dirname ${path})"`,
        `printf %s ${encoded} | base64 -d > ${temporary}`,
        `if [ -f ${path} ]; then ${takeOwner}; else ${inheritOwner}; fi`,
        `mv -f ${temporary} ${path}`
    ].join(" && ");
    const result = await server.run(["sh", "-c", script]);
    if (result.code !== 0) {
        const said = result.output.trim().slice(0, 200);
        throw new Error(said.length > 0 ? `The server refused the write: ${said}` : "The file could not be written");
    }
}
