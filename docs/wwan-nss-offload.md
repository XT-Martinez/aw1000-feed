# Cellular (wwan) NSS offload

## Status on ppe-nss (Current)

Since 2026-10-14 the AW1000 builds on the `ppe-nss` base (`qca_ppe` +
`nss-wifi-drv`) instead of the Qualcomm vendor NSS host stack. The image has
been booted from USB and exercised on the board (record: `PPE-NSS-MIGRATION.md`
§5).

- Wired routing, NAT, PPPoE and VLANs are offloaded by `qca_ppe` through the
  kernel netfilter flowtable (`flow_offloading_hw=1`); Wi-Fi and bridged
  radio-to-port connections by `nss-wifi-drv` on NSS core 0. Together they
  replace the ~380k LOC vendor `qca-nss-drv` + `qca-nss-ecm` stack.
- **Cellular traffic is offloaded again** by our `nss-wifi-drv` work, merged into
  Julius's `ppe-nss` as [PR #41](https://github.com/JuliusBairaktaris/openwrt-ppe-nss/pull/41). Core 0
  has no `rmnet_rx` nodes, so each up raw-IP device (`wwan0_1`, `wwan0_2`)
  gets a generic redirect node pair; modem RX is taken at netdev ingress and
  handed to the firmware, firmware-routed TX comes back and leaves through
  `dev_queue_xmit`. The flow table binds raw-IP devices via the indirect
  block callback, and a fw4 include (`/usr/share/nss-wifi/flowtable.sh`)
  adds them to `inet fw4 ft`, because `fw4` only lists an interface's main
  device. `rawip=0` turns it off; debugfs `rawip` shows pairs and counters.
  Measured 2026-10-15 (`PPE-NSS-MIGRATION.md` §7): 90–119 Mbit/s download,
  99.98 % of modem packets routed by the firmware, router CPU ~4 %.
- SQM (`sqm-scripts`, cake) still shapes both directions of `wwan0_1` with
  the offload on (egress goes through the qdisc on the way out; ingress via
  the ifb). `ppe-qos`/`hw_ppe.qos` cannot attach to `wwan0_1` at all (`tc …
  flower skip_sw` → `Not supported`; only the switch ports implement
  `ndo_setup_tc`).
- `&nss1` is disabled on `ipq8072-aw1000.dts` on `ppe-nss`:
  `nss-wifi-drv` only runs on `nss0`, and its `nss_probe()` overwrites the
  global core pointers if `nss1` probes, which would bind offload to an
  unbooted core.

## Historical Reference: Vendor NSS Stack (nss-edma-rework)

Everything below documents the vendor `qca-nss-drv` + `qca-nss-ecm` stack
on the archived `nss-edma-rework` base; the patches and packages it refers
to (`build/patches-nss/`, `nss-tools`, `sqm-scripts-nss`) were removed from
this feed in the `ppe-nss` migration. The root-cause analysis and
benchmarks are kept for reference.

Findings from testing on the AW1000 (IPQ8072, NSS firmware
`NSS.FW.12.5-210-HK.R`, kernel 6.18.54, Quectel RG500Q-EA over
`qmi_wwan_q` with QMAP, Globe PH), 2026-10-02/03.

### Path

```
uplink    LAN → NSS ipv4 rule → rmnet_rx n2h node → host xmit callback → wwan0_1 → modem
downlink  modem → wwan0_1 rx_handler → rmnet_rx h2n node → (C2C) → NSS ipv4 rule → LAN
```

Unaccelerated packets go to the firmware all the same (the rx_handler offers
everything) and come back through the bind's receive callback.

- The node pair is created per raw-IP netdev by the qca-nss-drv binder
  (nss-packages patch 0117) on `NETDEV_UP`, and destroyed on
  `NETDEV_GOING_DOWN`. An ifup that bounces the link binds twice (`node 28`,
  then `node 30`). That is harmless; the debugfs warning
  `'rmnet_rx' already exists` comes with it.
- ECM classifies the netdev as `rawip` (qca-nss-ecm patch 0045). The rule's
  `ae_interface_identifier` is the n2h node (e.g. `33554462` = `0x0200001e` →
  node 30).
- On this board the h2n node's next hop is C2C (rmnet_rx runs on core 1), so
  the h2n node's own `tx_packets` stays 0. Downlink shows up in `c2c_tx`
  (core 1) and `c2c_rx` (core 0) instead. That counter is not a drop.

### What was wrong

1. **Ethernet-typed netdevs.** Stock `qmi_wwan_q` only makes `wwan0_N` raw IP
   when its own rmnet_nss hooks are present. Without them they are
   `ARPHRD_ETHER`, the binder ignores them, ECM fails the rule (`accel_mode
   -2`, `ae_interface_identifier -1`), and everything runs on the CPU. That
   path works (≈50 Mbps peaks on this line), it just isn't offloaded.
   **Fix:** `qmi_wwan_q` always calls `rmnet_usb_rawip_setup()` (unless in
   bridge mode).

