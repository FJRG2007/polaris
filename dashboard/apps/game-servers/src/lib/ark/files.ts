/**
 * Where an ARK server keeps its own files.
 *
 * Three of the things this panel offers are files rather than commands - the
 * settings the server boots with, the admin list, and the survivor profiles - and
 * ARK has no way to be asked about any of them over RCON. Reading and writing one
 * is not ARK's problem though: it is the same act for every game here, and lives
 * in `container-files`.
 */

/** Where the image keeps the game's files. The volume is `/app`; the server files
 *  themselves live under it, which is what every path here is relative to. */
export const ARK_ROOT = "/app/server";
