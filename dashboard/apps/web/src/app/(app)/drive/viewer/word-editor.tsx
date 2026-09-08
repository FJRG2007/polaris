"use client";

/**
 * Editing a Word document in Drive.
 *
 * The editor is GenOffice's (`@polaris/genoffice-docs`, Apache-2.0, see NOTICE)
 * and the writer under it is `@polaris/docx`, which patches paragraphs into the
 * original package rather than rebuilding one - so a document saved from here
 * keeps the styles, the numbering, the headers and everything else it arrived
 * with, including the parts nothing in this repository understands.
 *
 * That is what makes this possible at all, and it is why the read-only note on
 * `doc-view` was true when it was written and is not any more: "no open-source
 * round-trip writes a .docx back without losing the original styling" was the
 * reason Drive would only ever render one. There is one now.
 *
 * The editor was written for Electron and talks to `window.desktop`, an object a
 * preload script injects, whose fifty methods end in a main process with a
 * filesystem, a printer and a menu bar. This is that object, answered by Drive
 * and by the browser.
 *
 * Two of those methods are the ones that matter, because they are how a shell
 * that owns the file asks the editor for it. `onCloseCheck` asks whether there
 * is anything unsaved and is answered on `reportCloseCheck`; `onCloseSaveRequest`
 * asks for a save and is answered on `reportCloseSaveResult`, by which time the
 * bytes have arrived through `saveDocx`. Drive's own Save drives that pair, so
 * the toolbar beside the editor writes the file without a keystroke inside it
 * and without a second save path.
 *
 * What is answered rather than implemented, and why:
 *
 * - **Anything else a menu bar drove** - the tab list, the view menu. There is
 *   no menu bar, and an editor that never hears back from one of these waits
 *   for it.
 * - **Anything that opens a second document** - a file picker, a recent list, a
 *   new tab. Drive is the file picker, and it is the screen this is inside.
 * - **The AI half.** Its requests carry a provider, a model and a key
 *   GenOffice's own settings would have supplied. Answering them from Polaris'
 *   agent runtime would be spending somebody's credits through a surface they
 *   never configured.
 */

// The editor's own stylesheets, fenced inside the class it is rendered in - see
// `scripts/scope-editor-styles`. Statically, and not inside the dynamic import:
// a stylesheet imported inside an effect is one the bundler never sees, which is
// how the spreadsheet came to mount with no styles at all. It costs one file on
// the routes that can open a document and nothing anywhere else, because this
// module is only loaded when somebody presses Edit.
import "@polaris/genoffice-docs/styles.css";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

const Editor = dynamic(async () => (await import("@polaris/genoffice-docs")).App, {
    ssr: false,
    loading: () => (
        <div className="flex min-h-[50vh] items-center justify-center">
            <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only">Opening the document</span>
        </div>
    )
});

/** A subscription that will never fire. Returned so the editor's own unsubscribe
 *  still works. */
const never = (): (() => void) => () => undefined;

/** How the toolbar beside the editor reaches into it. */
export type WordEditorControl = {
    /** Ask the editor to write the document out and hand back what it wrote.
     *  Null when it could not, which the caller reports rather than saving an
     *  empty file over somebody's document. */
    bytes: () => Promise<Uint8Array | null>;
};

/** How long a save may go unanswered before Save stops waiting. The editor
 *  retries a pass that raced with typing, so this is generous on purpose. */
const SAVE_PATIENCE = 30_000;

