/**
 * The chat inside a call.
 *
 * Its own table rather than the conversation's, and it has to be: every message
 * in Chat is written by an account against a channel somebody is a member of,
 * and neither is true of a guest who typed a name into a link ten seconds ago.
 * So everything here belongs to a *seat*, which is the only identity a meeting
 * can promise for everybody in it - a line, a file, and a vote alike.
 *
 * That is also why the polls are not ChatPoll's. Those are voted on by accounts,
 * and a poll half the room cannot answer is a poll asked of the wrong people.
 *
 * What the room carries is the same as what a conversation carries, because a
 * call is exactly where somebody needs to hand over a screenshot, an address or
 * a question - and every one of those used to have to happen somewhere that was
 * not the call. The body is Markdown, the way every writing surface in Polaris
 * stores it, so a link is a link and a mention is a chip.
 *
 * And all of it goes when the call goes. Nobody should find out a year later
 * that what they typed into a meeting outlived the meeting, which is the promise
 * `discardMeetingChat` keeps.
 */

import { prisma } from "@polaris/db";
import { requireSeated } from "./meetings";
import { ChatAccessError } from "./access";
import { publishMeetingEvent } from "./meeting-events";
import { MAX_MEETING_LINE, MEETING_LINES } from "./meeting-limits";
import type { StoredMeetingFile } from "./meeting-files";

/** The most answers one question may offer, and the fewest it is worth asking
 *  with. The same shape a chat poll takes, because it is the same question. */
export const MAX_POLL_OPTIONS = 10;
const MIN_POLL_OPTIONS = 2;

/** How long one answer may be. A poll option is a label, not a paragraph. */
const MAX_POLL_OPTION = 120;

/** A file on a line, as a browser needs it. The bytes are fetched separately,
 *  through a route that asks whether the reader has a seat. */
export interface MeetingFileView {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
}

/** One answer, and where it stands. */
export interface MeetingPollOptionView {
    readonly id: string;
    readonly text: string;
    readonly votes: number;
    /** Whether the reader picked this one. */
    readonly mine: boolean;
}

/** A question asked of the room. */
export interface MeetingPollView {
    readonly multiple: boolean;
    readonly closed: boolean;
    /** Whether the tallies are held back until it closes. The counts are not
     *  sent at all while that holds - a number the browser has been asked not to
     *  draw is a number anybody can read out of the response. */
    readonly hidden: boolean;
    readonly total: number;
    readonly options: readonly MeetingPollOptionView[];
}

/** One thing said in a call. */
export interface MeetingLine {
    readonly id: string;
    /** The seat that said it, so a screen can tell its own lines apart. */
    readonly participantId: string;
    readonly name: string;
    readonly guest: boolean;
    /** The account behind the seat, for the face beside the line. Null for a
     *  guest, who has initials and nothing else. */
    readonly userId: string | null;
    /** Markdown. Empty on a line that is only files, or only a poll. */
    readonly body: string;
    readonly at: string;
    readonly files: readonly MeetingFileView[];
    readonly poll: MeetingPollView | null;
}

/** The seat this is being done from, admitted. The lobby is not a place to be
 *  heard from: somebody waiting at the door can neither read the room nor be
 *  read by it. */
async function admitted(seat: { meetingId: string; participantId: string }): Promise<void> {
    const seated = await requireSeated(seat);
    if (seated.admission !== "admitted") {
        throw new ChatAccessError("You are still waiting to be let in");
    }
}

/**
 * Say something to the room, with whatever it carries.
 *
 * The files arrive already written - the route that can take bytes does that
 * before it calls here, because a message that landed without its attachments
 * would be a message nobody can make sense of.
 */
