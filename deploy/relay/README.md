# Relay deployment: watchdog + secondary link (v1.5.0)

Two operational pieces live here.

## 1. Health watchdog (`w2m-watchdog.sh` + `.service` + `.timer`)

A relay must stay up whether or not it currently has fleet members: the machines on it reconnect
on their own, but a *wedged* relay (process alive, answering nothing) would look online to every
client. The watchdog checks `GET /healthz` for `"ok":true` every 30 s, so a restart happens before
clients notice:

```bash
install -m 0755 w2m-watchdog.sh /usr/local/bin/w2m-watchdog.sh
cp w2m-watchdog.service w2m-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now w2m-watchdog.timer
systemctl list-timers w2m-watchdog.timer
```

* two consecutive failures before any restart (a single dropped curl is not an outage),
* at most five restarts per hour (a restart loop hides the real cause; the log says so),
* restarts both `w2m-rabbit.service` and `w2m-stun.service`,
* logs transitions to `/var/lib/w2m/watchdog/watchdog.log`.

## 2. Secondary link (`bin/w2m-secondary-link.mjs`)

The plugin mounts one relay (`rabbitUrl`). The secondary link adds a *standby* connection to the
other relay so a dispatcher can fail over without waiting for a reconnect:

```bash
node bin/w2m-secondary-link.mjs \
  --relay http://202.182.123.154:8787 \
  --fleet-key <account fleet key> \
  --name <machine>-standby \
  --state ~/.dsh/xclient/secondary-link \
  --log ~/.dsh/xclient/secondary-link.log
```

Active-passive is a routing rule, not a second executor: both links are connected, work is
dispatched through the primary relay, and the standby becomes the primary only when the primary
relay is down or severely degraded. One executor per machine in the normal case; failover is a
dispatch decision instead of a reconnection.

Keep the supervisor alive with the platform's own service manager — the child is a normal
`w2m-localside` and may exit for ordinary reasons, and the supervisor restarts it with backoff:

* **systemd**: `ExecStart=/usr/local/bin/node <package>/bin/w2m-secondary-link.mjs ...`, `Restart=always`
* **launchd**: `KeepAlive` + `RunAtLoad`, stdout/stderr to a log file
* **Windows**: a scheduled task at logon running the same command; the launcher window can be hidden

### Verifying both links

```bash
# primary
curl -fsS http://127.0.0.1:8787/healthz | head -c 120

# each relay should list the machine while both links are up
curl -fsS -H "authorization: Bearer <device token>" http://<relay>/v1/devices
```

When more than three relays exist, the client should fold the relay list into a summary
(`relays: 4 online / 4 total`) rather than showing every node; the data for that view is the same
`/v1/devices` + `/healthz` pair this document uses.
