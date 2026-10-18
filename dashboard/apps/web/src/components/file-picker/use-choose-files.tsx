"use client";

/**
 * The shared picker, asked for like the browser's own chooser: a screen calls
 * `choose()` where it used to click a hidden file input, and gets back the
 * chosen files - from this computer, a storage or an address - as plain `File`s.
 * A closed picker answers with no files.
 *
 * Render the returned element anywhere in the screen; it is empty until asked.
 */

import dynamic from "next/dynamic";
import { useCallback, useState, type ReactNode, type SyntheticEvent } from "react";

const ChooseFilesDialog = dynamic(
    () => import("./choose-files-dialog").then((module) => module.ChooseFilesDialog),
    { ssr: false }
);

export interface ChooseFilesOptions {
    /** What the screen can take, written as a file input's `accept`. */
    accept?: string;
    multiple?: boolean;
    title?: string;
    /** A pick that could not be fetched, in a sentence the screen can show. */
    onFailed?: (message: string) => void;
}

function stop(event: SyntheticEvent): void {
    event.stopPropagation();
}

interface Asked {
    options: ChooseFilesOptions;
    answer: (files: File[]) => void;
}

export function useChooseFiles(): [(options?: ChooseFilesOptions) => Promise<File[]>, ReactNode] {
    const [asked, setAsked] = useState<Asked | null>(null);

    const choose = useCallback(
        (options: ChooseFilesOptions = {}) =>
            new Promise<File[]>((answer) => setAsked({ options, answer })),
        []
    );

    // The dialog is a portal, but React still bubbles its events through the
    // screen that rendered it - often a drop zone or a clickable card - so a
    // click or a drop inside the picker stops here instead of reaching it.
    const element = asked ? (
        <span
            className="contents"
            onClick={stop}
            onDoubleClick={stop}
            onDragEnter={stop}
            onDragOver={stop}
            onDragLeave={stop}
            onDrop={stop}
        >
            <ChooseFilesDialog
                accept={asked.options.accept}
                multiple={asked.options.multiple ?? false}
                title={asked.options.title}
                onFailed={asked.options.onFailed}
                onFiles={(files) => asked.answer(files)}
                onClose={() => {
                    asked.answer([]);
                    setAsked(null);
                }}
            />
        </span>
    ) : null;

    return [choose, element];
}
