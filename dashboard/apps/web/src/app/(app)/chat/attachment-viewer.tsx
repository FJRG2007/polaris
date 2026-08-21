"use client";

/**
 * Reading a file somebody sent, without saving it first.
 *
 * A PDF, a spreadsheet, a document, a slide deck, a page of markdown, a script:
 * before this, all of them were a paperclip and a filename, and the only way to
 * find out what was in one was to download it, open it in something else, and
 * then remember to delete it. For anything sent to be read rather than kept -
 * an invoice, a form, a report - that is the whole interaction, done the long
 * way round.
 *
 * None of the reading is written here. Drive already renders every one of these
 * formats, and its viewer takes the two things it needs to work somewhere else:
 * where the bytes are (`urlFor`) and whether they can be written back
 * (`readOnly`). A chat attachment is somebody else's file on a message, so it is
 * always read-only, and the whole viewer is pulled in only when somebody
 * actually opens one - it carries a spreadsheet parser, a document converter and
 * a PDF engine behind it, and a conversation must not pay for those to draw a
 * filename.
 */

import dynamic from "next/dynamic";
import { viewerKind } from "../drive/viewer/kind";
import { extensionOf } from "../drive/file-categories";
import type { ViewerKind, ViewerTarget } from "../drive/viewer/types";

const FileViewer = dynamic(() => import("../drive/file-viewer").then((module) => module.FileViewer), {
    ssr: false
});

/** One attachment being read. */
export interface ViewedFile {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly sentAt: string;
}

/** Extensions that are plainly text and have no highlighting worth doing, so
 *  the language table does not know them. Everything else that is text - every
 *  source file, every config format - already opens as code. */
const PLAIN_TEXT = new Set(["txt", "text", "log", "srt", "vtt", "nfo", "diff", "patch"]);

/** Types that mean text on a file whose name says nothing at all. */
const TEXTUAL = new Set(["application/json", "application/xml", "application/x-yaml", "application/yaml"]);

/**
 * Whether this is worth offering to read here, and as what.
 *
 * The three the conversation already draws itself - a picture, a recording, a
 * clip - are not offered: they are on the screen already. Everything Drive has
 * a real view for is. The catch is the viewer's fallback, which is "show it as
 * text": right for a config file and wrong for an archive, so it is only
 * offered when the sender's own type, or a name with no extension at all, says
 * it really is text.
 */
export function previewableAs(name: string, contentType: string): ViewerKind | null {
    const kind = viewerKind(name);
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "none") return null;
    if (kind !== "text") return kind;

    const extension = extensionOf(name);
    if (PLAIN_TEXT.has(extension)) return "text";
    // An extension that got this far is one nothing recognizes, and an
    // unrecognized extension is far more often an archive or an installer than
    // a text file. The sender's type is not allowed to argue: a browser puts
    // `application/octet-stream` on most of what people attach, and a `.zip`
    // that arrives claiming to be text would open as a screen of replacement
    // characters - worse than the download it replaced.
    if (extension !== "") return null;

    // No extension at all - a README, a LICENSE, a log pasted out of a terminal.
    // Only here is there nothing better to go on than what the sender said.
    const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    return base === "" || base.startsWith("text/") || TEXTUAL.has(base) ? "text" : null;
}

/** Where a chat attachment's bytes are. The same address the chip links to, so
 *  what is read is what would have been saved. */
function attachmentUrl(target: ViewerTarget, inline: boolean): string {
    return inline ? `/api/chat/attachments/${target.path}` : `/api/chat/attachments/${target.path}?download=1`;
}

export function AttachmentViewer({ file, onClose }: { file: ViewedFile | null; onClose: () => void }) {
    return (
        <FileViewer
            target={
                file
                    ? {
                          // The viewer addresses a file by path; here the path
                          // is the attachment's id, and `urlFor` is what turns
                          // one into the other.
                          path: file.id,
                          name: file.name,
                          size: String(file.size),
                          modifiedAt: file.sentAt,
                          locationLabel: "Sent in this conversation"
                      }
                    : null
            }
            onOpenChange={(open) => !open && onClose()}
            urlFor={attachmentUrl}
            // Somebody else's file on a message. Editing it would have nowhere
            // to write: an attachment is the bytes that were sent, and a message
            // that quietly changed after it was read is not a message.
            readOnly
        />
    );
}
