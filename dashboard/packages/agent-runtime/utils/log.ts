/**
 * Logging utilities that work well in both local and GitHub Actions environments
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as core from "@actions/core";
import { table } from "table";
import { type AgentUsage, formatCostUsd } from "../agents/shared.ts";
import { isDebugEnabled } from "./activity.ts";
import { isGitHubActions, isInsideDocker } from "./globals.ts";

// --- log prefix via AsyncLocalStorage ---

type LogContext = { prefix: string };

const logContext = new AsyncLocalStorage<LogContext>();

const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

/** run `fn` with every log line prefixed by `prefix` (e.g. "[task-label]") in magenta */
export function withLogPrefix<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  return logContext.run({ prefix }, fn);
}

function prefixLines(message: string): string {
  const ctx = logContext.getStore();
  if (!ctx) return message;
  const colored = `${MAGENTA}${ctx.prefix}${RESET} `;
  return message
    .split("\n")
    .map((line) => `${colored}${line}`)
    .join("\n");
}

/** plain-text prefix (no ANSI) for GitHub Actions group names */
function prefixPlain(name: string): string {
  const ctx = logContext.getStore();
  if (!ctx) return name;
  return `${ctx.prefix} ${name}`;
}

// distinct from the shared `isDebugEnabled` composite: `log.debug` uses these
// to pick an output CHANNEL - `core.debug()` (a `::debug::` annotation GitHub
// only renders in a debug run) vs a plain `core.info()` line locally.
const isRunnerDebugEnabled = () => core.isDebug();

const isLocalDebugEnabled = () =>
  process.env.LOG_LEVEL === "debug" || process.env.ACTIONS_STEP_DEBUG === "true";

/** timestamp prefix for debug mode - empty string when debug is off */
function ts(): string {
  return isDebugEnabled() ? `[${new Date().toISOString()}] ` : "";
}

/**
 * Format arguments into a single string for logging
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
      return JSON.stringify(arg);
    })
    .join(" ");
}

/**
 * Start a collapsed group (GitHub Actions) or regular group (local)
 */
function startGroup(name: string): void {
  const prefixed = prefixPlain(name);
  if (isGitHubActions) {
    core.startGroup(prefixed);
  } else {
    console.group(prefixed);
  }
}

/**
 * End a collapsed group
 */
function endGroup(): void {
  if (isGitHubActions) {
    core.endGroup();
  } else {
    console.groupEnd();
  }
}

/**
 * Run a callback within a collapsed group
 */
function group(name: string, fn: () => void): void {
  startGroup(name);
  fn();
  endGroup();
}

/**
 * Print a formatted box with text (for console output)
 */
function boxString(
  text: string,
  options?: {
    title?: string;
    maxWidth?: number;
    indent?: string;
    padding?: number;
  }
): string {
  const { title, maxWidth = 80, indent = "", padding = 1 } = options || {};

  const lines = text.trim().split("\n");
  const wrappedLines: string[] = [];

  for (const line of lines) {
    if (line.length <= maxWidth - padding * 2) {
      wrappedLines.push(line);
    } else {
      const words = line.split(" ");
      let currentLine = "";

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (testLine.length <= maxWidth - padding * 2) {
          currentLine = testLine;
        } else {
          if (currentLine) {
            wrappedLines.push(currentLine);
            currentLine = "";
          }
          // wrap long words by breaking them into chunks
          const maxLineLength = maxWidth - padding * 2;
          let remainingWord = word;
          while (remainingWord.length > maxLineLength) {
            wrappedLines.push(remainingWord.substring(0, maxLineLength));
            remainingWord = remainingWord.substring(maxLineLength);
          }
          currentLine = remainingWord;
        }
      }

      if (currentLine) {
        wrappedLines.push(currentLine);
      }
    }
  }

  const maxLineLength = Math.max(...wrappedLines.map((line) => line.length));
  const contentBoxWidth = maxLineLength + padding * 2;

  // ensure box width is at least as wide as the title line when title exists
  const titleLineLength = title ? ` ${title} `.length : 0;
  const boxWidth = Math.max(contentBoxWidth, titleLineLength);

  let result = "";

  if (title) {
    const titleLine = ` ${title} `;
    const titlePadding = Math.max(0, boxWidth - titleLine.length);
    result += `${indent}┌${titleLine}${"─".repeat(titlePadding)}┐\n`;
  }

  if (!title) {
    result += `${indent}┌${"─".repeat(boxWidth)}┐\n`;
  }

  for (const line of wrappedLines) {
    const paddedLine = line.padEnd(maxLineLength);
    result += `${indent}│${" ".repeat(padding)}${paddedLine}${" ".repeat(padding)}│\n`;
  }

  result += `${indent}└${"─".repeat(boxWidth)}┘`;

  return result;
}

