# P2P UDP port

Set `p2pPort` in the plugin config (or `--p2p-port` on the agent CLI) to bind a stable UDP port. This is required for a router port-forward: the public candidate, router mapping and local bind must be the same port.

```yaml
- id: w2m
  config:
    p2pPort: 31559
    p2pPublicPort: 31559
```

- Valid range: 1..65535; omitted/null keeps an ephemeral port.
- Invalid values are reported as `P2P_PORT_INVALID` in `w2m_status` and do not start a P2P node.
- Forward the same UDP port on the router to this machine, and allow it in the host firewall.

`p2pPublicPort` overrides the announced public port when the router forwards a fixed port but STUN reports a different outbound mapping. It must match the router external port.
