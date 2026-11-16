# Vendored companion bundle

`dsh-agent-team-room-0.7.0.tgz` is the prebuilt Room bundle installed by
`dsh-fusion-setup`.

- Upstream repository: `https://github.com/ishuowang/dsh-agent-team-room`
- Base release: `v0.6.0`
- Local compatibility source: `03ee4ef` plus release/version and Windows checks
- SHA-256: `1f72acb964fa0eafdb0d9b69b7872491dcd616f23e4dd2ddba9178633a899475`
- License: MIT, included in the tarball

The bundle widens the peer range to DSH `0.2.0-rc.2`, resolves the changed
native icon exports, feature-detects changed Session subagent helpers, and
includes the native Room conversation view.

`nanmicoder-dsh-agent-teams-0.1.30.tgz` is the AgentTeams host/client bundle
installed by `dsh-fusion-setup`.

- Upstream repository: `https://github.com/NanmiCoder/dsh-agent-teams`
- Published package: `@nanmicoder/dsh-agent-teams@0.1.30`
- SHA-256: `23c6f98947319e7d1c49c906d45bd83055679f98cece9308953d8f73dd6d67e3`
- License: MIT, included in the tarball

This is the unmodified official npm archive (published 2026-11-13). Its
release notes qualify Harness 0.2.2-rc.2; rc.3 remains a Fusion candidate
until the full combination is activated and verified on Instabox.
The previous 0.1.29 guard required retired legacy host-delivery methods.
Version 0.1.30 instead guards the native tree manager's delivery entry point,
covering queue, steer, browser messages and cold recovery. Incomplete tree
managers still fail closed. Cleanup restores only this plugin's own guard.

Companion regression (Node >=24.9.0, authorized test host only):

```sh
node --experimental-vm-modules --test packages/plugin/vendor/agent-teams-compat.contract.mjs
```

The regression executes the unmodified archive's compatibility and policy
modules, with host import doubles. It checks retired-member rejection through
all four delivery paths, cancellation, exact native receivers, HMR cleanup,
creation options, selected-branch teardown, and legacy hosts. It is not a
substitute for real Cordis/DSH startup or a paid model session. Set
`AGENT_TEAMS_TARBALL` to the old 0.1.29 archive and select the
`tree activation installs` test to reproduce the original guard failure.

`dsh-agent-bus-0.1.1-dsh02.tgz` is the patched AgentBus bundle installed by
`dsh-fusion-setup`.

- Upstream repository: `https://github.com/MistyBridge/dsh-agent-bus`
- Published base: `dsh-agent-bus@0.1.1`
- Patch: `patches/dsh-agent-bus@0.1.1.patch`; the vendored tarball additionally
  applies the DSH `>=0.2.0-rc.2 <0.3.0` peer range and
  `@deepseek-ai/dsh-home-paths` metadata
- SHA-256: `35c81edb7e67be48472fa705200874ff45f2baecdd45c3035b8dcdb99352bdf5`
- License: MIT, included in the tarball

`dsh-fusion-setup` reads the same version and SHA-256 from the package's
top-level `release.json`. A modified or missing bundle fails closed before the
target profile is changed.

AgentBus license provenance: the official npm manifest declares MIT, while the
published archive supplies no separate license/copyright text. The patched
archive now includes the declared MIT terms and a FUSION-NOTICE documenting
that provenance and the changes, without inventing upstream copyright.
