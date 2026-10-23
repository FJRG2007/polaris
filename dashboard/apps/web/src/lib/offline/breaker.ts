/**
 * A circuit breaker with an exponential retry: what lets Polaris stop asking
 * something that is not answering, and notice by itself when it answers again.
 *
 * Closed, everything passes. Enough failures in a row open it, and while it is
 * open every caller is refused at once - instead of each one waiting out its own
 * timeout. Once the retry window has passed, exactly one caller is let through as
 * a probe (half-open): its success closes the breaker, its failure doubles the
 * window, up to a ceiling. A probe that never reports back loses its lease, so a
 * cancelled request cannot hold the breaker open forever.
 *
 * Pure apart from the clock it is handed, so a test drives it without timers.
 */

export type Admission = "pass" | "probe" | "refuse";

export interface BreakerOptions {
    /** Failures in a row, by weight, that open it. */
    threshold?: number;
    /** The first window it stays open for. Doubled after every failed probe. */
    firstRetryMs?: number;
    /** The longest the window grows to. */
    maxRetryMs?: number;
    /** How long a probe may stay out before another caller may probe instead. */
    probeLeaseMs?: number;
    now?: () => number;
    /** Told once when it opens and once when it closes again - never per call. */
    onChange?: (open: boolean) => void;
}

export class Breaker {
    private readonly threshold: number;
    private readonly firstRetryMs: number;
    private readonly maxRetryMs: number;
    private readonly probeLeaseMs: number;
    private readonly now: () => number;
    private readonly onChange: (open: boolean) => void;

    private failures = 0;
    private opened = false;
    private retryMs: number;
    private retryAt = 0;
    private probeSince: number | null = null;

    constructor(options: BreakerOptions = {}) {
        this.threshold = options.threshold ?? 1;
        this.firstRetryMs = options.firstRetryMs ?? 15_000;
        this.maxRetryMs = options.maxRetryMs ?? 120_000;
        this.probeLeaseMs = options.probeLeaseMs ?? 30_000;
        this.now = options.now ?? Date.now;
        this.onChange = options.onChange ?? (() => undefined);
        this.retryMs = this.firstRetryMs;
    }

    get isOpen(): boolean {
        return this.opened;
    }

    /** When the next probe is allowed, while open. */
    get retryAtMs(): number | null {
        return this.opened ? this.retryAt : null;
    }

    /** Whether a call may go out now, and whether it is the probe. */
    admit(): Admission {
        if (!this.opened) return "pass";
        const now = this.now();
        if (now < this.retryAt) return "refuse";
        if (this.probeSince !== null && now - this.probeSince < this.probeLeaseMs) return "refuse";
        this.probeSince = now;
        return "probe";
    }

    /** Something answered. Any success is proof, the probe's or a straggler's. */
    succeed(): void {
        const was = this.opened;
        this.failures = 0;
        this.opened = false;
        this.probeSince = null;
        this.retryMs = this.firstRetryMs;
        if (was) this.onChange(false);
    }

    /** Something did not answer. A heavier failure opens it sooner. */
    fail(weight = 1): void {
        if (this.opened) {
            // A call already in flight when it opened says nothing new; only the
            // probe moves the window.
            if (this.probeSince === null) return;
            this.probeSince = null;
            this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
            this.retryAt = this.now() + this.retryMs;
            return;
        }
        this.failures += weight;
        if (this.failures < this.threshold) return;
        this.opened = true;
        this.retryAt = this.now() + this.retryMs;
        this.onChange(true);
    }
}
