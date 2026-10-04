/**
 * A status as a tinted chip - a service, a database, a release - shared by the
 * list, the canvas and the observability view so the same state reads the same
 * everywhere. Kept out of deploy-view.tsx so a screen can draw one without
 * importing the whole Deploy panel and every server action behind it.
 */

export function StatusPill({
    tone,
    label,
    capitalize = true
}: {
    tone: "success" | "warning" | "danger" | "idle";
    label: string;
    /** Off for a label that is already words in the reader's language: it would
     *  turn "En marcha" into "En Marcha". On for a raw status like "running". */
    capitalize?: boolean;
}) {
    const dot = {
        success: "bg-success-solid",
        warning: "bg-warning-solid",
        danger: "bg-danger-solid",
        idle: "bg-muted-foreground"
    }[tone];
    // Tint the whole chip by tone so state reads in color at a glance, Railway-style.
    const chip = {
        success: "border-success-edge bg-success-soft text-success-ink",
        warning: "border-warning-edge bg-warning-soft text-warning-ink",
        danger: "border-danger-edge bg-danger-soft text-danger-ink",
        idle: "border-border/60 bg-surface text-muted-foreground"
    }[tone];
    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${capitalize ? "capitalize" : ""} ${chip}`}
        >
            {/* Something under way sends a halo out from its dot, so a deploy in
                progress reads as moving without the label itself blinking. */}
            <span className="relative flex size-1.5 shrink-0">
                {tone === "warning" && (
                    <span
                        aria-hidden
                        className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none ${dot}`}
                    />
                )}
                <span className={`relative size-1.5 rounded-full ${dot}`} />
            </span>
            {label}
        </span>
    );
}

export function dbTone(status: string): "success" | "warning" | "danger" | "idle" {
    const value = status.toLowerCase();
    if (["running", "active", "healthy", "ready"].includes(value)) return "success";
    if (["failed", "error", "stopped"].includes(value)) return "danger";
    if (["queued", "provisioning", "deploying", "pending", "building"].includes(value))
        return "warning";
    return "idle";
}
