# #29 Walkthrough — offline-first field inspection PWA — Claude Code kickoff

## Session prompt — Phase 0 + Phase 1

Kit location: until Phase 0 runs, this file, PRD.md and DECISIONS.md live on branch `kit` in `docs/`. Phase 0 creates `main` from the foundation tag, copies them into `docs/walkthrough/`, pushes `main`, and sets it as the default branch (`gh repo edit shanelabountyai/walkthrough --default-branch main`). Never delete `kit`. Remove the billing module per the foundation README unless DECISIONS.md says otherwise. You cannot push to saas-foundation: put the CLONES.md row you'd add in the PR body under "For Shane".

```text
You are building Walkthrough (build-log #29) on saas-foundation v1.6.2 (clone with shared history, never "Use
this template"; quickstart with name walkthrough, port 8200). Read docs/walkthrough/PRD.md and DECISIONS.md.
Decisions are in force; new ones: pick, append a row, keep going, never ask.

Phase 0 on main: foundation clone, new-project, gate = foundation CI green. Phase 1 on branch kickoff (PR #1
unmerged), pure sync engine only: write docs/walkthrough/PHASE1_PLAN.md first; then src/lib/sync/ (op types,
Lamport clocks, merge, conflict detection, template-version pinning) with fast-check property tests for WT-01,
WT-02, WT-03 (thousands of random interleavings, seeded). Gate: all property tests green at a fixed seed and at
3 random seeds, run counts reported in the PR body. Then stop.
```
