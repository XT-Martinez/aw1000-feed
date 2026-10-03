# aw1000-feed

OpenWrt package feed and build recipe for the **Arcadyan AW1000** on the
NSS-EDMA tree (`JuliusBairaktaris/openwrt-nss-edma`, branch `nss-edma-rework`).

## Packages

| Package | What it is |
|---|---|
| `kmod-qmi_wwan_q` | Quectel QMI WWAN driver 1.5.0 with QMAP multiplexing. Default `qmap_mode` is a menuconfig option (`QMI_WWAN_Q_QMAP_MODE`, default 2 → `wwan0_1`, `wwan0_2`). Built **without** its own rmnet_nss hooks: `qca-nss-drv` binds raw-IP modem netdevs itself (nss-packages `944ea25`), so the QMAP netdevs are always raw IP. See [docs/wwan-nss-offload.md](docs/wwan-nss-offload.md). |
| `quectel-cm` | quectel-cm 1.6.5 + netifd `quectel` proto: IPv4/IPv6 over separate QMAP channels (`option multiplexing 1`), passthrough, NAT64, handover monitor. |
| `luci-proto-quectel` | LuCI form for the `quectel` proto. |
| `luci-app-aw1000-modem` | The Modem pages (below): SMS conversations, bands, cell scan and lock, AT console. Ships `aw1000-at`, which sends one AT command and waits as long as it needs. |
| `udp-broadcast-relay-redux` | Relays UDP broadcasts between networks (e.g. Tapo camera discovery on port 20002 across lan/iot). Removed from openwrt/packages in `90b98c14f` (upstream archived); vendored unchanged. |
| `aw1000-defaults` | First-boot settings: LAN `192.168.254.1`, `wwan` interface (APN `internet`, IPv4), front-panel LEDs, USB drive automount (`/mnt/<device>`), Footstrap theme. Runs once (marker `system.@system[0].aw1000_defaults`). Also ships `aw1000-leds`, `aw1000-modem-ports` and the dashboard widgets (below). |

`qmi_wwan_q` is Quectel's V1.5.0 as carried by FUjr/QModem `c49654e`
(builds on Linux 6.17+). `quectel-cm` and `luci-proto-quectel` are taken from
[xhikarishii/nss-packages](https://github.com/xhikarishii/nss-packages)
branch `aw1000-nss` at `ef05f5c` (GPL-2.0).

## Front panel

| LED | Meaning |
|---|---|
| signal (RGB) | LTE RSRP (the anchor on 5G NSA); steady green on 5G SA; off = no service |
| 5G (RGB) | NR RSRP on 5G SA or NSA; off on LTE only |
| internet | steady while fiber (`wan`) or the modem (`wwan`) can ping 1.1.1.1 / 8.8.8.8 |
| Wi-Fi | steady while the 5 GHz AP (`phy0-ap0`) is up |
| phone | blinks while there are messages not yet listed on Modem → Messages |

Quality colours: green ≥ −90 dBm, blue ≥ −105, red below.

Signal, 5G, internet and phone are driven by the `aw1000-leds` service, which
every 10 s polls `AT+QENG="servingcell"` and `+CPMS?` on the modem's second AT
port and pings out of each of `internet_ifaces` (`/etc/config/aw1000_leds`).

## Modem pages

LuCI's Modem menu is `luci-app-aw1000-modem`:

| Page | What |
|---|---|
| Messages | SMS as conversations: modem and SIM memory, long messages put together, sent ones kept on the router (`/etc/aw1000-modem/sms-sent`); where new messages are stored (modem or SIM) |
| Bands | network mode, 5G NSA/SA, and the LTE / 5G NSA / 5G SA bands (`AT+QNWPREFCFG`), the ones in use marked |
| Cell lock | serving cell, LTE and 5G SA cell locks, neighbour list, full scan of every operator's cells (`AT+QSCAN`, about 100 s) |
| AT commands | console with history and common commands; slow ones run in the background |

The backend is the rpcd plugin `luci.aw1000-modem`. Settings are in
`/etc/config/aw1000_modem`: the cell locks, which the `quectel` proto sends
to the modem on every connect (they used to be its `cell_lock_4g` option),
the SMS country code (`0917…` is sent as `+63917…`: Smart's SMS centre
refuses national numbers) and the storage for new messages, which
`aw1000-leds` restores after a modem restart.

Every AT user takes the modem's lock, `/var/lock/aw1000-modem.lock`: all
ports lead to one command parser. The AT ports are chosen by USB interface,
not by `ttyUSB` number (`aw1000-modem-ports`): interface 2 for the pages,
interface 3 for `aw1000-leds`. A modem reset that renumbers the ports
(`ttyUSB3` → `ttyUSB4`) needs no manual fix.

## Dashboard widgets

`aw1000-defaults` adds widgets to `luci-mod-dashboard` (plain files in its
`view/dashboard/include/`, no patch):

| Widget | Card | Chart | Tab |
|---|---|---|---|
| `mobile` (`40_mobile.js`) | LTE / 5G NSA / 5G SA, operator, bands, RSRP, connected or standby | LTE and 5G RSRP and SINR, last 5 min | carriers (band, bandwidth, PCI, ARFCN, RSRP/RSRQ/SINR), cell ID, TAC, APN, addresses, band and cell locks (linked to the Bands and Cell lock pages), SIM, firmware, modem temperature |
| `mobile-traffic` (`40_mobile.js`) | | down/up over `wwan0_N`, NSS-offloaded traffic included | |
| `thermal` (`45_thermal.js`) | CPU, NSS, Wi-Fi, modem °C | the same, last 5 min | |

The modem takes one AT command at a time, so the widgets never query it: `aw1000-leds` saves its replies and the temperatures to
`/tmp/aw1000-status/` every poll (`live`, `static` once a minute, `history`,
`thermal`), and the widgets read those files (ACL
`luci-aw1000-dashboard`). Parsing and the signal icons are shared with the
modem pages in `aw1000/cell.js`. A saved layout (Dashboard → Layout) lists widgets
by id; new ids only show once added there.

## Build

```sh
build/build.sh            # feeds, config, full build in a podman container
build/build.sh prepare    # feeds + .config only
build/build.sh shell      # shell in the build container
build/build.sh make menuconfig
```

Runs in `ghcr.io/openwrt/buildbot/buildworker-v3.11.8` as the invoking user;
only `../openwrt` is written. Expects `../openwrt`, `../nss-packages` and
`../builder-reference` next to this repo.

- `build/feeds` — feeds added to `feeds.conf.default`, in install order.
- `build/feeds.prefer` — packages taken from a given feed when several carry
  them (`sms-tool` from 4IceG's repo).
- `build/feeds.exclude` — installed feed packages removed again.
- `build/config` — appended to `builder-reference/devices/common/config`.
- `build/patches/<feed>/` — patches applied to `feeds/<feed>`.
- `build/patches-openwrt/` — patches applied to the OpenWrt tree itself.
- `build/patches-nss/<package>/` — extra package patches for the `nss` feed,
  copied next to the package's own (the feed becomes a writable copy).
