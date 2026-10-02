# aw1000-feed

OpenWrt package feed and build recipe for the **Arcadyan AW1000** on the
NSS-EDMA tree (`JuliusBairaktaris/openwrt-nss-edma`, branch `nss-edma-rework`).

## Packages

| Package | What it is |
|---|---|
| `kmod-qmi_wwan_q` | Quectel QMI WWAN driver 1.5.0 with QMAP multiplexing. Default `qmap_mode` is a menuconfig option (`QMI_WWAN_Q_QMAP_MODE`, default 2 → `wwan0_1`, `wwan0_2`). Built **without** its own rmnet_nss hooks: `qca-nss-drv` binds raw-IP modem netdevs itself (nss-packages `944ea25`), so the QMAP netdevs are always raw IP. See [docs/wwan-nss-offload.md](docs/wwan-nss-offload.md). |
| `quectel-cm` | quectel-cm 1.6.5 + netifd `quectel` proto: IPv4/IPv6 over separate QMAP channels (`option multiplexing 1`), passthrough, NAT64, handover monitor. |
| `luci-proto-quectel` | LuCI form for the `quectel` proto. |
| `udp-broadcast-relay-redux` | Relays UDP broadcasts between networks (e.g. Tapo camera discovery on port 20002 across lan/iot). Removed from openwrt/packages in `90b98c14f` (upstream archived); vendored unchanged. |
| `aw1000-defaults` | First-boot settings: LAN `192.168.254.1`, `wwan` interface (APN `internet`, IPv4), the modem LuCI apps' modem entry, front-panel LEDs, USB drive automount (`/mnt/<device>`), Footstrap theme. Runs once (markers `system.@system[0].aw1000_defaults` and `aw1000_modem_defaults`). Also ships `aw1000-leds` and `aw1000-modem-ports` (below). |

`qmi_wwan_q` is Quectel's V1.5.0 as carried by FUjr/QModem `c49654e`
(builds on Linux 6.17+). `quectel-cm` and `luci-proto-quectel` are taken from
[xhikarishii/nss-packages](https://github.com/xhikarishii/nss-packages)
branch `aw1000-nss` at `ef05f5c` (GPL-2.0).

## Front panel

| LED | Meaning |
|---|---|
| signal (RGB) | serving-cell RSRP: green ≥ −90 dBm, blue ≥ −105, red below, off = no service |
| 5G (RGB) | green = NR (SA / EN-DC), blue = LTE only, red = registered without a data call |
| internet | netdev trigger on `wwan0_1` |
| Wi-Fi | netdev trigger on `phy0-ap0` (5 GHz AP): on while up, blinks with traffic |
| phone | blinks on new SMS (sms-tool-js notifier, `sms_tool_js.lednotify`) |

Signal and 5G are driven by the `aw1000-leds` service, which polls
`AT+QENG="servingcell"` every 10 s on the modem's second AT port
(`/etc/config/aw1000_leds`).

## Modem pages

LuCI's Modem menu comes from 4IceG's apps, pinned in `build/feeds`, all
talking AT through `sms-tool`:

| App | Backend | What |
|---|---|---|
| `luci-app-modemdata` | `modemdata` (obsy) | signal, cell and band details (successor of 3ginfo-lite) |
| `luci-app-modemband` | `modemband` (obsy) | LTE / 5G NSA / 5G SA band lock |
| `luci-app-sms-tool-js` | `sms-tool` | SMS inbox and sending, USSD, AT console, phone LED |
| `luci-app-atinout` | `atinout` | AT console |

The modem's AT ports are chosen by USB interface, not by `ttyUSB` number:
`aw1000-modem-ports` (run from `/etc/hotplug.d/tty` and at first boot)
writes interface 2 (polling, SMS reading) and interface 3 (SMS/USSD
sending, AT console, LEDs) into each app's config. A modem reset that
renumbers the ports (`ttyUSB3` → `ttyUSB4`) then needs no manual fix.

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
