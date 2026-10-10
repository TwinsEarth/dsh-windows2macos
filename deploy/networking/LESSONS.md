# What a mature proxy client taught us about transport — and what it did not

This file records a **read-only study of [2dust/v2rayN](https://github.com/2dust/v2rayN)**, done to
find out which transport disciplines this project is missing. It exists because the study's
conclusions are only worth anything if they can be checked, and because one of them is a decision we
would otherwise have made wrongly.

## Provenance and licence

* Read at branch **`master`**, commit **`b501efbc45bca3c465df99af7d4ec092c2f4c40f`**. Paths below are
  relative to that clone, so every claim can be checked at that revision.
* **v2rayN is GPL-3.0** (`LICENSE`, the verbatim GNU GPL v3 text; no other licence statement in the
  repository). **This project is MIT.** No code, text or file was copied from it — not a fragment,
  not a paraphrase of code. Everything below is *description with citations*, and any implementation
  we write from it is our own.
* We did not modify v2rayN, and we did not open issues or pull requests against it.

## The decision this study changed: do not add a TUN/VPN mode

The tempting idea was "add a VPN so two machines behind hard NAT can reach each other". The study
says plainly that this does not do what it sounds like:

* v2rayN never creates an adapter or touches the routing table itself; it writes a declarative config
  and the external core (Xray/sing-box/mihomo) does the privileged work
  (`v2rayN/ServiceLib/Services/CoreConfig/V2ray/V2rayInboundService.cs:75-77`;
  `Sample/tun_singbox_inbound:10-13`).
* Its local inbound is loopback-only (`Sample/SampleInbound:5`), and every path is client → remote
  server. There is **no peer-to-peer anywhere in the codebase**: no hole punching, no candidate
  exchange, no relay of our kind — a grep for the concepts returns nothing, and the only STUN code is
  a UDP reachability *diagnostic* (`ServiceLib.UdpTest/Tester/StunService.cs:8-48`), not a data path.
* So a TUN interface is **hub-and-spoke by construction**: traffic between two of our machines would
  transit the hub. Our promise — "the data path is peer-to-peer" — would become **false for exactly
  the traffic the tunnel exists to carry**.

**Therefore: no TUN in this project for now.** It would cost administrator rights, a kernel driver,
and the truth of our central claim, while solving only part of what the delivery ladder already
addresses. If it is ever added, two invariants have to hold, and both belong in the ladder's
documentation rather than in a commit message: the control plane and the punch sockets must be
exempted from the tunnel, and tunnelled traffic must never be reported as `p2p`.

## Disciplines worth adopting, in the order we should adopt them

1. **Declare policy; let one worker enforce it.** v2rayN's central shape is an ordered, declarative
   policy consumed by a single enforcer (`Services/CoreConfig/…`), with validation that aborts a start
   rather than launching something broken (`Manager/CoreManager.cs:75-80`), mutating a deep copy
   rather than live config. Our ladder should be *data* — ordered rungs, each with its own bound and
   its own reason code — executed in one place.
2. **One named constant per network bound, and a bigger budget for the relayed leg.** `LocalFetch`
   5 s, `DirectDownloadConnect` 5 s, **`ProxyDownloadConnect` 10 s**, selected per hop
   (`Global.cs:100,103-104`; `Helper/DownloaderHelper.cs:336-339`). We cross NAT *and* a relay; the
   relay leg deserves its own larger bound instead of sharing one timeout with a LAN attempt.
3. **A distinguished failure value, never a silent zero.** `-1` as a failure sentinel
   (`Handler/ConnectionHandler.cs:34,72`), with dependent work explicitly skipped when a probe fails
   (`Services/SpeedtestService.cs:499-509`). Our `HELLO`/`HELLO_ACK` path should separate *no answer
   yet* / *refused* / *timed out* / *answered wrong*, and the ledger should name **which rung** failed
   rather than reporting a single boolean.
4. **Bounded attempts, then fall down the ladder.** `MaxTryAgainOnFailure = 2`, twice with a 500 ms
   gap (`DownloaderHelper.cs:37,71`; `ConnectionHandler.cs:39-47`). Give the simultaneous punch and
   the reverse dial two or three attempts each, and record the reason each one lost.
5. **Exempt the transport's own traffic from the transport.** v2rayN forces its cores and its own
   directory to go direct (`Services/CoreConfig/V2ray/V2rayRoutingService.cs:239-278`, emitted at
   `:16-30`). This is the most load-bearing lesson in the whole study: a control plane routed through
   the thing it controls is the most likely way to brick a machine.
6. **Teardown that is enforced by the OS, plus reaping at start.** Cores are assigned to a
   kill-on-close job object (`Services/WindowsJobService.cs:15-18`; `Manager/CoreManager.cs:360,365-376`)
   so a GUI crash still kills them, and stale devices are swept at the *next* launch
   (`Common/WindowsUtils.cs:55-75`). Our analogue: reap stale state and half-open punches on start
   instead of trusting a graceful exit.
7. **Validate, warn, fall back to a safe value.** Errors and warnings are separate lists; an
   unresolvable tag falls back with a warning; invalid values are blanked and reported
   (`Handler/Builder/CoreConfigContextBuilder.cs:3-26,70-136`).
8. **Ordered rules with a documented catch-all.** Tunnel/DNS/loop rules first, user rules next,
   catch-all last (`V2rayRoutingService.cs:9-64,215-237`). Only relevant to us if routing ever enters
   the picture — which, per the decision above, it has not.

## What we deliberately are not copying

Everything requiring an external core or administrator rights: Wintun/WFP plumbing, WinINet/RAS proxy
configuration with a registry fallback, PAC serving, route supernet arithmetic, TUN address pools,
per-process/per-domain routing, and core-level observatories/balancers. None of it is our shape, and
most of it is licensed work we must not take even if it were.

## One thing v2rayN does *not* do, which we should not admire

There is **no core auto-restart and no core-death notification**: the `Exited` handler only
unsubscribes log handlers (`Services/ProcessService.cs:132-142`). Its safety net is the job object
killing things reliably — not noticing and repairing. We already learned this the hard way: this
project's agent was twice found dead with a `0xC000013A` and nothing restarting it. Reliability by
construction is better than reliability by hope, and where we cannot have the former we now at least
have a watchdog that notices.
