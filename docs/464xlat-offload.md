# 464xlat (CLAT) offload on `ppe-nss`

Status (2026-10-17): **implemented and verified on the board** (USB
initramfs), pushed as branch `nss-wifi-xlat-offload` on XT-Martinez/openwrt
(three commits on top of `ppe-nss` 5b010cdd80, which includes #41).
It builds on the cellular raw-IP offload
([PR #41](https://github.com/JuliusBairaktaris/openwrt-ppe-nss/pull/41), merged) and
goes to Julius's tree as a follow-up PR.

A CLAT's connections are carried by the NSS firmware's MAP-T translator: both
halves of each connection are installed as firmware rules, and the firmware
translates IPv4↔IPv6 itself. In testing, the host saw only the first few
packets of each connection.

This replaces the 2026-10-16 feasibility note, which concluded the opposite.
Its premise was wrong: the existing flowtable path can carry a CLAT without a
translation action, because the kernel already splits a CLAT connection into
two ordinary ones (§2).

---

## 1. Results

Measured over Smart's IPv6 PDN (`wwan0_2`), carrier NAT64 `64:ff9b::/96`,
wired client `192.168.254.150` on `lan4`. Only test destinations were routed
through the CLAT (§5).

| Test | Result |
|---|---|
| Firmware MAP-T nodes on core 0 | allocated (e.g. `nodes 33/34`); rule with `local.style NONE` accepted |
| Rules per connection | IPv4 `if 4/33` (lan4 ↔ inner) + IPv6 `if 34/41` (outer ↔ `wwan0_2` raw-IP node), `installed 1` |
| conntrack | both legs `[HW_OFFLOAD]`, 2–4 packets seen by the host per leg |
| Single stream, Cloudflare 25 MB | 91–119 Mbit/s (same as plain IPv4 modem offload) |
| 4 streams, ~38 s | 135–157 Mbit/s every second, 650 MB; then Cloudflare HTTP 429 (rate limit) |
| Upload 30 s | 8–9 Mbit/s (uplink limit), all via the inner node |
| Single stream, Hetzner fsn1 50 MB | 52–53 Mbit/s (single-stream TCP limited by the long path) |
| Firmware counters after stress test | outer 666,626 / inner 181,493 packets, `exception 0`, `no-rule 0` |
| Host fallback (`back4`) | ~2 packets per new connection (setup only), `drop 0` |
| Router CPU, 4-stream download | 3–10 % all cores, busiest core ≤ 19 %. Same as the IPv4 modem path; the cost is the USB modem RX, not the CLAT |
| Latency vs IPv4 PDN | within run-to-run variation (table below) |
| `464-clat` netdev counters | follow the firmware (§3.5): RX/TX 42,181 pkts after a 50 MB download = firmware 42,153 + 28 software |

Latency from the test host, same destinations, only the router's route
swapped. Two rounds, 20 pings each:

| Destination | CLAT avg | IPv4 PDN avg |
|---|---|---|
| ping 1.1.1.1 | 37.6 / 43.5 ms | 32.6 / 42.2 ms |
| ping 8.8.8.8 | 23.3 / 27.7 ms | 23.9 / 24.5 ms |
| TCP connect (Cloudflare) | ~38 / 42 ms | ~37 / 38 ms |

ICMP and TCP handshakes go through nat46 in software (only established TCP/UDP
flows are offloaded), and the paths differ beyond the router (Smart's NAT64 vs
its IPv4 NAT). There was no measurable translation delay and no loss.

---

## 2. How it works

nat46 delivers what it translates with `netif_rx()` on its own device. So a
LAN client's IPv4 connection through the CLAT is, to the kernel, **two
forwarded connections**:

1. IPv4: LAN port ↔ `464-<cfg>` (SNAT to `192.0.0.1`, added by the 464xlat proto)
2. IPv6: `464-<cfg>` ↔ uplink (`wwan0_2` raw-IP, or a switch port), no NAT

The flowtable offers each one separately. `nss-wifi-drv` installs each as an
ordinary IPv4 or IPv6 rule, and for the CLAT end it names the MAP-T **inner**
node in IPv4 rules and the **outer** node in IPv6 rules, which is how the
vendor ECM did it. In the firmware, a packet from the LAN matches the IPv4 rule
and goes to the inner node. The inner node translates it and hands it to the
IPv6 engine, where it matches the IPv6 rule and leaves via the modem node. The
reverse direction works the same way through the outer node. The two rules are
installed independently, so no pairing logic is needed.

Until both rules exist, a packet falls out of the firmware half-way,
translated. The inner node hands up IPv4 behind a 14-byte Ethernet header, and
the outer node hands up IPv6 behind a 14-byte metadata block. The driver
delivers it with `netif_receive_skb` as if it had arrived on the nat46 device,
which is exactly what nat46 would have produced. The stack then sees and
offers the missing half.

---

## 3. Implementation

### 3.1 `nss-wifi-drv` (`openwrt/package/kernel/nss-wifi-drv`)

- **`src/nss_xlat.c`** (new, modelled on `nss_rawip.c`):
  - **Table:** up to 4 nat46 devices.
  - **Detection:** an `ARPHRD_NONE` device whose rules `nat46_get_rules()`
    returns.
  - **Pairing:** on `NETDEV_UP` or core arm, allocate
    `NSS_DYNAMIC_INTERFACE_TYPE_MAP_T_INNER` (20) and `_OUTER` (21), then
    send `NSS_MAP_T_MSG_INSTANCE_RULE_CONFIGURE` for every rule pair to both
    nodes, each naming the other as `sibling_if`. Rules the vendor client
    would refuse are checked first (style, RFC 6052 prefix length, MAP
    EA/PSID limits); a device with such a rule is left to the host.
  - **Unpairing:** on `NETDEV_GOING_DOWN`/`UNREGISTER`, withdraw the rules
    naming either node, then deconfigure and release inner then outer.
  - **Hand-backs:** `nss_xlat_recv` takes packets from the nodes, from both
    lent buffers and returned tx-bidir buffers, recomputes the IPv4 header
    checksum, and injects them on the nat46 device.
  - **Statistics:** `nss_xlat_notify` takes the nodes' `SYNC_STATS` before the
    vdev handler and adds them to the device's counters (§3.5).
  - **Retry:** a refused pairing is retried (§4.1).
  - **Switch and debugfs:** module param `xlat` (default on); debugfs `xlat`
    shows nodes, rules, `back4/back6/drop` and the firmware counters.
- **`src/nss_flow.c`:**
  - `take_dir` resolves a CLAT ifindex with `nss_xlat_ifnum(ifindex, v6)`
    before the port lookup.
  - `is_ours` accepts bound CLATs.
  - A CLAT `out` with no neighbour MAC gets the dummy `02:46:46:00:00:00`
    (the node strips the frame).
  - `nss_flow_indr_cb` binds the flow block of nat46 devices as well as
    raw-IP ones (unbind is accepted for any `ARPHRD_NONE`).
- **Hooks:**
  - `nss_ring.c`: receive in both the tx and rx branches; notify before vdev.
  - `nss_core.c`: halt, detach, debugfs, module init/exit.
  - `nss_phys.c`: arm.
  - `nss_drv.h`: prototypes.
  - `nss_fw.h`: MAP-T node types 20/21.
  - `src/Makefile`: the new object.
- **`files/nss-wifi.flowtable`** (fw4 include): also adds up nat46 devices
  (type 65534 listed as `add <dev>` in `/proc/net/nat46/control`) to
  `inet fw4 ft`, because fw4 leaves them out just as it does raw-IP devices.

The MAP-T message is sent through its own struct and `nss_msg_send`.
`nss_phys_msg`'s 56-byte union is too small for the 116-byte rule. The layout
follows the public `nss_map_t.h` (12.5): IPv6 prefixes as host-order words,
IPv4 prefixes `ntohl`. It is guarded by `static_assert` on the size.

### 3.2 nat46 (`openwrt/package/kernel/nat46/patches/200-export-rules-for-offload.patch`)

Upstream nat46 exports nothing. The patch adds
`nat46_get_rules(dev, pairs, pair_size, max)`. It checks that `dev` is a nat46
device and that `pair_size` matches its rule pair, then copies the rules under
the instance refcount (`get_nat46_instance_dev`, split out of
`get_nat46_instance`). The driver looks it up with `symbol_get`, so it loads
without nat46.

On the edma-nss stack (`nss-edma-rework`) this patch is not needed: nat46
there carries the QSDK series (`102-mapt` … `122`), whose `nat46_get_info`
the vendor MAP-T client uses. That stack would need `qca-nss-clients`' MAP-T
connection manager packaged instead.

### 3.3 Build config

`aw1000-feed/build/config` enables `CONFIG_PACKAGE_464xlat=y` and
`CONFIG_PACKAGE_kmod-nat46=y`.

### 3.4 What the firmware does that the code relies on

All of this was checked on hardware, firmware 12.5 (`nss-firmware`
2025.05.01), core 0:

- Core 0 allocates MAP-T nodes (DTS `qcom,map-t-enabled` is on core 0).
- It accepts `local_map_style` NONE (a CLAT's `/32` ↔ `/128`), with
  `remote_map_style` RFC6052 `/96`.
- The rules are ordinary IPv4/IPv6 rules with the MAP-T node as one end; no
  special flags are needed.

### 3.5 Device counters

Offloaded packets never touch the nat46 device, so before this the device
(LuCI, `ip -s link`) showed only what nat46 handled in software. That was 62
packets after hundreds of MB. The driver now adds each node's statistics push
to the device the way nat46 counts its own traffic:
- **tx** (into the device) += each node's rx;
- **rx** (translated out) += each node's tx;
- the nodes' drops go to `tx_dropped`.

This is what the vendor's `nat46_update_stats` did.

---

## 4. Findings

### 4.1 The firmware frees MAP-T nodes lazily (fixed, verified on hardware)

12.5 allows only a few MAP-T nodes (`NSS_MAX_MAP_T_DYNAMIC_INTERFACES 4` in
the vendor header). A released pair is freed only **30–60 s later**, and
allocation is refused (`interface 176 type 0 refused: 7` =
`NSS_DYNAMIC_INTERFACE_ERR_EALLOC`, logged as `no NSS MAP-T node pair: -71`)
until then:

- Three quick down/up cycles got fresh numbers (33/34, 35/36, 37/38). Every
  attempt after that was refused, until ~55 s after the last release.
- This happens on a normal boot. The 464xlat proto created the CLAT, deleted
  it and recreated it within a second (`214.4 s` paired → `215.4 s` deleted →
  `215.6 s` refused), leaving it working but not offloaded.

Fix: a refused pairing (anything but a rule the firmware cannot take) is
retried from a delayed work after 2, 4, 8, 16 s, then every 30 s, for 8 tries
(~2.5 min). Release order now matches the vendor (inner, then outer).
Verified on the 2026-10-17 boot: refused four times (164–178 s), paired on
nodes 33/34 at 195 s.

### 4.2 The `dhcpv6` proto's own CLAT fails here

With an IPv6-only uplink, the `dhcpv6` proto spawns `<iface>_4` (proto
464xlat) itself. `464xlatcfg` finds the NAT64 prefix by resolving
`ipv4only.arpa` through the router's dnsmasq. Dnsmasq forwards to the wired
WAN's resolver, which has no DNS64, so `464xlatcfg` exits 2 and `wwan_6_4`
loops down/up. Smart's DNS64 does return `64:ff9b::c000:aa`. Work-around in
testing: a dedicated `clat` interface with an explicit `ip6prefix`, with
`wwan_6_4` taken down. In an IPv6-only deployment that uses the carrier's DNS
this does not arise. This is a configuration issue, not the offload.

### 4.3 Don't bounce the nat46 device by hand

`ip link set 464-<cfg> down/up` makes the kernel drop the device's routes,
including the `/128` in table `prelocal` (128) that steers replies for the
CLAT address into the device. netifd does not restore it, so replies land on
the local anycast address and are dropped: the CLAT goes silent, offloaded or
not. Restart a CLAT with `ifup <iface>` instead. If it has been bounced:
`ip -6 route add <CLAT>/128 dev 464-<cfg> table 128 metric 128` plus the IPv4
default via the device.

### 4.4 Stale router-local IPv6 on `wwan0_2` (seen once, unexplained)

Once on the second test boot, IPv6 to the router itself over `wwan0_2`
(native, not the CLAT) stopped working: replies were handed to the firmware
and never came back (`rawip` `back` flat). It happened with the CLAT's nodes
released too, so it is not MAP-T. LAN clients' offloaded IPv6 kept working. An
`ifup wwan` (new raw-IP node pair) fixed it. That boot had re-paired the modem
channels several times while the data call came up. Watch for it in the
raw-IP offload; it is not specific to 464xlat.

---

## 5. Test setup (reproducible on a USB boot; all RAM-only)

```sh
# IPv6 PDN beside the IPv4 one: v4 on wwan0_1, v6 on wwan0_2 (+ dynamic wwan_6)
uci set network.wwan.pdptype=ipv4v6
uci set network.wwan.multiplexing=1
uci set network.wwan.apnv6=smartlte
# CLAT with the carrier's NAT64 prefix (see §4.2)
uci set network.clat=interface
uci set network.clat.proto=464xlat
uci set network.clat.tunlink=wwan_6
uci set network.clat.ip6prefix=64:ff9b::/96
uci set network.clat.zone=wan
uci commit network; ifup wwan            # wait for wwan_6 up
ifdown wwan_6_4; ifup clat
cat /sys/kernel/debug/39000000.nss/xlat  # nodes N/M, rules 1
# Route only the test host's traffic to test IPs through the CLAT
ip rule add pref 100 from 192.168.254.150 lookup 200
ip route add 162.159.140.220/32 dev 464-clat table 200
```

The CLAT's own IPv4 default route has metric 2048, so the wired `wan`
(metric 0) stays the default. Cloudflare `__down` rate-limits (HTTP 429) after
~650 MB in a burst; Hetzner `fsn1-speed.hetzner.com` works as a second source.

Images: `initramfs` `b7149eb6…` (first boot: offload), `7849be80…` (second
boot: + device counters). The retry fix (§4.1) is not in an image yet.

---

## 6. Open items

- Boot an image with the retry fix and confirm a CLAT recreated during boot
  ends up paired (`xlat` shows nodes, `dmesg` shows the retry succeeding).
- SQM: shape the uplink device (`wwan0_2`), not `464-clat`. Offloaded
  packets never pass the nat46 device, so a qdisc there sees only the
  software packets. Every CLAT packet does cross `wwan0_2` as IPv6, on the
  host: download comes in over USB, where the ingress ifb runs before the
  offload's rx handler, and upload comes back from the firmware through
  `dev_queue_xmit`. This is the same mechanism as SQM on `wwan0_1` with the
  raw-IP offload (`PPE-NSS-MIGRATION.md` §6.5.5), but it has not been tested
  on `wwan0_2`. All CLAT traffic shares one IPv6 source address, so cake's
  per-host fairness cannot tell LAN hosts apart for it; per-flow fairness
  still works.
- sysupgrade image not tested; only USB initramfs.
- An IPv6-only PDN (no IPv4 call) with the CLAT as the IPv4 default route has
  not been tried; the tests ran beside the IPv4 PDN with policy routes.
- Commit (Julius's style: `Assisted-by: Claude:claude-opus-5-5`,
  `Signed-off-by: Christian Martinez <xtian437@gmail.com>`) and open the PR to
  `JuliusBairaktaris/openwrt-ppe-nss` after #41 is merged. It consists of the
  `nss-wifi-drv` changes, the nat46 patch and the flowtable include.
