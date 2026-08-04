import { performance } from "node:perf_hooks";
import { log } from "./cli.ts";

export class Timer {
  private initialTimestamp: number;
  private lastCheckpointTimestamp: number | null = null;

  constructor() {
    this.initialTimestamp = performance.now();
  }

  checkpoint(name: string): void {
    const now = performance.now();
    const duration = this.lastCheckpointTimestamp
      ? now - this.lastCheckpointTimestamp
      : now - this.initialTimestamp;

    log.debug(`» ${name}: ${duration}ms`);
    this.lastCheckpointTimestamp = now;
  }
}

const THINKING_THRESHOLD = 3000; // ms

/**
 * Measures wall-clock gap between the last tool_result and the next tool_call,
 * surfacing it as a "thought for Xs" log when over `THINKING_THRESHOLD`.
 *
 * Use one instance per logical session (orchestrator, each subagent) - sharing
 * a single timer across sessions conflates cross-session interleaving as
 * thinking time. The optional `formatLine` lets the caller prefix output with
 * a session label so attribution is visible in the merged log stream.
 */
export class ThinkingTimer {
  private readonly durationFormatter = new Intl.NumberFormat("en-US", {
    style: "unit",
    unit: "second",
    unitDisplay: "long",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });

  private lastToolResultTimestamp: number | null = null;
  private readonly formatLine: (line: string) => string;

  // node's native TS strip-only mode does not support parameter properties,
  // so the formatter is declared as a field and assigned in the body.
  constructor(formatLine: (line: string) => string = (l) => l) {
    this.formatLine = formatLine;
  }

  markToolResult(): void {
    this.lastToolResultTimestamp = performance.now();
    log.debug(
      this.formatLine(`» thinking timer: markToolResult at ${this.lastToolResultTimestamp}`)
    );
  }

  markToolCall(): void {
    const now = performance.now();
    log.debug(
      this.formatLine(
        `» thinking timer: markToolCall at ${now}, lastToolResult=${this.lastToolResultTimestamp}`
      )
    );
    if (this.lastToolResultTimestamp === null) return;
    const elapsed = now - this.lastToolResultTimestamp;
    if (elapsed < THINKING_THRESHOLD) return;
    const seconds = elapsed / 1000;
    log.info(this.formatLine(`» thought for ${this.durationFormatter.format(seconds)}`));
  }
}
