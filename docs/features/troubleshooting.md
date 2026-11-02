# When Polaris cannot be reached

[Leer en español](troubleshooting.es.md) - [Back to the README](../../README.md)

What to check when a screen says Polaris is not reachable, in the order that finds
the cause fastest. None of it needs a terminal.

## Find out how far it goes

Open Polaris on a phone using mobile data, with Wi-Fi off.

| What you see | What it means | Go to |
| --- | --- | --- |
| The phone loads, this device does not | Polaris is up; the problem is this device or its network | [Only this device](#only-this-device) |
| Neither loads | The machine running Polaris is off or lost its network | [Every device](#every-device) |
| It loads at home but not from outside | The machine is fine; the way in from the internet is not | [Only from outside](#only-from-outside) |

## Only this device

- Open any other website. If nothing loads, this device has no internet and Polaris
  is not the problem.
- If you just changed a router, this device may still hold its old address.
  Unplug its network cable or turn Wi-Fi off and on.
- If you use a VPN on this device, turn it off and try again.
- In the desktop app, use another address of the same Polaris from the servers
  window. In a browser, the page offers your local address when it can prove it is
  the same Polaris.

## Every device

- Check that the machine is on and that the light on its network port is lit.
- Check the switch or router it is plugged into, and try another port and cable.
- Open your router's list of connected devices. If the machine is not listed, it is
  not on your network: the cause is the cable, the port or the machine.
- If the machine is listed with a different address than before, its network has
  changed. See [After changing a router](#after-changing-a-router).

## After changing a router

Two routers in a row make two networks. A device that picks its address by itself
follows the change, and a machine with a fixed address does not, so it ends up on a
network where nothing can reach it.

- Plug the machine back into the router it was on, or into a switch on that router.
- If you want one network, put the second router in access point mode, and apply
  the change. The cable coming from the first router usually has to go into a LAN
  port, not the WAN port. Without this, devices on it get no address and no internet.
- If that mode gives you no internet and you cannot work out why, go back to router
  mode. Polaris does not need access point mode.
- After any change, reconnect the devices on that router so they get a new address.

## Only from outside

- Check the connection on the screen where Polaris shows its domains. It tells you
  whether the address answers from here.
- With a relay, the machine needs internet to keep its side of the tunnel open. If
  the machine lost its network, the relay stays up and the site does not load.
- A rule in your router or a DNS record is yours to change. The domain screen names
  the values to type.

## The desktop app stopped on this screen

When the Polaris in use stops answering, the desktop app opens the servers window
beside it, so you can open another one. Your other servers are still listed there,
and each opens as usual.

## Speed stops at 94 or 95 Mbps

That is a 100 Mbit link: 100 Mbit minus network overhead is 94 to 95 Mbps. Your
internet is not the limit. Some part of the path is connecting at 100 instead of
1000.

- Look at the port's speed in the router or switch. Most list 100 or 1000 for each
  port.
- A gigabit link uses all eight wires of the cable. With one damaged pair or a bad
  connector, it drops to 100. Long runs and hand-made ends are the usual cause.
- Swap one part at a time: a short cable, another port, then the long run.
- An older switch or router with 10/100 ports caps everything through it.
