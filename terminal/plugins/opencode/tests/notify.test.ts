import { describe, it, afterEach, mock } from "bun:test"
import { expect } from "bun:test"
import fs from "fs"

const writeSpy = mock(() => {})
mock.module("fs", () => ({
  ...fs,
  writeFileSync: writeSpy,
}))

const { ptermNotify } = await import("../src/notify")

describe("ptermNotify", () => {
  const originalVersion = process.env.POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION

  afterEach(() => {
    writeSpy.mockClear()
    if (originalVersion === undefined) {
      delete process.env.POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION
    } else {
      process.env.POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION = originalVersion
    }
  })

  it("skips when POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION is not set", () => {
    delete process.env.POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION
    ptermNotify("title", "body")
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("writes OSC 777 sequence when Polaris Terminal declares protocol support", () => {
    process.env.POLARIS_TERMINAL_CLI_AGENT_PROTOCOL_VERSION = "1"
    ptermNotify("polaris-terminal://cli-agent", '{"event":"stop"}')
    expect(writeSpy).toHaveBeenCalledTimes(1)

    const [path, data] = writeSpy.mock.calls[0] as [string, string]
    expect(path).toBe("/dev/tty")
    expect(data).toContain("polaris-terminal://cli-agent")
    expect(data).toContain('{"event":"stop"}')
    expect(data).toMatch(/^\x1b\]777;notify;/)
    expect(data).toMatch(/\x07$/)
  })
})
