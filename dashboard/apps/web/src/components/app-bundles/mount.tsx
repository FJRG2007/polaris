"use client";

/**
 * Where an installed app's client component is drawn when the app came as a
 * bundle.
 *
 * Next compiles the client components it knows about into its own chunks; an
 * app's arrive afterwards, as ES modules the browser imports from the app's
 * bundle. The server half of the app draws this in their place with the module's
 * address and the props the component was given, and this loads the module and
 * draws the component with them.
 *
 * Nothing is drawn until the module is here, as nothing would be while its chunk
 * loads for a component Next compiled.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

type State = { component?: ComponentType<Record<string, unknown>>; failed?: boolean };

export function AppBundleMount({
    src,
    name,
    props
}: {
    src: string;
    name: string;
    props: Record<string, unknown>;
}) {
    const t = useTranslations("components");
    const router = useRouter();
    const [state, setState] = useState<State>({});

    useEffect(() => {
        let live = true;
        import("./runtime")
            .then((runtime) => runtime.loadAppModule(src, router))
            .then((module) => {
                const component = module[name];
                if (!live) return;
                if (typeof component !== "function" && typeof component !== "object") {
                    throw new Error(`${src} has no ${name}`);
                }
                setState({ component: component as ComponentType<Record<string, unknown>> });
            })
            .catch((error: unknown) => {
                console.error(`polaris: an app component could not be loaded (${name}):`, error);
                if (live) setState({ failed: true });
            });
        return () => {
            live = false;
        };
    }, [src, name, router]);

    if (state.failed) {
        return (
            <p role="alert" className="text-sm text-muted-foreground">
                {t("appBundles.partFailed")}
            </p>
        );
    }
    const Component = state.component;
    return Component ? <Component {...props} /> : null;
}
