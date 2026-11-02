# A relayed player was kicked for being on the wrong network

## What happened

A player allowed on a Minecraft server joined, played for a moment and was kicked
with "Your account is registered to a different network", every time. Nothing had
changed for them except the line: the deployment was serving through its relay.

## Why

The address check reads the address from the server's join line. A connection that
comes through the relay reaches the container from the container network's own
gateway, so every player showed as `172.22.0.1`. No allowed address could ever match
that, and the periodic check kicked them right after they joined.

## The fix

`isContainerGateway` treats that gateway as an address that cannot be read, which is
the case the check already had: the player is judged on their name, and counted as
unknown. A name that is not on the list is still refused.

## What this does not cover

While the relay serves, the address half of the check cannot tell one network from
another, because the relay hides the player's address from the game server. The
player list still applies. Telling networks apart again needs the real address
carried through the relay, with PROXY protocol on the port and a server that reads it.
