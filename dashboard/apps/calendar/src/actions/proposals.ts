"use server";

/** Meeting proposals: the owner's list, editor and choice, and the vote a
 *  participant casts through their link (no session - the link is the right). */

import { z } from "zod";
import * as schemas from "../lib/schemas";
import * as proposals from "../lib/proposals";
import { requireCalendarUser } from "../lib/access";
import { outcome, type Outcome } from "../lib/outcome";
import { refusedInput } from "../lib/scheduling-guard";
import * as scheduling from "../lib/scheduling-schemas";
import type { ProposalSummary, ProposalView } from "../lib/scheduling-wire";

export async function listProposalsAction(): Promise<Outcome<{ proposals: ProposalSummary[] }>> {
    return outcome(async () => ({ proposals: await proposals.listProposals(await requireCalendarUser()) }));
}

export async function proposalAction(id: unknown): Promise<Outcome<{ proposal: ProposalView }>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({ proposal: await proposals.proposal(await requireCalendarUser(), parsed.data) }));
}

export async function createProposalAction(input: unknown): Promise<Outcome<{ proposal: ProposalView }>> {
    const parsed = scheduling.proposalInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({ proposal: await proposals.createProposal(await requireCalendarUser(), parsed.data) }));
}

export async function updateProposalAction(id: unknown, input: unknown): Promise<Outcome<{ proposal: ProposalView }>> {
    const parsedId = schemas.uuidSchema.safeParse(id);
    if (!parsedId.success) return refusedInput(parsedId.error.issues);
    const parsed = scheduling.proposalInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        proposal: await proposals.updateProposal(await requireCalendarUser(), parsedId.data, parsed.data)
    }));
}

export async function deleteProposalAction(id: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await proposals.deleteProposal(await requireCalendarUser(), parsed.data);
        return {};
    });
}

const chooseInput = z.object({
    proposalId: schemas.uuidSchema,
    dateId: schemas.uuidSchema,
    calendarId: schemas.uuidSchema
});

export async function chooseProposalDateAction(input: unknown): Promise<Outcome<{ objectId: string }>> {
    const parsed = chooseInput.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => proposals.chooseDate(await requireCalendarUser(), parsed.data));
}

export async function castVotesAction(input: unknown): Promise<Outcome<object>> {
    const parsed = scheduling.voteInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await proposals.castVotes(parsed.data.token, parsed.data.votes);
        return {};
    });
}
