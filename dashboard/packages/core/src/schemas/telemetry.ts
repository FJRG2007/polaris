/**
 * What a person may say about who reports into a telemetry project.
 *
 * The rules here are what stands between a DSN that got out and somebody writing
 * into a project forever, so the shape is checked before it is stored rather than
 * when it is next read: an address rule that is not an address, or a policy of
 * "only these" with nothing listed, is a project that refuses everything for a
 * reason nobody chose.
 */

import { z } from "zod";
import { isCidr, isIpAddress } from "../cidr.js";
import { TELEMETRY_REPORTERS } from "../telemetry.js";
import { USER_AGENT_PATTERN_MAX } from "../user-agent.js";

/** How many rules one project may carry. Every one is walked on every report, so
 *  this is what stops a list becoming a way to make an ingest expensive. */
export const TELEMETRY_MAX_RULES = 50;

const addressRule = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => isIpAddress(value) || isCidr(value), {
        message: "Write an address, or a range such as 10.0.0.0/8"
    });

const agentRule = z.string().trim().min(1).max(USER_AGENT_PATTERN_MAX);

/**
 * The whole set, checked together.
 *
 * "listed" with an empty list is refused here rather than stored and discovered
 * later: it is a project that will turn away every report, and the only way to
 * find out would be the counter on the screen.
 */
export const reporterRulesSchema = z
    .object({
        reporters: z.enum(TELEMETRY_REPORTERS),
        allowedCidrs: z.array(addressRule).max(TELEMETRY_MAX_RULES).default([]),
        allowedUserAgents: z.array(agentRule).max(TELEMETRY_MAX_RULES).default([]),
        deniedUserAgents: z.array(agentRule).max(TELEMETRY_MAX_RULES).default([]),
        requireSecret: z.boolean().default(false)
    })
    .refine((rules) => rules.reporters !== "listed" || rules.allowedCidrs.length > 0, {
        path: ["allowedCidrs"],
        message: "Name at least one address, or nothing will be able to report"
    });

export type ReporterRulesInput = z.infer<typeof reporterRulesSchema>;
