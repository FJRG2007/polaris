/**
 * How a page, a slide and a PDF are laid out.
 *
 * Ported from GenOffice's three editors (Apache-2.0, see NOTICE) - the parts of
 * them that are geometry rather than application: how a document breaks into
 * pages and where its lines fall, how a shape snaps and where its handles are,
 * how a PDF's text lines and columns are found and how its pages spread.
 *
 * Nothing here reaches a canvas, a DOM, a database or Electron. That is what
 * made it portable out of an application Polaris cannot use, and it is what
 * makes it testable here.
 *
 * Deliberately not taken from those editors: their string tables, their IPC
 * contracts and their AI tool definitions. Polaris has its own of all three, and
 * the last one is bound to a runtime that does not exist here.
 */

export * as doc from "./doc/index.js";
export * as slides from "./slides/index.js";
export * as pdf from "./pdf/index.js";
