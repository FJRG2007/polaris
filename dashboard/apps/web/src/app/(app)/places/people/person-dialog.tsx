"use client";

/**
 * Adding somebody the cameras should know.
 *
 * A name and their photographs, in one step, because they are one thing: a
 * person with no photographs is a row that recognizes nobody, and the cameras
 * will keep reporting them as a stranger. Asking for the name first and leaving
 * the photographs to a second, easily-skipped step is how a list of names that
 * does nothing gets built.
 *
 * Several photographs at once for the same reason. One photograph recognizes
 * that photograph; four or five, in different light, recognize a person.
 */

import * as actions from "../actions";
import { useRef, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { PersonView } from "@/lib/home/people";
import { ImagePlus, Loader2, X } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** What one chosen file looks like while it is waiting to be sent. */
interface Chosen {
    readonly file: File;
    readonly preview: string;
}

export function PersonDialog({
    recognizerReady,
    onClose,
    onSaved
}: {
    /** Whether there is anything to teach. Without a recognizer a name can still
     *  be written down - it starts working the moment one is connected - but
     *  photographs have nowhere to go, and the dialog says so instead of
     *  accepting them into nothing. */
    recognizerReady: boolean;
    onClose: () => void;
    onSaved: (person: PersonView) => void;
}) {
    const [name, setName] = useState("");
    const [chosen, setChosen] = useState<Chosen[]>([]);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);

    const add = (files: FileList | null) => {
        if (!files) return;
        setChosen((current) => [
            ...current,
            ...[...files].map((file) => ({ file, preview: URL.createObjectURL(file) }))
        ]);
    };

    const drop = (index: number) => {
        setChosen((current) => {
            const removed = current[index];
            if (removed) URL.revokeObjectURL(removed.preview);
            return current.filter((_, at) => at !== index);
        });
    };

    const save = async () => {
        setBusy(true);
        setError(null);
        const created = await runAction(() => actions.addPersonAction(name), setError);
        if (!created || created.error || !created.person) {
            setBusy(false);
            if (created?.error) setError(created.error);
            return;
        }

        // The photographs are sent one at a time and their failures are
        // collected rather than thrown: a face the recognizer refuses - a photo
        // with nobody in it, usually - should not undo the person or the four
        // photographs that worked.
        const refused: string[] = [];
        for (const [index, item] of chosen.entries()) {
            setProgress(`Sending ${index + 1} of ${chosen.length}`);
            const bytes = new Uint8Array(await item.file.arrayBuffer());
            const result = await runAction(
                () => actions.addFaceAction(created.person!.id, bytes),
                (message) => refused.push(message)
            );
            if (result?.error) refused.push(`${item.file.name}: ${result.error}`);
        }
        setBusy(false);
        setProgress("");

        if (refused.length > 0) {
            setError(`${refused.length} of ${chosen.length} photographs were not accepted. ${refused[0]}`);
            // The person exists either way, so the list is told about them.
            onSaved({ ...created.person, faces: chosen.length - refused.length });
            return;
        }
        onSaved({ ...created.person, faces: chosen.length });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add somebody</DialogTitle>
                    <DialogDescription>
                        Their name, and a few photographs of their face. Without photographs the cameras still see
                        them - they are just reported as a stranger.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-[12px] font-medium text-muted-foreground">
                            Name<span className="text-danger"> *</span>
                        </span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Ana"
                            autoFocus
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-[12px] font-medium text-muted-foreground">Photographs</span>
                        {chosen.length > 0 ? (
                            <ul className="flex flex-wrap gap-2">
                                {chosen.map((item, index) => (
                                    <li key={item.preview} className="relative">
                                        {/* eslint-disable-next-line @next/next/no-img-element -- a
                                            local object URL, never fetched over the network. */}
                                        <img
                                            src={item.preview}
                                            alt=""
                                            className="size-16 rounded-md border border-border object-cover"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => drop(index)}
                                            aria-label="Remove this photograph"
                                            className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-elevated text-foreground-subtle hover:text-foreground"
                                        >
                                            <X className="size-3 shrink-0" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="self-start"
                            disabled={!recognizerReady}
                            onClick={() => fileInput.current?.click()}
                        >
                            <ImagePlus className="size-4 shrink-0" />
                            {chosen.length > 0 ? "Add more" : "Choose photographs"}
                        </Button>
                        <span className="text-[11px] text-foreground-subtle">
                            {recognizerReady
                                ? "Four or five, in different light, one face per photograph. One photograph recognizes that photograph; several recognize a person."
                                : "Nothing is recognizing faces yet, so there is nowhere to send them. Set one up under Settings - the name can be written down now and starts working then."}
                        </span>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/jpeg,image/png"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                                add(event.target.files);
                                event.target.value = "";
                            }}
                        />
                    </div>
                </div>

                {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={busy || !name.trim()}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {progress || "Add person"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