export function WordEditor({
    src,
    name,
    theme,
    control,
    onDirty
}: {
    /** Where the bytes are, which is the same address the viewer downloads from. */
    src: string;
    name: string;
    theme: "light" | "dark";
    /** Filled in while the editor is mounted, so the toolbar can ask it to save.
     *  Saving stays with `EditorActions`, which is what every other editor in
     *  Drive saves through. */
    control: RefObject<WordEditorControl | null>;
    /** Whether the document has changes the file does not, which is what lights
     *  up Save. */
    onDirty: (dirty: boolean) => void;
}) {
    const told = useRef(onDirty);
    told.current = onDirty;
    const [failed, setFailed] = useState(false);

    /** What the editor subscribed with, kept so the shell can call it. */
    const listeners = useRef<{ check: (() => void) | null; save: (() => void) | null; }>({
        check: null,
        save: null
    });
    /** Where the editor's answer to the question being asked right now goes. */
    const answerCheck = useRef<((state: { dirty?: boolean; }) => void) | null>(null);
    const answerSave = useRef<((ok: boolean) => void) | null>(null);
    /** The last bytes the editor handed over. */
    const written = useRef<Uint8Array | null>(null);
    const dirtyNow = useRef(false);

    const api = useMemo(() => {
        /** The file, read once and kept: the editor asks for it on open and again
         *  on recovery, and Drive should not be asked twice for the same bytes. */
        let held: ArrayBuffer | null = null;
        const read = async (): Promise<ArrayBuffer> => {
            if (held) return held;
            const response = await fetch(src, { cache: "no-store" });
            if (!response.ok) throw new Error("That document could not be read.");
            held = await response.arrayBuffer();
            return held;
        };

        const opened = async () => {
            const data = await read();
            return {
                // A path, because a document without one is one the editor
                // treats as never saved and writes through a file dialog. The
                // name is what it shows, and a Drive path is not a thing
                // anybody wants to read.
                path: name,
                name,
                data,
                // The editor keeps this to notice the file changing under it -
                // which, in Drive, the toolbar's own save already answers for.
                hash: ""
            };
        };

        return {
            // ------------------------------------------------------- the file
            openDocx: async () => null,
            openDocxPath: async () => opened(),
            consumePendingOpenDocx: async () => opened(),
            openDocxDecrypt: async () => ({ ok: false as const, reason: "unsupported" as const }),
            setDocPassword: async () => ({ ok: false }),
            docPasswordIntentRevision: async () => 0,
            discardDocPasswordIntents: async () => ({ ok: true }),
            consumeNewBlankDoc: async () => false,
            consumeAiDocContent: async () => null,
            createDocument: async () => ({ ok: false, error: "Make a document in Drive." }),
            onOpenDocx: never,
            onRenamedDocx: never,
            saveDocx: async (_path: string, data: ArrayBuffer) => {
                written.current = new Uint8Array(data);
                return { ok: true };
            },
            saveDocxAs: async () => ({ ok: false, error: "Use Save a copy beside Save." }),
            saveDocxNew: async () => ({ ok: false, error: "Use Save a copy beside Save." }),
            writeRecoveryCopy: async () => ({ ok: true }),
            onTeardown: never,
            getRecentFiles: async () => [],

            // -------------------------------------------------- what a shell did
            onCloseCheck: (fn: () => void) => {
                listeners.current.check = fn;
                return () => {
                    listeners.current.check = null;
                };
            },
            reportCloseCheck: (state: { dirty?: boolean; }) => answerCheck.current?.(state),
            onCloseSaveRequest: (fn: () => void) => {
                listeners.current.save = fn;
                return () => {
                    listeners.current.save = null;
                };
            },
            reportCloseSaveResult: (ok: boolean) => answerSave.current?.(ok),
            onChromePressed: never,
            onMenuCommand: never,
            reportViewMenuState: () => undefined,
            openNewTab: async () => undefined,
            listDocsTabs: async () => [],
            focusDocsTab: async () => undefined,

            // ------------------------------------------------------- the page
            getLanguage: async () => "en" as const,
            onLanguageChanged: never,
            getTheme: async () => theme,
            onThemeChanged: never,
            print: async () => {
                window.print();
                return { ok: true };
            },
            exportPdf: async () => {
                window.print();
                return { ok: true, canceled: true };
            },
            printPdfBuffer: async () => ({ ok: false, error: "Use Print." }),
            saveMergedPdf: async () => ({ ok: false, error: "Use Print." }),
            // Measured by the browser, which has the fonts. The editor falls
            // back to its own defaults when this answers nothing, which is what
            // it did on a machine without the font anyway.
            fontMetrics: async () => null,

            // ------------------------------------------------- files and images
            pickImage: async () => null,
            pickAttachments: async () => null,
            addAttachmentPaths: async () => ({ added: [], errors: [] }),
            addPastedImage: async () => ({ added: [], errors: [] }),
            copyImageToClipboard: async () => false,
            readAttachment: async () => ({ ok: false, error: "Not available here." }),
            readAttachmentImage: async () => ({ ok: false, error: "Not available here." }),
            getPathForFile: () => "",

            // ------------------------------------------------------------- AI
            getAiSettings: async () => ({ providers: [], activeProvider: null, enabled: false }),
            setAiSettings: async () => undefined,
            aiChat: async () => ({ ok: false, error: "Not connected in Polaris." }),
            aiStream: async () => undefined,
            aiStreamCancel: async () => undefined,
            aiGskStatus: async () => ({ loggedIn: false }),
            aiGskLogin: async () => undefined,
            onAiStream: never,
            webSearch: async () => ({ results: [], method: "error", error: "Not connected." }),
            imageSearch: async () => ({ images: [], method: "error", error: "Not connected." }),
            fetchImage: async () => null,
            aiGenerateImage: async () => ({ error: "Not connected." })
        };
    }, [src, name, theme]);

    // Set before the editor mounts, because it reads the bridge as it starts. On
    // the window rather than through a prop: that is the shape it was written
    // against, and changing it would mean editing vendored code at fifty sites.
    useEffect(() => {
        const shell = window as unknown as Record<string, unknown>;
        const previous = shell.desktop;
        shell.desktop = api;
        return () => {
            shell.desktop = previous;
        };
    }, [api]);

    // The editor answers "is there anything unsaved" rather than announcing it,
    // so the button beside it has to ask. Every second: fast enough that Save
    // lights up as somebody types, and it costs a function call.
    useEffect(() => {
        const ask = () => {
            const listener = listeners.current.check;
            if (!listener) return;
            answerCheck.current = (state) => {
                const next = Boolean(state?.dirty);
                if (next === dirtyNow.current) return;
                dirtyNow.current = next;
                told.current(next);
            };
            listener();
            answerCheck.current = null;
        };
        const id = window.setInterval(ask, 1000);
        return () => window.clearInterval(id);
    }, []);

    useEffect(() => {
        control.current = {
            bytes: async () => {
                const listener = listeners.current.save;
                if (!listener) return null;
                written.current = null;
                const ok = await new Promise<boolean>((resolve) => {
                    let settled = false;
                    const once = (value: boolean) => {
                        if (settled) return;
                        settled = true;
                        resolve(value);
                    };
                    answerSave.current = once;
                    window.setTimeout(() => once(false), SAVE_PATIENCE);
                    listener();
                });
                answerSave.current = null;
                return ok ? written.current : null;
            }
        };
        return () => {
            control.current = null;
        };
    }, [control]);

    useEffect(() => {
        // A document the fetch cannot reach is a failure worth a sentence rather
        // than a spinner that never stops.
        let alive = true;
        void fetch(src, { method: "HEAD" })
            .then((response) => {
                if (alive && !response.ok) setFailed(true);
            })
            .catch(() => {
                if (alive) setFailed(true);
            });
        return () => {
            alive = false;
        };
    }, [src]);

    if (failed) {
        return (
            <p role="alert" className="p-6 text-center text-[13px] text-danger">
                This document could not be opened.
            </p>
        );
    }
    // Everything the editor draws lives under this class, and so does every rule
    // in the stylesheet above. Without the fence its `*`, `html` and `body`
    // rules would reach Drive's own chrome.
    return (
        <div className="genoffice-docs h-full">
            <Editor />
        </div>
    );
}
