# M1 real-machine acceptance runbook (v1.3.10-beta.2+)

> Goal: prove, on real machines, that a signed maintenance request updates/restarts/diagnoses a machine **without SSH and
> without widening the allow-list**. This needs one privileged bootstrap per machine; after that everything is remote.

## 0. Prerequisites

1. The machine already runs the plugin (any version >= 1.3.10-beta.2) and the agent is paired.
2. The relay runs a version that carries the maintenance fields (**v1.3.10-beta.2 or later**). A 1.3.1 relay silently drops them.
3. You have one-time root (Linux) / Administrator (Windows) access to run the bootstrap script.

## 1. Bootstrap (once per machine)

Linux:

~~~bash
# copy the package to /opt/w2m/app first (deploy-w2m.sh), then:
sudo bash /opt/w2m/app/deploy/maintenance/bootstrap.sh \
  --app-dir /opt/w2m/app \
  --machine-id <machine_id> \
  --operator-key /tmp/operator.pub.pem
~~~

Windows (Administrator PowerShell):

~~~powershell
powershell -ExecutionPolicy Bypass -File C:\w2m\app\deploy\maintenance\bootstrap.ps1 \
  -AppDir C:\w2m\app -MachineId <machine_id> -OperatorKey C:\w2m\operator.pub.pem
~~~

The bootstrap installs a SYSTEM path/task that executes only update/restart/diag, creates the queue directories the agent
writes to, and pins the operator public key. It never installs a shell.

## 2. Dispatch a signed request

Use scripts/m1-acceptance.mjs on the control side:

~~~powershell
$env:W2M_OPERATOR_TOKEN = '<operator token>'
$env:W2M_DEVICE_TOKEN = '<this control machine device token>'
node scripts/m1-acceptance.mjs --machine-id <target machine_id> --action diag
~~~

Expected: task ends done, evidence file written under docs/acceptance/<version>/, and the target machine's
/var/lib/w2m/maintenance/done/<request_id>.json holds the runner result.

## 3. Acceptance cases (record evidence for each)

| Case | Request | Expected |
|---|---|---|
| M1-DIAG | action=diag | done; result sections include version/services/journal/disk |
| M1-RESTART | action=restart targets=agent | done; machine heartbeats again |
| M1-UPDATE | action=update version=<next> sha=<asset sha> | done; package.json version changes; app.old kept |
| M1-UPDATE-ROLLBACK | same but broken sha/artifact | failed; previous tree still served (rollback) |
| N1-EXPIRED | request with expires_at in the past | refused MAINTENANCE_EXPIRED, nothing executed |
| N2-REPLAY | same request_id twice | second refused MAINTENANCE_REPLAY |
| N3-TAMPER | change a param after signing | refused MAINTENANCE_BAD_SIGNATURE |
| N4-WRONG-MACHINE | machine_id of another host | refused MAINTENANCE_WRONG_MACHINE |

## 4. What "green" means

- Every positive case has a result file whose status is ok and whose assertions match the table.
- Every negative case has a named refusal and **left the machine unchanged** (version, service state).
- The ledger contains maintenance_summary for each task and the evidence JSON records task_id + assertions.

## 5. Known limitations to state in the release note

- The bootstrap itself needs privilege; the channel removes SSH **after** it.
- TOFU key pinning: first key seen wins until rotated by a signed rotation. Pairing-time pinning is the planned hardening.
- No automatic rollback if the machine cannot be reached after restart; the operator re-dispatches restart (idempotent).
