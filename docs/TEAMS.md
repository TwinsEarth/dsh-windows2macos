# Teams: shared room, two planes, one WebRTC pool

Status: **design + implemented slice (2026-11-23)**. Teams is an opt-in sub-plugin (`dsh-teams`),
disabled by default. It adds a shared-room view and a bulk-data path; it does not add an approval
or dispatch entry point.

## 1. Two planes

| plane | carries | channel | attempts |
|---|---|---|---|
| control | heartbeat, presence, user info, roster, plan, approval, lease, task control, council, room events | `relay-tcp` | 1 |
| data | file, image, artifact, blob, data sync | `webrtc-v1` | exactly 33 |

Control is small and must be reliable. Data is large and must not quietly become a relay bandwidth
bill. The asymmetry is the policy, not an implementation detail.

When all 33 WebRTC attempts fail, `transport-policy.bulk()` returns
`TEAM_DATA_P2P_EXHAUSTED` with an `alert`. The data plane does **not** call `sendControl()` and does
not fall back to the relay. The relay still carries the control-plane ledger for the task; that is
a different plane.

## 2. One pool, not one per subsystem

`WebRtcTransportPool` owns one 1:1 transport per peer pair. `tools/shared.mjs` builds the process's
pool when `config.webrtc` is buildable and publishes it through `webrtc-pool-registry.mjs`.

`TeamsDataPlane` consumes that same pool:

- `sendArtifact()` chunks bytes into bounded frames and calls `transport-policy.bulk()` per frame;
- `onMessage()` accepts `team.artifact.chunk` frames, reassembles them, verifies SHA-256, and writes
  the verified bytes through `deliverArtifact()` into the configured artifact sink (dir / lan-git /
  ssh) or local retention when no sink exists;
- an exhausted transfer writes `teams/data-plane-alerts.jsonl` and calls the injected alert hook.

A CLI that needs the same path uses `createTeamsDataPlaneFromEnv()`. It refuses to guess: it requires
`W2M_WEBRTC_SIGNAL_URL` and `W2M_WEBRTC_PROVIDER_COMMAND`, and reads the machine identity from
`device.json`. This prevents a one-shot CLI from starting a second signaling role on a machine id
that a long-running agent already owns.

## 3. Artifact sink

`deliverArtifact({dataPlane, peer, bytes, taskId, kind, name})` is the wiring point:

1. if `dataPlane` and `peer` are present, bytes go over WebRTC to the peer's sink;
2. success returns `transport: 'webrtc-v1'`, the digest and the peer;
3. exhaustion returns `TEAM_DATA_P2P_EXHAUSTED`, `alert`, and keeps a local copy;
4. without a peer, the existing local-sink behavior is unchanged.

The receiver verifies the digest before writing. A mismatch is reported as `digest-mismatch` and
nothing reaches the sink.

## 4. Merge CLI

`bin/w2m-joint.mjs merge --peer <machine-id>` sends the patch manifest through the same data plane
before the local merge:

```bash
node bin/w2m-joint.mjs merge \
  --repo <dir> --base <sha> --target-ref refs/heads/<branch> \
  --expected-old <sha> --patches <manifest.json> --peer <machine-id>
```

The printed report includes `data_plane: {transport, channel, peer, sha256, bytes}`. Without `--peer`
the command is unchanged and stays fully local.

## 5. Status surface

`w2m_team_status` reports:

- `transport.control.channel = 'relay-tcp'`, `max_attempts = 1`;
- `transport.data.channel = 'webrtc-v1'`, `max_attempts = 33`;
- `transport.data.data_plane`: pool availability, pool diagnostics, send/receive counters, alert
  count and last alert.

`w2m_team_artifact` sends one local file to a peer over the same path. It is a byte mover, not a
dispatch tool.

## 6. Failure codes

| code | meaning |
|---|---|
| `TEAM_DATA_P2P_EXHAUSTED` | 33 WebRTC attempts failed; abandoned, alert raised, relay not used |
| `TEAM_DATA_POOL_REQUIRED` | no shared WebRTC pool is attached |
| `TEAM_DATA_PEER_REQUIRED` | no target machine id |
| `TEAM_DATA_ARTIFACT_EMPTY` | zero-byte artifact |
| `TEAM_DATA_ARTIFACT_TOO_LARGE` | above the 64 MiB Teams artifact cap |
| `TEAM_DATA_FRAME_INVALID` | malformed chunk frame |
| `TEAM_DATA_DIGEST_MISMATCH` | reassembled bytes do not match the declared SHA-256 |
| `TEAM_DATA_PLANE_NOT_CONFIGURED` | CLI factory has no signal URL or provider command |
| `TEAM_DEVICE_IDENTITY_MISSING` | CLI factory cannot find `device.json` |
