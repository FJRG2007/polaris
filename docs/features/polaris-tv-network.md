# Block ads for any TV

[Leer en español](polaris-tv-network.es.md) - [Back to the README](../../README.md)

Roku, Vizio, Hisense VIDAA, LG and Samsung TVs cannot run Polaris TV yet, and some never will. They still
look up every ad and tracker by name, so the Network filter can refuse those names for every TV at home.

## Make the Network filter your router's DNS

Open **Network filter** in Polaris. Its router guide gives the address to type and where the setting
usually is on your router. Once the router hands that address out, every device on the network uses the
filter, TVs included.

## Keep the TV from going around it

- Many TVs ask a fixed DNS server instead of the router's. If your router can, send outgoing traffic on
  port 53 to the filter, and block outgoing port 853 so the TV cannot switch to encrypted DNS elsewhere.
- Do not block the TV's update domains: a TV that cannot update stops getting security fixes.
- Check again after a firmware update. Updates can bring new tracking domains or turn privacy switches
  back on.

Then turn off what the TV collects in its own menus: [privacy switches by brand](polaris-tv-privacy.md).
