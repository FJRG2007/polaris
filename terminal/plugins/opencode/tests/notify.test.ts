import { describe, it, afterEach, mock } from "bun:test"
import { expect } from "bun:test"
import fs from "fs"

const writeSpy = mock(() => {})
mock.module("fs", () => ({
  ...fs,
  writeFileSync: writeSpy,
}))

const { rookNotify } = await import("../src/notify")

describe("rookNotify", () => {
  const originalVersion = process.env.ROOK_CLI_AGENT_PROTOCOL_VERSION

  afterEach(() => {
    writeSpy.mockClear()
    if (originalVersion === undefined) {
      delete process.env.ROOK_CLI_AGENT_PROTOCOL_VERSION
    } else {
      process.env.ROOK_CLI_AGENT_PROTOCOL_VERSION = originalVersion
    }
  })

  it("skips when ROOK_CLI_AGENT_PROTOCOL_VERSION is not set", () => {
    delete process.env.ROOK_CLI_AGENT_PROTOCOL_VERSION
    rookNotify("title", "body")
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("writes OSC 777 sequence when Rook declares protocol support", () => {
    process.env.ROOK_CLI_AGENT_PROTOCOL_VERSION = "1"
    rookNotify("rook://cli-agent", '{"event":"stop"}')
    expect(writeSpy).toHaveBeenCalledTimes(1)

    const [path, data] = writeSpy.mock.calls[0] as [string, string]
    expect(path).toBe("/dev/tty")
    expect(data).toContain("rook://cli-agent")
    expect(data).toContain('{"event":"stop"}')
    expect(data).toMatch(/^\x1b\]777;notify;/)
    expect(data).toMatch(/\x07$/)
  })
})
