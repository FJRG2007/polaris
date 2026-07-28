"use client";

/**
 * Whether a form currently holds different values than the ones it opened with.
 * Forms that submit through FormData keep their values in the DOM rather than in
 * React state, so this reads them back on every edit instead of asking each field
 * to become controlled: typing a change and undoing it leaves the form equal to
 * its starting point, and Save goes back to being unavailable.
 *
 * A blank password field means "keep the stored secret" in these dialogs, so it
 * compares equal to the blank it started as - the same rule the server applies.
 */

import { useCallback, useRef, useState } from "react";

/**
 * Everything a form holds, as one comparable string. Files are compared by
 * identity (name and size), which is as close as the DOM lets us get, and field
 * order is normalized so a re-render cannot look like an edit.
 */
export function formSnapshot(data: FormData): string {
    const parts: string[] = [];
    for (const [name, value] of data.entries()) {
        parts.push(`${name}=${value instanceof File ? `${value.name}:${value.size}` : value}`);
    }
    return parts.sort().join("\n");
}

const snapshot = (form: HTMLFormElement): string => formSnapshot(new FormData(form));

export interface FormChanged {
    /** Spread onto the <form>: captures the starting values and watches edits. */
    formProps: {
        ref: (form: HTMLFormElement | null) => void;
        onInput: () => void;
        onChange: () => void;
    };
    /** True once the form differs from what it opened with. */
    changed: boolean;
    /** Treat the current values as the new starting point (call after a save). */
    commit: () => void;
}

export function useFormChanged(): FormChanged {
    const formRef = useRef<HTMLFormElement | null>(null);
    const initial = useRef<string | null>(null);
    const [changed, setChanged] = useState(false);

    const compare = useCallback(() => {
        const form = formRef.current;
        if (!form || initial.current === null) return;
        setChanged(snapshot(form) !== initial.current);
    }, []);

    const ref = useCallback((form: HTMLFormElement | null) => {
        formRef.current = form;
        // Remounting with different defaults (another row, another dialog) starts
        // a fresh comparison rather than measuring against the previous form.
        initial.current = form ? snapshot(form) : null;
        setChanged(false);
    }, []);

    const commit = useCallback(() => {
        const form = formRef.current;
        initial.current = form ? snapshot(form) : null;
        setChanged(false);
    }, []);

    return { formProps: { ref, onInput: compare, onChange: compare }, changed, commit };
}
