import path from "path"

const PLUGIN_MAX_PROTOCOL_VERSION = 1

function negotiateProtocolVersion(): number {
  const ptermVersion = parseInt(
    process.env.POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION || "1",
    10,
  )
  if (isNaN(ptermVersion)) return PLUGIN_MAX_PROTOCOL_VERSION
  return Math.min(ptermVersion, PLUGIN_MAX_PROTOCOL_VERSION)
}

interface PayloadBase {
  v: number
  agent: string
  event: string
  session_id: string
  cwd: string
  project: string
}

function buildPayload(
  event: string,
  sessionId: string,
  cwd: string,
  extraFields: Record<string, unknown> = {},
): string {
  const base: PayloadBase = {
    v: negotiateProtocolVersion(),
    agent: "opencode",
    event,
    session_id: sessionId,
    cwd,
    project: cwd ? path.basename(cwd) : "",
  }
  return JSON.stringify({ ...base, ...extraFields })
}

export { buildPayload, negotiateProtocolVersion, PLUGIN_MAX_PROTOCOL_VERSION }
