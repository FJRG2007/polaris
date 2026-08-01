import { TriangleAlert } from "lucide-react";

/** The warning strip the Runners screens share. Plain markup, so the streamed
 *  server component and the client view can both render one. */
export function Notice({ children }: { children: React.ReactNode }) {
    return (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {children}
        </p>
    );
}