/**
 * Print a formatted box with text
 */
function box(
  text: string,
  options?: {
    title?: string;
    maxWidth?: number;
  }
): void {
  const boxContent = boxString(text, options);
  core.info(prefixLines(boxContent));
}

/**
 * Overwrite the job summary with the given text.
 * Skips if:
 * - Not in GitHub Actions
 * - Running inside Docker (CI tests inherit host env vars but can't access host paths)
 * - GITHUB_STEP_SUMMARY not set
 */
export async function writeSummary(text: string): Promise<void> {
  if (!isGitHubActions) return;

  // CI tests run in Docker with GITHUB_ACTIONS=true inherited from host,
  // but the GITHUB_STEP_SUMMARY path points to a host filesystem location
  // that doesn't exist inside the container
  if (isInsideDocker) return;

  if (!process.env.GITHUB_STEP_SUMMARY) return;

  await core.summary.addRaw(text).write({ overwrite: true });
}

/**
 * Print a formatted table using the table package
 */
function printTable(
  rows: Array<Array<{ data: string; header?: boolean } | string>>,
  options?: {
    title?: string;
  }
): void {
  const { title } = options || {};

  // Convert rows to string arrays for the table package
  const tableData = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell === "string") {
        return cell;
      }
      return cell.data;
    })
  );

  const formatted = table(tableData);

  if (title) {
    core.info(prefixLines(`\n${title}`));
  }
  core.info(prefixLines(`\n${formatted}\n`));
}

/**
 * Print a separator line
 */
function separator(length: number = 50): void {
  const separatorText = "─".repeat(length);
  core.info(prefixLines(separatorText));
}

/**
 * Main logging utility object - import this once and access all utilities
 */
export const log = {
  /** Print info message */
  info: (...args: unknown[]): void => {
    core.info(prefixLines(`${ts()}${formatArgs(args)}`));
  },

  /** Print a warning message. Use only for warnings that should be displayed in the job summary. */
  warning: (...args: unknown[]): void => {
    core.warning(prefixLines(`${ts()}${formatArgs(args)}`));
  },

  /** Print an error message. Use only for errors that should be displayed in the job summary. */
  error: (...args: unknown[]): void => {
    core.error(prefixLines(`${ts()}${formatArgs(args)}`));
  },

  /** Print success message */
  success: (...args: unknown[]): void => {
    core.info(prefixLines(`${ts()}» ${formatArgs(args)}`));
  },

  /** Print debug message (only when debug mode is enabled) */
  debug: (...args: unknown[]): void => {
    if (isRunnerDebugEnabled()) {
      core.debug(prefixLines(formatArgs(args)));
      return;
    }
    if (isLocalDebugEnabled()) {
      core.info(prefixLines(`${ts()}[DEBUG] ${formatArgs(args)}`));
    }
  },

  /** Print a formatted box with text */
  box,

  /** Print a formatted table using the table package */
  table: printTable,

  /** Print a separator line */
  separator,

  /** Start a collapsed group (GitHub Actions) or regular group (local) */
  startGroup,

  /** End a collapsed group */
  endGroup,

  /** Run a callback within a collapsed group */
  group,

  /** Log tool call information to console with formatted output */
  toolCall: ({ toolName, input }: { toolName: string; input: unknown }): void => {
    const inputFormatted = formatJsonValue(input);
    const output = inputFormatted !== "{}" ? `» ${toolName}(${inputFormatted})` : `» ${toolName}()`;

    log.info(output.trimEnd());
  },
};

