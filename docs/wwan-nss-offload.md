# Cellular (wwan) NSS offload

Findings from testing on the AW1000 (IPQ8072, NSS firmware
`NSS.FW.12.5-210-HK.R`, kernel 6.18.54, Quectel RG500Q-EA over
`qmi_wwan_q` with QMAP, Globe PH), 2026-10-02/03.

## Path

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

## What was wrong

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

Verified with the frame stripped in the driver (hot-swapped `qmi_wwan_q`):
LAN downloads up to 50 Mbps and uploads ≈11 Mbps through the modem, with
about 14k uplink and 120k downlink packets on the rmnet_rx nodes. NSS core
load stayed around 5%. Throughput matched the router-local CPU path within
the cell's variance.

## Visibility

`build/patches-nss/qca-nss-drv/0120` counts, per bind, packets handed to the
firmware, packets returned to the host, and accelerated transmits. It lists
them in `/sys/kernel/debug/qca-nss-drv/stats/rmnet_rx_bind`:

```
wwan0_1 n2h=32 h2n=33 rx=<n> tx=<n> to_fw=<n> to_host=<n> fw_tx=<n>
```

`build/patches-openwrt/0002` shows them in `nss-status` and on Status → NSS
Offload, as modem rows in the port table.

## Test pitfalls

- A test host behind its own VPN must bind the LAN port
  (`curl --interface <lan-nic>`); otherwise it never touches the router's WAN.
- To force LAN traffic over wwan while fiber is the default route, add a
  `/32` route for the test server: `ip route add <ip>/32 dev wwan0_1`.
- Test images start with the clock at 1970 until NTP syncs, and HTTPS then
  fails with curl exit 60.
- Globe's APN blocks outside resolvers. Use the carrier DNS.
- `rmnet_rx` counters and the bind counters reset on every ifup, but the
  netdev's do not.

## Not covered yet

- IPv6 over the second QMAP channel (`wwan0_2`, `multiplexing 1`).
- Upstreaming 0119/0120 to nss-packages.
