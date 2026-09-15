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
 * Write one of the server's files, keeping who owns it.
 *
 * `cat tmp > file` rather than `mv`: moving a file replaces it with one owned by
 * whoever ran the command, and the game's account then cannot rewrite its own
 * settings when it shuts down. Pouring into the existing file leaves the owner and
 * the mode exactly as they were.
 */
export async function writeContainerFile(server: ServerContainer, path: string, content: string): Promise<void> {
    assertSafePath(path);
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const temporary = `${path}.polaris-new`;
    const script = [
        `mkdir -p "$(dirname ${path})"`,
        `printf %s ${encoded} | base64 -d > ${temporary}`,
        // Created rather than truncated only when it was not there at all, and then
        // handed to whoever owns the folder around it.
        `[ -f ${path} ] || { : > ${path}; chown "$(stat -c %u:%g "$(dirname ${path})")" ${path} || true; }`,
        `cat ${temporary} > ${path}`,
        `rm -f ${temporary}`
    ].join(" && ");
    const result = await server.run(["sh", "-c", script]);
    if (result.code !== 0) {
        const said = result.output.trim().slice(0, 200);
        throw new Error(said.length > 0 ? `The server refused the write: ${said}` : "The file could not be written");
    }
}
