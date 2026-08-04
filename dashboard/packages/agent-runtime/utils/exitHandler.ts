import os from "node:os";

type ExitSignalHandler = (signal: "SIGINT" | "SIGTERM") => void | Promise<void>;

const handlers = new Set<ExitSignalHandler>();
let installed = false;

/**
 * Register a handler to run when the process receives SIGINT or SIGTERM.
 * Returns a dispose function that removes the handler.
 */
export function onExitSignal(handler: ExitSignalHandler): () => void {
  installSignalHandlers();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

function installSignalHandlers(): void {
  if (installed) return;
  installed = true;

  async function handleSignal(signal: "SIGINT" | "SIGTERM") {
    await Promise.allSettled([...handlers].map((h) => Promise.try(h, signal)));
    exitWithSignal(signal);
  }

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

export function exitWithSignal(signal: "SIGINT" | "SIGTERM") {
  process.exit(128 + os.constants.signals[signal]);
}