export async function sayInMeeting(
    seat: { meetingId: string; participantId: string },
    body: string,
    files: readonly StoredMeetingFile[] = []
): Promise<void> {
    await admitted(seat);
    const said = body.trim().slice(0, MAX_MEETING_LINE);
    // A line that is only a picture is a line. Insisting on words first is a tax
    // on the commonest thing anybody does with a call's chat.
    if (!said && files.length === 0) throw new ChatAccessError("Write something first");

    await prisma.meetingMessage.create({
        data: {
            meetingId: seat.meetingId,
            participantId: seat.participantId,
            body: said,
            attachments: {
                create: files.map((file) => ({
                    name: file.name,
                    size: BigInt(file.size),
                    contentType: file.contentType,
                    connectionId: file.connectionId,
                    path: file.path
                }))
            }
        }
    });
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "said" });
}

/**
 * Ask the room a question.
 *
 * A message with no words and a poll hanging off it, the same shape a chat poll
 * takes - so a screen draws it in the run of the conversation rather than in a
 * panel of its own, and the answer is read where the question was asked.
 */
export async function pollInMeeting(
    seat: { meetingId: string; participantId: string },
    draft: {
        question: string;
        options: readonly string[];
        multiple?: boolean;
        hideResults?: boolean;
    }
): Promise<void> {
    await admitted(seat);

    const question = draft.question.trim().slice(0, MAX_MEETING_LINE);
    if (!question) throw new ChatAccessError("Ask something first");

    const options = draft.options
        .map((option) => option.trim().slice(0, MAX_POLL_OPTION))
        .filter((option) => option.length > 0)
        .slice(0, MAX_POLL_OPTIONS);
    if (options.length < MIN_POLL_OPTIONS) throw new ChatAccessError("Give it at least two answers");

    await prisma.meetingMessage.create({
        data: {
            meetingId: seat.meetingId,
            participantId: seat.participantId,
            body: question,
            poll: {
                create: {
                    multiple: draft.multiple === true,
                    hideResults: draft.hideResults === true,
                    options: {
                        create: options.map((text, position) => ({ text, position }))
                    }
                }
            }
        }
    });
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "said" });
}

/**
 * Pick an answer, or take the pick back.
 *
 * Pressing the answer you already hold removes it, which is how every poll
 * anybody has used works. On a single-answer poll, picking a second one replaces
 * the first rather than refusing: somebody changing their mind is the common
 * case, and making them un-pick first is a step for nothing.
 */
export async function voteInMeeting(
    seat: { meetingId: string; participantId: string },
    optionId: string
): Promise<void> {
    await admitted(seat);

    const option = await prisma.meetingPollOption.findUnique({
        where: { id: optionId },
        select: {
            id: true,
            pollId: true,
            poll: {
                select: { multiple: true, closedAt: true, message: { select: { meetingId: true } } }
            }
        }
    });
    // Checked against the seat's own meeting rather than against what the caller
    // said: an option id is a guess anybody can make, and this is the line that
    // stops one call voting in another.
    if (!option || option.poll.message.meetingId !== seat.meetingId) {
        throw new ChatAccessError("That question is not in this call");
    }
    if (option.poll.closedAt) throw new ChatAccessError("That question is closed");

    const held = await prisma.meetingPollVote.findUnique({
        where: { optionId_participantId: { optionId, participantId: seat.participantId } },
        select: { id: true }
    });
    if (held) {
        await prisma.meetingPollVote.delete({ where: { id: held.id } });
    } else {
        await prisma.$transaction([
            // One answer at a time unless the question says otherwise.
            ...(option.poll.multiple
                ? []
                : [
                      prisma.meetingPollVote.deleteMany({
                          where: {
                              participantId: seat.participantId,
                              option: { pollId: option.pollId }
                          }
                      })
                  ]),
            prisma.meetingPollVote.create({
                data: { optionId, participantId: seat.participantId }
            })
        ]);
    }
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "said" });
}

/** Stop taking answers. Whoever asked it, or whoever is hosting - a question
 *  left open by somebody who has closed their laptop is one nobody else can
 *  finish. */
