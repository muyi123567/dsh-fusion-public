# DSH AgentBus 0.1.1 compatibility patch

This patch is for DSH `0.2.0-rc.2` web profiles that use
`dsh-agent-bus@0.1.1`.

It changes one runtime import:

```diff
- @deepseek-ai/dsh-llm assertNever
+ @deepseek-ai/dsh-util-values assertNever
```

The package metadata also declares `@deepseek-ai/dsh-util-values` as an optional
peer. No AgentBus source is vendored into this repository and no ledger file is
modified.

## Apply

Back up the target profile first:

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\web"
$backup = "F:\AI\.dsh-fusion-e2e\agentbus-patch-backup-$(Get-Date -Format yyyyMMdd)"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $profile "package.json") -Destination $backup
Copy-Item -LiteralPath (Join-Path $profile "pnpm-workspace.yaml") -Destination $backup
Copy-Item -LiteralPath (Join-Path $profile "pnpm-lock.yaml") -Destination $backup
Copy-Item -LiteralPath (Join-Path $profile "patches") -Destination $backup -Recurse
if (Test-Path (Join-Path $profile "compatibility.json")) {
  Copy-Item -LiteralPath (Join-Path $profile "compatibility.json") -Destination $backup
}
```

Copy `dsh-agent-bus@0.1.1.patch` to `$profile\patches`, then add this to the
profile's `pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  dsh-agent-bus@0.1.1: patches/dsh-agent-bus@0.1.1.patch
```

Refresh the profile lockfile with a normal install, then verify the resolved
state with a frozen install:

```powershell
Set-Location $profile
pnpm install --offline --ignore-scripts
pnpm install --offline --frozen-lockfile --ignore-scripts
```

DSH still applies its independent peer-range compatibility gate. Grant the
exact tested pair explicitly:

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
dsh plugin --profile web allow-version dsh-agent-bus@0.1.1 `
  --dsh-version 0.2.0-rc.2 --accept-risk
```

## Verify

```powershell
Set-Location $profile
node --input-type=module -e "await import('dsh-agent-bus'); console.log('AGENT_BUS_IMPORT_OK')"
```

Start a disposable DSH web instance, authenticate, and confirm
`/plugins/dsh-agent-bus/state` returns HTTP 200 with a non-empty snapshot.

## Rollback

Revoke the exact-version exemption:

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
dsh plugin --profile web revoke-version dsh-agent-bus@0.1.1 `
  --dsh-version 0.2.0-rc.2
```

On this host `compatibility.json` did not exist before the exemption and was
created by `allow-version`. If the same is true in the target profile, remove
that file only when it contains no other entries. Otherwise restore the backed-up
copy.

Then restore the profile manifest files and patches directory:

```powershell
Set-Location $profile
Copy-Item -LiteralPath "$backup\package.json" -Destination $profile -Force
Copy-Item -LiteralPath "$backup\pnpm-workspace.yaml" -Destination $profile -Force
Copy-Item -LiteralPath "$backup\pnpm-lock.yaml" -Destination $profile -Force
Remove-Item -LiteralPath "$profile\patches\dsh-agent-bus@0.1.1.patch" -Force
if (Test-Path "$backup\compatibility.json") {
  Copy-Item -LiteralPath "$backup\compatibility.json" -Destination $profile -Force
}
pnpm install --offline --frozen-lockfile --ignore-scripts
```

This patch only establishes runtime compatibility. Complete AgentBus task,
review and restart persistence still require a live two-session acceptance run.

## DSH TeamRoom 0.6.0 compatibility patch

`dsh-agent-team-room@0.6.0.patch` updates TeamRoom for DSH `0.2.0-rc.2`:

- six removed 16px icon exports become their `*OutlineRegular` equivalents;
- the removed `ctx.subagents.followup()` call becomes
  `ctx.subagents.sendMessage(parent, childId, content, { signal })`;
- the package peer range targets DSH `0.2.0-rc.2`, so the plugin manager accepts
  the patched package without an exact-version risk exemption;
- changed Session catalog and subagent navigation APIs are feature-detected, so
  a materialized Session and the Attach panel no longer crash when those helpers
  are absent.

The patch targets the published `lib/client.js` and `lib/index.js` files. It does
not change room storage or write `rooms.json` directly.

Apply it to an isolated profile before adding TeamRoom to that profile's bundle
list. The widened peer range is part of the patch, so no separate
`allow-version` exemption is needed.

The local `roomprobe` profile was installed from a patched tarball. A disposable
DSH instance loaded the profile with no fatal loader error or skipped TeamRoom
bundle. `tests/room-live-smoke.mjs` proves real create, native state read, and
close with no browser errors. Attach/send/broadcast/remove still require a live
two-session acceptance run before the TeamRoom compatibility flag can be removed.
