/**
 * Which agent a new Code task starts with when nobody has picked one.
 *
 * It used to be the first agent not known to be missing, and the first in the
 * list is Claude Code's "this machine's own login" row - whose readiness is
 * `unknown` because Polaris cannot see inside that home. On a Polaris that has
 * never signed Claude in there, that default started every task on an agent
 * with no login, and the first message went nowhere.
 *
 * So the order is by what Polaris can actually vouch for: an agent with an
 * account linked, then one that signs in with the model picked beside it (it
 * spends a provider key Polaris holds), then any other that is not known to be
 * missing, with the machine's own login last since nothing says it exists.
 */

import * as core from "@polaris/core";
import type { AgentOption } from "@/lib/agents/agent-readiness";

type Pickable = Pick<AgentOption, "key" | "cli" | "readiness" | "machine">;

export function preferredAgent<T extends Pickable>(agents: readonly T[]): T | null {
    return (
        agents.find((agent) => agent.readiness === "ready" && !agent.machine) ??
        agents.find((agent) => core.MODEL_CHOICE_AGENT_CLIS.includes(agent.cli) && !agent.machine) ??
        agents.find((agent) => agent.readiness !== "missing" && !agent.machine) ??
        agents.find((agent) => agent.readiness !== "missing") ??
        agents[0] ??
        null
    );
}