2. **Framed uplink packets.** Once offload engages, the n2h node hands every
   accelerated packet to the host with a 14-byte Ethernet header in front of
   the IP header: the node's `tx_bytes` minus `rx_bytes` is exactly 14 ×
   packets. A captured frame:
   `ec6c9ab91069 84470962dc00 0800 45…` (router LAN MAC, LAN client MAC,
   IPv4). The binder's transmit callback queued that on the raw-IP netdev
   unchanged, so the modem sent garbage. Symptom: the TCP and TLS
   handshakes pass (slow path), then the first accelerated upstream segment
   is lost and the flow stalls with 0 bytes. Router-originated traffic
   (never accelerated) was unaffected.
   **Fix:** `build/patches-nss/qca-nss-drv/0119` strips the frame in the
   transmit callback, which only the firmware calls.

3. **Shared MAC across QMAP netdevs.** `qmi_wwan_q` gave every `wwan0_N`
   the parent `wwan0`'s MAC, and ECM looks up raw-IP interfaces by MAC alone
   (`ecm_db_iface_find_and_ref_rawip()`). With IPv4 on `wwan0_1` and IPv6 on
   `wwan0_2`, whichever registered first was used for both: IPv4 flows were
   accelerated out of `wwan0_2`'s node, i.e. onto the IPv6 PDN, and stalled
   after the handshake (`fw_tx=0` on `wwan0_1`). Single-PDN setups never
   see it.
   **Fix:** each QMAP netdev gets the parent MAC with the last byte + N
   (`qmi_wwan_q` PKG_RELEASE 4).

Verified with the frame stripped in the driver (hot-swapped `qmi_wwan_q`):
LAN downloads up to 50 Mbps and uploads ≈11 Mbps through the modem, with
about 14k uplink and 120k downlink packets on the rmnet_rx nodes. NSS core
load stayed around 5%. Throughput matched the router-local CPU path within
the cell's variance.

IPv6 on its own PDN (`multiplexing 1`, `apnv6 internet.globe.com.ph`, which
binds `wwan0_2` to a separate node pair) offloads the same way: ECM
accelerated the IPv6 flows, with 48k downlink and 11k uplink packets on
`wwan0_2`'s nodes. LAN downloads ran at 90–107 Mbps and uploads at 11 Mbps,
with the NSS core at 5%. The proto adds `wwan0_2` to the `wan` firewall zone
itself.

On the final image (fixes in the driver, 2026-10-02, Smart 515-03, EN-DC
LTE B1 + n41): IPv4 on `wwan0_1` 134–140 Mbps down, 4–5 Mbps up; with
`multiplexing 1` and `apnv6 smartlte` IPv6 on `wwan0_2` 113–136 Mbps down,
5.3 Mbps up, both at the same time. 99.9% or more of the packets in either
direction were offloaded, and the CPU stayed idle.

### SQM

- NSS SQM (`sqm-scripts-nss`, `nss-edma.qos`) works on `wan` and runs in the
  firmware (`nsstbl` + `nssfq_codel`, CPU idle), but cannot attach to
  `wwan0_N`: `interface unknown to nss driver`. The binder registers the
  rmnet_rx nodes, not the netdev, so `nss_qdisc` has no interface number for
  it. Making it work would need the binder to register the netdev, and the
  firmware to accept a shaper (or bounce shaping) on that node type.
- Upload-only cake on `wwan0_1` (sqm-scripts `piece_of_cake.qos`,
  `download 0`) does work with offload on: the binder's transmit callback
  queues accelerated uplink packets with `dev_queue_xmit()`, so they pass the
  egress qdisc. Ping during a saturating upload went from 83 ms average to
  50 ms at 4.5 Mbit/s. Download shaping is not possible this way, because
  accelerated downlink never reaches Linux.

### Visibility

`build/patches-nss/qca-nss-drv/0120` counts, per bind, packets handed to the
firmware, packets returned to the host, and accelerated transmits. It lists
them in `/sys/kernel/debug/qca-nss-drv/stats/rmnet_rx_bind`:

```
wwan0_1 n2h=32 h2n=33 rx=<n> tx=<n> to_fw=<n> to_host=<n> fw_tx=<n>
```

`build/patches-openwrt/0002` shows them in `nss-status` and on Status → NSS
Offload, as modem rows in the port table.

### Test pitfalls

- A test host behind its own VPN must bind the LAN port
  (`curl --interface <lan-nic>`); otherwise it never touches the router's WAN.
- To force LAN traffic over wwan while fiber is the default route, add a
  `/32` route for the test server: `ip route add <ip>/32 dev wwan0_1`.
- Test images start with the clock at 1970 until NTP syncs, and HTTPS then
  fails with curl exit 60.
- Globe's APN blocks outside resolvers. Use the carrier DNS.
- `rmnet_rx` counters and the bind counters reset on every ifup, but the
  netdev's do not.

### Not covered yet

- 464XLAT: CLAT is a nat46 device, which ECM treats as MAP-T. The firmware
  has MAP-T nodes, but this tree packages no NSS MAP-T client, so such flows
  would stay on the CPU.
- Upstreaming 0119/0120 to nss-packages.