export async function closePollInMeeting(
    seat: { meetingId: string; participantId: string },
    messageId: string
): Promise<void> {
    await admitted(seat);

    const poll = await prisma.meetingPoll.findUnique({
        where: { messageId },
        select: {
            closedAt: true,
            message: {
                select: {
                    meetingId: true,
                    participantId: true,
                    meeting: { select: { hostId: true } }
                }
            }
        }
    });
    if (!poll || poll.message.meetingId !== seat.meetingId) {
        throw new ChatAccessError("That question is not in this call");
    }
    if (poll.closedAt) return;

    const seated = await requireSeated(seat);
    const asked = poll.message.participantId === seat.participantId;
    const hosting = seated.userId !== null && seated.userId === poll.message.meeting.hostId;
    if (!asked && !hosting) throw new ChatAccessError("Only whoever asked it can close it");

    await prisma.meetingPoll.update({ where: { messageId }, data: { closedAt: new Date() } });
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "said" });
}

/**
 * A question, as the seat asking is allowed to see it.
 *
 * A hidden poll sends no counts at all until it closes - not a flag saying not
 * to draw them. The numbers would be in the response either way, and one of the
 * two ways anybody can read them.
 */
function pollView(
    poll: {
        multiple: boolean;
        hideResults: boolean;
        closedAt: Date | null;
        options: { id: string; text: string; votes: { participantId: string }[] }[];
    },
    participantId: string
): MeetingPollView {
    const closed = poll.closedAt !== null;
    const hidden = poll.hideResults && !closed;
    return {
        multiple: poll.multiple,
        closed,
        hidden,
        total: hidden ? 0 : poll.options.reduce((sum, option) => sum + option.votes.length, 0),
        options: poll.options.map((option) => ({
            id: option.id,
            text: option.text,
            votes: hidden ? 0 : option.votes.length,
            // Their own answer is theirs to see whatever the poll hides: it is
            // the only thing that says the press landed.
            mine: option.votes.some((vote) => vote.participantId === participantId)
        }))
    };
}

/**
 * What the room has said.
 *
 * The name comes off the seat that said it, so a guest is named the way they
 * named themselves and nobody has to have an account. The last of it and no
 * paging: a call is not a conversation with a history to walk back through, and
 * what was said before somebody arrived was not said to them.
 */
export async function saidInMeeting(seat: {
    meetingId: string;
    participantId: string;
}): Promise<readonly MeetingLine[]> {
    const seated = await requireSeated(seat);
    if (seated.admission !== "admitted") return [];

    const rows = await prisma.meetingMessage.findMany({
        where: { meetingId: seat.meetingId },
        orderBy: { createdAt: "desc" },
        take: MEETING_LINES,
        select: {
            id: true,
            participantId: true,
            body: true,
            createdAt: true,
            participant: { select: { name: true, userId: true } },
            attachments: {
                orderBy: { createdAt: "asc" },
                select: { id: true, name: true, size: true, contentType: true }
            },
            poll: {
                select: {
                    multiple: true,
                    hideResults: true,
                    closedAt: true,
                    options: {
                        orderBy: { position: "asc" },
                        select: {
                            id: true,
                            text: true,
                            votes: { select: { participantId: true } }
                        }
                    }
                }
            }
        }
    });

    return rows.reverse().map((row) => ({
        id: row.id,
        participantId: row.participantId,
        name: row.participant.name,
        guest: row.participant.userId === null,
        userId: row.participant.userId,
        body: row.body,
        at: row.createdAt.toISOString(),
        files: row.attachments.map((file) => ({
            id: file.id,
            name: file.name,
            // A BigInt does not survive the trip to a browser, and a file this
            // side of a 25 MB ceiling fits in a number with room to spare.
            size: Number(file.size),
            contentType: file.contentType
        })),
        poll: row.poll ? pollView(row.poll, seat.participantId) : null
    }));
}
