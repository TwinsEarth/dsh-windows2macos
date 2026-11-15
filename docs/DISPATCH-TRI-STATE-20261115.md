# W2M dispatch tri-state evidence — 2026-11-15

Purpose: close the "operator-token dispatch surface" gap with **real** results for the ok / failed /
divergent states, plus the earlier partial sample. All commands were read-only (`write:false`).

## Test machines (isolated, stopped afterwards)

Two temporary `w2m-localside` agents were started with an isolated `DSH_HOME` under
`%TEMP%\dispatch-test`, a temporary project directory, `--p2p-mode relay`, and
`--allowed-commands '["node"]'`. They paired with the existing fleet key on relay
`http://43.142.74.71:8787` and were stopped after the runs:

| test machine | machine_id |
|---|---|
| w2m-dispatch-test-a | `2928da5e-4f79-4a9c-a84e-7d2823a2ca10` |
| w2m-dispatch-test-b | `ea844f5e-7b25-4853-b9cb-fa4907ff9a9b` |

## Samples

| state | task_id | command | verdict | evidence |
|---|---|---|---|---|
| **partial** | `01M7F44ZEQPBXXYEFJXG2HSNVA` | `node --version` (broadcast, no assignee) | partial | 196 leases on the shared relay: 30 refused `COMMAND_NOT_ALLOWED`, 166 expired, 0 ok |
| **ok** | `01M7FAW5A40HCYMTBSR14PXFBS` | `node --version` (assignee = test-a) | consistent | exit 0, transport relay, signature signed |
| **failed** | `01M7FAWB1QPPTEWV90N2TFHVWD` | `node --w2m-invalid-flag-123` (assignee = test-a) | failed | exit 9, status `nonzero_exit` |
| **divergent** | `01M7FAX3KFKV3G3CDRVY6YV5CK` | `node probe-exit.mjs` (target_machines = test-a/test-b) | divergent | both exit 0 but stdout differs; `differences` = `stdout_sha256`, `stdout_normalized_sha256` |

The divergent sample used two project directories with different `exit.json` contents and a
`probe-exit.mjs` that prints that value, so both machines succeeded with different stdout.

## Findings

1. The real production fleet still has an **empty command allow-list**: every real machine refused
   `node --version` with `COMMAND_NOT_ALLOWED`. The operator token was never the blocker — task
   creation, leases, `w2m_wait` and `w2m_report` all worked.
2. `w2m_run` with no assignee/selection broadcasts to **every relay-visible device** (196 here on the
   shared relay), not only the fleet. Always pass `assignee` (or select a machine) when testing.
3. With `--allowed-commands '["node"]'` and a scoped target, ok / failed / divergent all reproduce
   deterministically over the relay transport.

Reproduce (test machine only):

```
w2m_run(assignee=<test machine>, mode=replicate, command_argv=["node","--version"], write=false)
w2m_wait(<task_id>)
w2m_report(<task_id>)
```