/**
 * Format a value as JSON, using compact format for simple values and pretty-printed for complex ones
 */
export function formatJsonValue(value: unknown): string {
  const compact = JSON.stringify(value);
  return compact.length > 80 || compact.includes("\n") ? JSON.stringify(value, null, 2) : compact;
}

/**
 * Format a multi-line string with proper indentation for tool call output
 * First line has the label, subsequent lines are indented 4 spaces
 */
export function formatIndentedField(label: string, content: string): string {
  if (!content.includes("\n")) {
    return `  ${label}: ${content}\n`;
  }

  const lines = content.split("\n");
  let formatted = `  ${label}: ${lines[0]}\n`;
  for (let i = 1; i < lines.length; i++) {
    formatted += `    ${lines[i]}\n`;
  }
  return formatted;
}

/**
 * format aggregated usage data as a markdown table for the GitHub step summary.
 *
 * columns mirror the per-run stdout token table emitted by `logTokenTable`
 * (Input / Cache Read / Cache Write / Output / Total / Cost ($)) so the job
 * summary and the in-run logs can be compared row-for-row.
 *
 * notes:
 *   - `AgentUsage.inputTokens` is the sum of non-cached input + cache read
 *     + cache write (set that way by both agent harnesses' `buildUsage`),
 *     so the non-cached Input column is recovered by subtracting cache fields.
 *   - `costUsd` is sourced from models.dev (OpenCode) or `total_cost_usd`
 *     (Claude CLI). absent rows show `-` so per-agent coverage is obvious.
 */
export function formatUsageSummary(entries: AgentUsage[]): string {
  if (entries.length === 0) return "";

  const header = "| Agent | Input | Cache Read | Cache Write | Output | Total | Cost ($) |";
  const separatorRow = "| --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  const fmt = (n: number) => n.toLocaleString("en-US");

  const nonCachedInput = (e: AgentUsage): number =>
    Math.max(0, e.inputTokens - (e.cacheReadTokens ?? 0) - (e.cacheWriteTokens ?? 0));
  const totalFor = (e: AgentUsage): number =>
    nonCachedInput(e) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0) + e.outputTokens;
  const costCell = (e: AgentUsage): string =>
    typeof e.costUsd === "number" && e.costUsd > 0 ? formatCostUsd(e.costUsd) : "-";

  const rows = entries.map(
    (e) =>
      `| ${e.agent} | ${fmt(nonCachedInput(e))} | ${fmt(e.cacheReadTokens ?? 0)} | ${fmt(e.cacheWriteTokens ?? 0)} | ${fmt(e.outputTokens)} | ${fmt(totalFor(e))} | ${costCell(e)} |`
  );

  const totalsRows: string[] = [];
  if (entries.length > 1) {
    const totalInput = entries.reduce((sum, e) => sum + nonCachedInput(e), 0);
    const totalOutput = entries.reduce((sum, e) => sum + e.outputTokens, 0);
    const totalCacheRead = entries.reduce((sum, e) => sum + (e.cacheReadTokens ?? 0), 0);
    const totalCacheWrite = entries.reduce((sum, e) => sum + (e.cacheWriteTokens ?? 0), 0);
    const grandTotal = totalInput + totalCacheRead + totalCacheWrite + totalOutput;
    const totalCostUsd = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    const totalCostCell = totalCostUsd > 0 ? `**${formatCostUsd(totalCostUsd)}**` : "-";
    totalsRows.push(
      `| **Total** | **${fmt(totalInput)}** | **${fmt(totalCacheRead)}** | **${fmt(totalCacheWrite)}** | **${fmt(totalOutput)}** | **${fmt(grandTotal)}** | ${totalCostCell} |`
    );
  }

  return [
    "<details>",
    "<summary>Usage</summary>",
    "",
    header,
    separatorRow,
    ...rows,
    ...totalsRows,
    "",
    "</details>",
  ].join("\n");
}
