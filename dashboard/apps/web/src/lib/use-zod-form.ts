"use client";

/**
 * Real-time form validation against a shared Zod schema. Fields validate as the
 * user types; an error only surfaces once the field has been left (blurred) or a
 * submit has been attempted, which keeps the form from shouting at half-typed
 * input. The same schema is enforced by the server action, so client and server
 * never disagree.
 */

import { useCallback, useState } from "react";
import type { ZodType } from "zod";

export interface ZodForm<T> {
    /** Error to display for a field, or undefined if it should stay hidden. */
    error: (name: string) => string | undefined;
    /** Re-run validation over the whole value object (call on every change). */
    revalidate: (values: unknown) => void;
    /** Mark a field as blurred so its error may show. */
    markTouched: (name: string) => void;
    /** Validate on submit; returns parsed data or null and reveals all errors. */
    submit: (values: unknown) => T | null;
}

function collect(schema: ZodType, values: unknown): Record<string, string> {
    const result = schema.safeParse(values);
    if (result.success) return {};
    const errors: Record<string, string> = {};
    for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !errors[key]) errors[key] = issue.message;
    }
    return errors;
}

export function useZodForm<T>(schema: ZodType<T>): ZodForm<T> {
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [submitted, setSubmitted] = useState(false);

    const revalidate = useCallback((values: unknown) => setErrors(collect(schema, values)), [schema]);

    const markTouched = useCallback((name: string) => {
        setTouched((prev) => (prev[name] ? prev : { ...prev, [name]: true }));
    }, []);

    const error = useCallback(
        (name: string) => (submitted || touched[name] ? errors[name] : undefined),
        [errors, touched, submitted]
    );

    const submit = useCallback(
        (values: unknown): T | null => {
            setSubmitted(true);
            const result = schema.safeParse(values);
            if (result.success) {
                setErrors({});
                return result.data;
            }
            setErrors(collect(schema, values));
            return null;
        },
        [schema]
    );

    return { error, revalidate, markTouched, submit };
}
