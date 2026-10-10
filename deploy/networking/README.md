# Networking: how the fleet gets from one machine to another

This directory is about the one thing that decides whether a fleet is pleasant or infuriating:
**which path the bytes actually take**, and what to do when the direct one is not available.

The control plane is never in question. Devices, tasks, leases, results and the ledger all go through
the relay on the shared server (`http://202.182.123.154:8787`), because that is what makes a task
*auditable*: one place holds what was asked, who took it, what came back and by which path. The data
plane is where the interesting failures live, so it is arranged as a ladder — each rung is tried,
and a rung that cannot be opened is recorded with its reason rather than guessed at.

## The ladder

| rung | mechanism | what the ledger shows | what it costs |
|---|---|---|---|
| 1 | a channel is already open | `transport: p2p`, `offer_path: p2p` | nothing |
| 2 | **simultaneous punch (A)** — the dispatcher punches, and the executor dials the same session it was told about | `transport: p2p`, `offer_path: p2p` | two NATs must agree, or one side must be dialable |
| 3 | **reverse dial (B)** — no channel existed, so the receiving side dialled out to deliver the result | `transport: p2p`, `offer_path: relay` | the result found its own way home while the offer needed the relay |
| 4 | **tunnel (C)** — WireGuard on the shared server, and every machine gets a routable `10.66.0.x` | `transport: p2p` — **indistinguishable from rung 1–2** | see the warning below |
| 5 | relay | `transport: relay` + a `p2p.reason` naming why | the relay carries the data |

**Rung 4 is the one to read carefully.** WireGuard has no NAT traversal of its own — that is exactly
what Tailscale adds on top of it (disco/DERP) and what rungs 2 and 3 are for. So with two machines
behind NAT, traffic between their `10.66.0.x` addresses is **forwarded through the VPS**. The ledger
will say `p2p`, and it will not be lying: from W2M's point of view that socket is direct. But the
bytes cross a server. If you asked for "the data goes peer to peer", rung 4 does not satisfy that —
it satisfies "the fleet works regardless of NAT, encrypted, with no third party", which is a
different and still useful promise. Rung 2/3 are the ones that make the data path direct.

## What is measured, and by what

`acceptance.mjs` dispatches a real command to every online machine through the relay's HTTP API and
then reads back what each machine recorded. It is deliberately blunt: it does not synthesise packets
or poke at NATs itself, because a script that punched its own holes would prove that the script can
punch, which nobody doubts.

```bash
node deploy/networking/acceptance.mjs \
  --rabbit http://202.182.123.154:8787 \
  --token <operator token> \
  --project /path/to/the/fleet/project \
  --command 'git rev-parse HEAD' \
  --require-direct          # optional: exit non-zero if any machine lands on rung 5
```

Requirements and behaviour worth knowing before you read its output:

* **Both credentials.** Dispatching needs the **operator** token (`--token`, or
  `W2M_OPERATOR_TOKEN`); reading a task back is a device-scoped read and needs the **device** token
  from `device.json` (`--state-dir`, default `$DSH_HOME/xclient`). Measured: the operator token alone
  answers `401 missing or invalid device_token`. The split is deliberate — the credential that can
  order work around cannot also read every machine's results.
* **Every machine must be on the same commit.** The script fingerprints `--project` with
  `git-temp-index-tree/v1` and sends it as the anchor; machines that are not there refuse or report
  `unverifiable`. That is the mechanism working, not the script failing.
* **`--command` takes plain text** (`--command 'git rev-parse HEAD'`). A JSON array is the natural
  spelling and it does not survive a Windows command line: `'["git","rev-parse","HEAD"]'` arrives as
  `[git,rev-parse,HEAD]`. The script still accepts JSON when the shell passes it through intact.
* **Transient network failures retry.** An acceptance run that reported "the fleet is broken" because
  one TCP connect to another continent timed out would be worse than useless.
* **What it exercises is rungs 3 and 5 (and 2 once A lands).** Because the script dispatches *through
  the relay*, the offer arrives by relay — which is exactly the situation the reverse-dial work
  addresses. The dispatcher-side punch is performed by the plugin's own `w2m_run`, which pushes to
  each peer directly before falling back. So the two commands answer different questions:

  | command | question |
  |---|---|
  | `w2m_run` + `w2m_wait` (the DSH tools) | what does the whole delivery path do, including the dispatcher's push? |
  | `acceptance.mjs` | what do the **machines** do when the offer arrives by relay? |

  Run both. If `w2m_run` shows `p2p` while `acceptance.mjs` shows rung 5 for the same pair, the
  dispatcher's push is working and the receiving side is not dialling back — which is precisely the
  gap rungs 2 and 3 close.

## Baseline, measured 2026-10-10 (before A/B landed)

```
machine      outcome  exit  rung  path   offer  note
jp-shared    ok       0     5     relay  relay  relay fallback -- P2P_NO_CANDIDATES ...
win-desktop  ok       0     5     relay  relay  relay fallback -- P2P_NO_CANDIDATES ...
macmini      ok       0     5     relay  relay  relay fallback -- P2P_NO_CANDIDATES ...
```

The same fleet, dispatched through the plugin's `w2m_run` instead (which pushes directly), gets
`p2p` for the two machines that can be dialled. Both readings are true; they are readings of
different layers. Keep the baseline above and re-run it after the reverse-dial work lands: rung 5
becoming rung 2 or 3 for a machine that used to fall back is the evidence that it worked.

## Rung 4: the WireGuard hub on the shared server

Set up and running on the Tokyo VPS. `deploy/networking/wireguard/server-setup.sh` is the whole
thing: it generates keys once (and reuses them afterwards, so a client that already has a config
keeps working), writes `/etc/wireguard/wg0.conf`, opens the port and starts the hub. It prints a
client config on demand — that is the only thing a client needs from this host:

```bash
bash server-setup.sh                    # on the always-on host, as root
bash server-setup.sh --client macmini   # prints a config to paste into the WireGuard app
```

```
interface wg0   listening 51820/udp   server 10.66.0.1/24
peers: 10.66.0.2 (win-desktop), 10.66.0.3 (macmini)      ufw: 51820/udp allowed
```

Each client routes **only** `10.66.0.0/24`, so nothing of your ordinary traffic can travel through
the VPS and no DNS is touched. Client install: Windows `winget install WireGuard.WireGuard` (needs
elevation) then import the `.conf`; macOS the WireGuard app or `brew install --cask wireguard-tools`.
Verify from the server with `wg show`: a `latest handshake` line per peer is the proof it is up.

Two port notes, both learned the hard way:

* **51820 is WireGuard's default, so do not give it to anything else.** The W2M agent on this machine
  was briefly pinned to 51820 (to match an inbound firewall rule) and was moved to **41235** when the
  tunnel arrived.
* **An inbound firewall rule is not a route.** A rule for `51820/udp` on a machine behind
  carrier-grade NAT cannot make that machine dialable: the carrier drops the packet before the host
  firewall ever sees it. Rules matter again the moment the machine has a real mapping (a normal
  router, or the tunnel).

## The honesty section

* **Rung 5 is not a failure.** A task that completes over the relay completed. The ledger naming the
  path is the feature; pretending every path is direct would be the bug.
* **A `p2p` reading on a tunnel (rung 4) does not mean the bytes avoided a server.** See above.
* **A symmetric NAT cannot be dialled into, ever.** Not by this project, not by Tailscale. What can
  be done is to have the symmetric side dial *out* (rungs 2 and 3) or to stop being behind it
  (rung 4, or another network).
* **Nothing here injects prompts into another machine's model session.** The fleet transports
  commands, their output, and the comparison between them.
