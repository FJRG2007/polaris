# The chat list stayed a skeleton until reload

## What happened

Opening Chat sometimes left the conversation list as a skeleton. It never finished
on its own, and reloading the page cured it at once.

## Why

The list was read with a server action, and the skeleton only ended when that action
settled. The router runs actions and navigations through one queue that has no
timeout and only moves on when the item at its head settles. One request that stalled,
for example across a line change or a restart, held everything behind it, and the
list had nothing that could end the wait. A reload starts a new queue.

Which request stalled was not observed in a browser. The queue's behaviour is read
from the framework's source.

## The fix

The list is read from `/api/chat/lists`, outside that queue. Each read is timed out
after 20 seconds and tried again, at most 30 seconds apart. While the first read has
failed, the rail says so and offers to try now, rather than showing a skeleton or an
empty list. A session that may no longer read the list stops asking and goes where
the server's gates send it. A reload in the same tab draws the last list it had at
once, through the shared snapshot cache, so a sign-out or an update clears it. That
copy only draws the rail: a refusal still waits for the server's answer.

## What this does not cover

Every other server action is still in that queue. A stalled one can still hold back
the messages of a conversation and a message being sent until a reload.
