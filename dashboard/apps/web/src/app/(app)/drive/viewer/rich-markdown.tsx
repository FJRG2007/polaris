"use client";

/**
 * The full Markdown editor, over a file in Drive.
 *
 * The editor itself is GenOffice's (`@polaris/genoffice-markdown`, Apache-2.0,
 * see NOTICE) - slash commands, tables, maths, a table of contents, the things a
 * plain textarea does not have. It was written for Electron and reads and writes
 * through `window.markdownApi`, an object a preload script injects; this is that
 * object, implemented for a browser and answered by Drive.
 *
 * **It is an alternative, not a replacement.** The Pretty and Raw views and the
 * plain editor beside it are unchanged and are what most people want for a
 * README. This is the third button, for the file that is a document.
 *
 * Loaded only when somebody presses it. The editor and everything under it is
 * megabytes, and nobody who never opens it should pay for that.
 *
 * Three groups of what it asks for are answered rather than implemented, and
 * deliberately: a native file picker, the close prompt a menu bar drove, and its
 * AI. The first two do not exist in a tab and the editor hangs waiting for a
 * reply if it hears nothing; the third is refused rather than pointed at
 * Polaris' own agent, because its requests carry a provider and a key GenOffice
 * would have supplied, and answering them quietly would be spending somebody's
 * credits through a surface they never configured.
 */

// The editor's own stylesheets, fenced inside the class it is rendered in - see
// `scripts/scope-editor-styles`. Statically: a stylesheet imported inside an
// effect is one the bundler never sees.
import "@polaris/genoffice-markdown/styles.css";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

/** The editor's own root. Never rendered on the server: it measures its own
 *  container and reaches for `window` as it starts. */
const Editor = dynamic(
    async () => (await import("@polaris/genoffice-markdown")).default,
    {
        ssr: false,
        loading: () => (
            <div className="flex min-h-[50vh] items-center justify-center">
                <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                <span className="sr-only">Opening the editor</span>
            </div>
        )
    }
);

/** A subscription that will never fire: what a menu bar used to drive. Returned
 *  so the editor's own unsubscribe still works. */
const never = (): (() => void) => () => undefined;

export function RichMarkdownEditor({
    text,
    name,
    theme,
    onChange
}: {
    /** What the file holds, already read by the viewer around this. */
    text: string;
    name: string;
    theme: "light" | "dark";
    /** Every change, so the toolbar's own Save writes what is on screen. The
     *  saving stays with `EditorActions`, which is what every other editor in
     *  Drive writes through - a second save path is a second set of rules about
     *  when a file may be overwritten. */
    onChange: (next: string) => void;
}) {
    const latest = useRef(onChange);
    latest.current = onChange;

    const api = useMemo(
        () => ({
            consumePending: async () => name,
            readFile: async () => text,
            save: async (request: { text: string }) => {
                latest.current(request.text);
                // Answered as done: what "saved" means here is the toolbar's
                // Save, and telling the editor otherwise makes it prompt.
                return { ok: true as const, path: name };
            },
            setDirty: () => undefined,
            onSaveRequest: never,
            sendSaveRequestAck: () => undefined,
            onCloseSaveRequest: never,
            sendCloseSaveResult: () => undefined,
            onFileRenamed: never,
            onChromePressed: never,
            onExportRequest: never,
            onPrintRequest: never,
            pickImage: async () => null,
            saveImage: async () => null,
            readImage: async () => null,
            exportDocx: async () => ({ ok: false as const, error: "Use Download beside Save." }),
            exportPdf: async () => {
                window.print();
                return { ok: true as const, canceled: true as const };
            },
            getLanguage: async () => "en",
            onLanguageChanged: never,
            getTheme: async () => theme,
            onThemeChanged: never,
            getAiSettings: async () => ({ providers: [], activeProvider: null, enabled: false }),
            aiStream: async () => undefined,
            aiStreamCancel: async () => undefined,
            onAiStream: never,
            webSearch: async () => ({ results: [], method: "error", error: "Not connected." }),
            imageSearch: async () => ({ images: [], method: "error", error: "Not connected." }),
            fetchImage: async () => null,
            aiGenerateImage: async () => ({ error: "Not connected." })
        }),
        [name, text, theme]
    );

    // Set before the editor mounts, because it reads the bridge as it starts.
    // On the window rather than through a prop: that is the shape the editor was
    // written against, and changing it would mean editing vendored code at every
    // one of its twenty-six call sites.
    useEffect(() => {
        const shell = window as unknown as Record<string, unknown>;
        const held = shell.markdownApi;
        shell.markdownApi = api;
        return () => {
            shell.markdownApi = held;
        };
    }, [api]);

    // Fenced, like the Word editor beside it: every rule in the stylesheet above
    // is written under this class, so the editor's `*` and `body` rules cannot
    // reach the viewer around it.
    return (
        <div className="genoffice-markdown h-full">
            <Editor />
        </div>
    );
}
