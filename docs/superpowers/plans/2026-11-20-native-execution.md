# Native task execution implementation plan

> For agentic workers: use Superpowers subagent-driven development or executing-plans, preserving the shared worktree.

**Goal:** Bring the approved task-first design into the DSH native panel and connect an upstream task revision to an execution attempt, worker receipt and independent review.

**Architecture:** DSH owns task state. Fusion uses its existing fleet router and job workspace, persisting only attempt bindings and independent review records. The native panel acts through authenticated Fusion endpoints and never infers a review verdict from a worker exit.

**Tech Stack:** React, TypeScript, DSH bridge and host plugin, existing SSH/Instabox workers, Node crypto, Vitest.

**Spec:** `docs/design/2026-11-20-collaboration-control-plane.md`

## Global constraints

- Preserve DSH chat, container, theme, collections and extension lifecycle. Keep the quick tour available in the preview.
- Use an explicit operator-selected, configured job and worker, one workspace per attempt and no shared-workspace fencing claims.
- Re-read authoritative task identity and revision before a new dispatch. Persist identity before submitting and reconcile uncertain submissions by identity without automatic re-execution.
- Build receipts only from matching, complete worker observations, and validate independent signatures against configured reviewer public keys. Bind a review to the precise receipt and current task inputs.
- Keep production profiles and credentials outside development artifacts. Validate on an isolated runtime with existing authorized resources only.

## Tasks

- [x] Port the design to the native entry, including original-state display, evidence access and 420/560px and split views.
- [x] Extend supported workers to provide exact byte hashes and terminal metadata without replacing legacy evidence.
- [x] Persist attempt binding, reconcile the worker receipt and verify signed review. Exercise replay, mismatch, stale source, restart and failure behavior.
- [x] Wire guarded endpoints to the native task panel and verify the operator can follow execution and review in place.
- [x] Build and run applicable contracts, load the result in DSH and capture native UI and loopback worker evidence where available.

## Remaining dual-host gate

The completed slice is intentionally narrower than a real multi-machine acceptance. It has one authoritative DSH task,
one allowlisted job, one configured worker and a same-machine SSH loopback. The next gate requires an explicitly authorized
second Host B, a protected SSH key and known-host entry, a unique per-attempt workspace on B, profile-pinned material v2
expectations, an adapter-side bounded byte read from B, and an independent reviewer who can read those same bytes from B.
Until those inputs are authorized and captured, do not describe the current evidence as cross-host execution, production
readiness, or business correctness.
