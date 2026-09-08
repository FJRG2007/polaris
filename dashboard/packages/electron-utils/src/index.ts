/**
 * The parts of GenOffice's shell helpers that are not the shell.
 *
 * Six of its twelve modules reach into Electron - a menu bar, a native file
 * dialog, a print window - and cannot exist in a browser, so they stayed where
 * they are. What came across is the safety: deciding whether a URL may be
 * opened, whether a remote image may be fetched, and where a file should be
 * saved. All of it is pure and none of it knows what it is running in.
 */

export * from "./default-save-dir.js";
export * from "./github-menu.js";
export * from "./remote-image.js";
export * from "./safe-external-url.js";
export * from "./safe-remote-url.js";
