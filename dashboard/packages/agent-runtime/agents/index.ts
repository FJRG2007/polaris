import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import type { Agent } from "./shared.ts";

export type { Agent, AgentUsage } from "./shared.ts";

export const agents = { claude, opencode } satisfies Record<string, Agent>;
