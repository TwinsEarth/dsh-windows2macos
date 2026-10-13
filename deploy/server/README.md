# Running the relay on a server

These are the units the shared relay **actually runs**, copied from
`/etc/systemd/system/` on the live host rather than written from the documentation. They are in the
repository because "how the server runs" is part of the thing being open-sourced — and because a
unit that exists only on one machine is a unit nobody can review, reproduce, or audit.

## The three services

| Unit | What it is | Port |
|---|---|---|
| `w2m-rabbit.service` | The relay: P2P rendezvous, signalling, and the task ledger | 8787 |
| `w2m-stun.service` | STUN responder, for reflexive address discovery during hole punching | 3478 |
| `w2m-localside.service` | A Localside agent, so the server is itself a fleet machine | — |

`w2m-localside` is deliberately the same agent every other machine runs. The server is not
privileged in the fleet's protocol — it is a peer that happens to be reachable — and running it
through the normal agent is what keeps that true.

## ⚠️ What is NOT here, and why

**`/var/lib/w2m/rabbit/` is not in this repository and must never be.**

It holds:

| File | Why it must not be published |
|---|---|
| `operator-token.txt` | **Full control of the fleet.** Anyone holding it can dispatch any allowed command to every machine. |
| `ledger` | The task history: every command run, on which machine, with which results. |

Two mechanisms keep this true, because one is not enough:

1. **`.gitignore`** refuses the paths, so an accidental `git add -A` cannot stage them.
2. **`scripts/scan-for-secrets.mjs`** reads the **content** of every tracked file and fails the
   release on a credential shape. A `.gitignore` refuses a *path*; the ways a credential actually
   escapes are pasting one into a source file, a fixture, or an example — so tracked content is
   what gets read.

Run it before a release:

```bash
node scripts/scan-for-secrets.mjs .
# 0 blocking, N for review -> exit 0
```

`REVIEW` findings (long hex strings, high-entropy assignments) are **not fatal by design**: a
scanner whose false positives block releases is a scanner someone deletes. Only real credential
shapes stop anything.

## Installing

```bash
# 1. A user that owns the state and nothing else.
sudo useradd --system --home /var/lib/w2m --shell /usr/sbin/nologin w2m

# 2. The paths the units reference.
sudo install -d -o w2m -g w2m /opt/w2m /var/lib/w2m /var/log/w2m

# 3. The code, at the tag being deployed.
sudo -u w2m git clone https://github.com/TwinsEarth/dsh-windows2macos /opt/w2m/app
sudo -u w2m git -C /opt/w2m/app checkout v0.7.10

# 4. The units.
sudo cp deploy/server/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now w2m-rabbit w2m-stun

# 5. Pair the server as a fleet machine, then enable the agent.
sudo systemctl enable --now w2m-localside
```

## Notes on the hardening, since it is easy to weaken by accident

Every unit sets `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, and a `ProtectSystem` level, and
writes only inside `/var/lib/w2m` via `ReadWritePaths`. That last one matters: `ProtectSystem=full`
makes `/usr` and `/boot` read-only, so an agent that tried to write anywhere else would fail
loudly rather than silently succeed on a machine that should not be writable.

`w2m-stun` is stricter (`ProtectSystem=strict`, `RestrictAddressFamilies=AF_INET AF_INET6`) because
it needs a socket and nothing else.

**If you add a capability to an agent, check `ReadWritePaths` first.** The failure is a permission
error at runtime, which looks like a bug in the agent rather than a hardening setting.

## The `--fleet` flag, and why it is absent here

`w2m-rabbit` accepts `--fleet <account code>`, which binds the relay to one account's fleet. It is
**absent from this unit on purpose**, and the relay therefore runs unscoped: every paired device
reaches every other.

Turning it on is not a configuration change — it is a **fleet migration**:

1. the account code must be read on a machine that is **signed in** (a headless server cannot
   produce one; it has no DeepSeek account),
2. the relay restarts scoped,
3. **every device must be re-paired**, because a device receives its fleet *from the pairing code*,
   and on a scoped relay a device with no fleet reaches **nothing**.

Step 3 is the risk: the fleet goes silent until each machine is re-paired. That is the intended
fail-safe direction and it is still an outage while it lasts.

## Deliberately not included

* **TLS termination.** The live relay is behind a proxy that handles it; `--base-path` and
  `--trust-proxy` exist for that arrangement and the certificate is the operator's business.
* **Backups.** The state directory is small (about 1 MB) and is the operator's to schedule. The
  deployment script below does back it up before a swap, which is not the same as a backup policy.
* **Log rotation.** `StandardOutput=append:` grows without bound; the live host rotates
  `/var/log/w2m/*.log` outside these units.
