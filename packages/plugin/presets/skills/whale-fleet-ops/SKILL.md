---
name: whale-fleet-ops
description: Operate a Whale multi-host DSH fleet safely: read status, inspect hosts, compare environments, request approvals, sync host bundles, install presets, snapshot configuration, pull cloud materials, and read receipts.
---

# Whale fleet operations

Use this skill when the user asks about multiple DSH hosts, environment drift, cross-host
dispatch, remote receipts, host onboarding, presets, configuration backup, cloud-drive
materials, notifications, or whether two machines really match.

## Start here

1. `whale_status` — one call for hosts, drift, trust, pending approvals, connectors,
   notifications, presets, backups and alignment. Read this before anything else.
2. `whale_doctor` — version, MCP, execution and plugin compatibility checks.

## Hosts and environment

1. `whale_list_hosts` — hostId, drift state, staleness and trust.
2. `whale_host_manifest` — raw manifest of one host.
3. `whale_environment_diff` — compare one host against the expected environment.
4. `whale_environment_plan` — read the non-executable alignment plan.
5. `whale_host_trust` — check whether a remote manifest is actually verified.
6. `whale_receipt` — read the execution receipt and hashes.

## Onboarding another machine

- `whale_host_bundle` exports one host's manifest, public trust entry and expectation.
- `whale_import_bundle` imports it after digest, signature and key-binding checks.
- Never hand-edit a bundle; never import one whose hostId is not `sha256:<64 hex>`.

## Alignment (human approved)

1. `whale_alignment_plan` — read `planDigest` and non-executable steps.
2. `whale_request_alignment` — create a pending request binding `planDigest`.
3. `whale_alignment` — read current alignment state and result.
4. `whale_approve_alignment` — only with the `approve` scope after a human decision;
   the executor re-collects and reports rollback on failure.
5. `whale_request_dispatch` — request a cross-host task; it stays pending until a
   human approves it in the Whale panel.

## Presets and backup

- `whale_presets` — Skill, config and popular-plugin presets; installed skills are
  digest-verified and never silently overwritten.
- `whale_backups` — snapshot, verify and (explicitly) restore profile configuration;
  private keys and credentials are excluded.

## Cloud materials

- `whale_connectors` lists configured providers.
- `whale_cloud_list` browses or searches one provider.
- `whale_cloud_pull` copies one file into the host's private imports directory and
  returns sha256; it needs `request` scope and does not delete.
- `whale_cloud_upload` exports one file from an allowed upload root; it needs
  `approve` scope and overwrites only with an explicit `overwrite: true`.

## Notifications

- `whale_notifications` shows adapters and recent receipts.
- `whale_notify_test` sends a synthetic test; it needs `request` scope.
- A `send-result-unknown` outcome must not be retried automatically.

## Rules

- Never claim approval, and never self-approve: `approve` scope belongs to a human
  operator acting in the Whale panel or an explicitly trusted automation.
- Never print tokens, private keys, source tokens, webhook URLs, or file contents.
- Treat stale, unsigned, untrusted, or key-mismatched hosts as `unknown`, never as match.
- Prefer `manual` trust; `tofu` only in a controlled network.
- A local scorer, exit code, signature check, or dry run is not an official business result.
- Destructive actions (clean, overwrite upload, delete, credential changes) stay manual
  in this version; report the exact tool, target and receipt instead of doing them silently.
