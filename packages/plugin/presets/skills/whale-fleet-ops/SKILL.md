---
name: whale-fleet-ops
description: Operate a Whale multi-host DSH fleet safely: inspect hosts, compare environments, request approvals, pull cloud materials, and read receipts.
---

# Whale fleet operations

Use this skill when the user asks about multiple DSH hosts, environment drift, cross-host
dispatch, remote receipts, cloud-drive materials, or whether two machines match.

## Safe order

1. `whale_list_hosts` — identify hostId, drift state, staleness and trust.
2. `whale_environment_diff` — compare one host against the expected environment.
3. `whale_environment_plan` — read the non-executable alignment plan.
4. `whale_host_trust` — check whether a remote manifest is actually verified.
5. `whale_request_dispatch` or `whale_request_alignment` — create a pending request.
6. A human approves in the Whale panel; never claim approval on your own.
7. `whale_receipt` — read the execution receipt and hashes.

## Cloud materials

- `whale_connectors` lists configured providers.
- `whale_cloud_list` browses or searches one provider.
- `whale_cloud_pull` copies one file into the host's private imports directory and
  returns sha256. It needs the `request` scope and does not upload or delete.

## Notifications

- `whale_notifications` shows adapters and recent receipts.
- `whale_notify_test` sends a synthetic test; it needs the `request` scope.
- A `send-result-unknown` outcome must not be retried automatically.

## Rules

- Never print tokens, private keys, source tokens, webhook URLs, or file contents.
- Treat stale, unsigned, untrusted, or key-mismatched hosts as `unknown`, never as match.
- Prefer `manual` trust; `tofu` only in a controlled network.
- A local scorer, exit code, signature check, or dry run is not an official business result.
- Destructive actions (clean, upload, delete, credential changes) stay manual in this version.
