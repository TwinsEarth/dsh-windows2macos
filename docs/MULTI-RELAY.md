# Multi-relay fleet: active-passive links and relay health (v1.5.0)

## The problem this answers

A machine is useful only where a relay lists it, and a dispatcher can only reach a machine on the
relay it is connected to. With one relay, a relay outage is a fleet outage, and a relay that is far
away is a latency tax on every dispatch. v1.5.0 adds a **standby relay link** and a **relay
watchdog**, and defines the routing rule that keeps the fleet coherent.

## Topology

```
                       ┌─────────────────────────────┐
        primary link   │ relay A (e.g. Tencent, CN)  │   dispatch target in normal operation
machine ───────────────►                             │
        (plugin agent) │                             │
                       └─────────────────────────────┘
                       ┌─────────────────────────────┐
        standby link   │ relay B (e.g. Vultr, JP)    │   dispatch target only when A fails
machine ───────────────►                             │
 (w2m-secondary-link)  └─────────────────────────────┘
```

Both links stay connected. **Active-passive is a routing rule, not two executors**: work is
dispatched through the primary relay; the standby link exists so the machine is already registered
and reachable when the primary relay is down or severely degraded. One executor per machine in the
normal case — no two relays racing to run the same project.

## The routing rule

* Primary = the healthy relay with the lowest measured latency **that lists every target machine as
  online**. Latency is measured as the round trip to `GET /healthz`, sampled per dispatch (and by
  the client status view).
* Failover = re-running the same selection with the failed relay removed. Because the standby link
  is already connected, failover costs a dispatch retry, not a machine reconnection.
* A relay whose `/healthz` fails or whose latency crosses the operator's threshold for two
  consecutive samples is demoted; the client shows the demotion.

## Relay nodes are fleet members too

Each relay host runs a `w2m-localside` member toward its own relay and toward the other relay(s),
joining with the account fleet key. The result is symmetric: `tencent-relay` appears on both
relays, `vultr-relay` appears on both relays, and relay latency/health is visible in the same device
list the machines use.

## Folding in the client (more than three relays)

The client shows at most three relay nodes and folds the rest:

```
relays: 3 shown · +2 online        (primary: tencent-relay 2 ms, standby: vultr-relay 531 ms)
```

Expanding reveals every node with its role (`primary`/`standby`/`offline`) and the last measured
latency. The data is the same `/v1/devices` + `/healthz` pair used by the selection rule, so the
fold never hides a node the router would consider.

## Keeping a relay online

Relays are expected to be online whether or not they currently have fleet members. Three layers:

1. `Restart=always` on `w2m-rabbit` / `w2m-stun` / the relay's member agent;
2. `deploy/relay/w2m-watchdog.timer` — checks `/healthz` for `"ok":true` every 30 s, restarts a
   wedged relay after two consecutive failures, capped at five restarts per hour;
3. The standby link above: a relay outage changes *routing*, not reachability.

See `deploy/relay/README.md` for installation and the verification commands.
