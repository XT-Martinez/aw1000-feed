# aw1000-feed

OpenWrt package feed and build recipe for the **Arcadyan AW1000** on the
NSS-EDMA tree (`JuliusBairaktaris/openwrt-nss-edma`, branch `nss-edma-rework`).

## Packages

| Package | What it is |
|---|---|
| `kmod-qmi_wwan_q` | Quectel QMI WWAN driver 1.5.0 with QMAP multiplexing. Default `qmap_mode` is a menuconfig option (`QMI_WWAN_Q_QMAP_MODE`, default 2 → `wwan0_1`, `wwan0_2`). Replaces QModem's copy (see `build/feeds.exclude`). Built **without** its own rmnet_nss hooks: `qca-nss-drv` binds raw-IP modem netdevs itself (nss-packages `944ea25`). |
| `quectel-cm` | quectel-cm 1.6.5 + netifd `quectel` proto: IPv4/IPv6 over separate QMAP channels (`option multiplexing 1`), passthrough, NAT64, handover monitor. |
| `luci-proto-quectel` | LuCI form for the `quectel` proto. |
| `udp-broadcast-relay-redux` | Relays UDP broadcasts between networks (e.g. Tapo camera discovery on port 20002 across lan/iot). Removed from openwrt/packages in `90b98c14f` (upstream archived); vendored unchanged. |
| `aw1000-defaults` | First-boot settings: LAN `192.168.254.1`, `wwan` interface, QModem as monitor only, front-panel LEDs, USB drive automount (`/mnt/<device>`), Footstrap theme. Runs once (marker `system.@system[0].aw1000_defaults`). |

`qmi_wwan_q` is QModem's V1.5.0 copy (FUjr/QModem `c49654e`, builds on
Linux 6.17+). `quectel-cm` and `luci-proto-quectel` are taken from
[xhikarishii/nss-packages](https://github.com/xhikarishii/nss-packages)
branch `aw1000-nss` at `ef05f5c` (GPL-2.0).

## Front panel

| LED | Meaning |
|---|---|
| signal (RGB) | serving-cell RSRP: green ≥ −90 dBm, blue ≥ −105, red below, off = no service |
| 5G (RGB) | green = NR (SA / EN-DC), blue = LTE only, red = registered without a data call |
| internet | netdev trigger on `wwan0_1` |
| Wi-Fi | `phy0tpt` |
| phone | blinks while QModem holds unread received SMS |

Signal, 5G and phone are driven by `/usr/share/qmodem/led_scripts/aw1000.sh`,
a QModem `modem_status` script (`/etc/config/qmodem_led`, section `aw1000`).

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
- `build/feeds.exclude` — installed feed packages removed again (QModem's
  `qmi_wwan_q`, replaced by ours).
- `build/config` — appended to `builder-reference/devices/common/config`.
- `build/patches/<feed>/` — patches applied to `feeds/<feed>`.
