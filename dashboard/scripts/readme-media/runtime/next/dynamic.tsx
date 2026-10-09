/** `next/dynamic` as React's own lazy loading. */

import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

type Loader<P> = () => Promise<ComponentType<P> | { default: ComponentType<P> }>;

export default function dynamic<P extends object>(load: Loader<P>, options?: { loading?: () => ReactNode }) {
    const Lazy = lazy(async () => {
        const loaded = await load();
        return "default" in loaded ? loaded : { default: loaded };
    });
    return function Dynamic(props: P) {
        return (
            <Suspense fallback={options?.loading?.() ?? null}>
                <Lazy {...props} />
            </Suspense>
        );
    };
}
