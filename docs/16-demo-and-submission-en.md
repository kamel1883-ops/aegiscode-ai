# AegisCode AI — demo and submission guide (English)

All UI text, reports, diagrams, and repository documentation are in English.
No live model call is needed for any step below unless explicitly marked LIVE.

## 1. One-command startup

From the repository root:

```bash
AEGISCODE_API_TOKENS="dev-token-1234" node server/bin/aegiscode-server.js --port 8080
# UI:   http://127.0.0.1:8080/
# API:  http://127.0.0.1:8080/api/health   (authenticated)
```

Or with Docker:

```bash
AEGISCODE_API_TOKENS="token1,token2" docker compose up -d
```

Copy `.env.example` to `.env` (git-ignored) for local convenience — it contains
placeholders only. The server refuses to start without access tokens.

## 2. Local readiness check (no spend, no model calls)

```bash
AEGISCODE_API_TOKEN="<your-token>" node server/bin/aegiscode-readiness.js --base http://127.0.0.1:8080
```

Exit 0 prints `READINESS: READY` and confirms: server liveness, token
acceptance, and a demo-safe Meta state (`mock` or `live_disabled`,
`powered_by_meta=false`, remaining budget $10.00). Any `live_*` configured
state fails the check — live demos need separate explicit approval.

## 3. Repeatable demo reset (spending history is NEVER reset)

```bash
# Stop the server first, then:
node server/bin/aegiscode-demo-reset.js --data ./data --confirm
```

Clears jobs and advisory cycles. Preserves the budget ledger
(`meta-budget.json`), accounts, the live-verified flag, and the append-only
audit log — the reset itself is recorded there as `demo.reset`.

## 4. The two reproducible scenarios (both covered by tests)

Both use the intentionally vulnerable `demo-template-fetch` application we own
(`core/fixtures/original/app.js`: fetches a template from an external resource
without validation).

### Scenario 1 — a genuine patch (verdict supported by the tests)

- Submit: original → `core/fixtures/patch-real/app.js`.
- Expected harness verdict: **`patch_supported`** — the failure mode did not
  recur, even with the resource available.
- Covered by `server/test/api.test.js` (full cycle: submit → decisive verdict →
  recorded human decision) and the advisory mock cycle in
  `server/test/meta.test.js`.

### Scenario 2 — environment masking exposed (the honest negative)

- Submit: original → `core/fixtures/patch-fake/app.js` (looks like a fix, changes nothing).
- Expected harness verdict: **`environment_masked`** — the success came from the
  environment, not from the patch. The conventional test declares a false
  success; the four-condition matrix catches it.
- Covered by `core/test/e2e.test.js` (`fake patch ⇒ environment_masked`).

Fallback case: `core/fixtures/hang/app.js` ⇒ timeout ⇒ **`inconclusive`** —
never recorded as a fix (covered by `core/test/phase1.test.js`).

### Replay fallback (only if the live service is unavailable)

If the Meta service is unreachable during a live demo, play a previously
recorded run and label it on screen and in speech as a **replay of a recorded
real run — not a live call**. Never present a replay as live.

## 4b. Recording shot list (no video is claimed to exist)

No walkthrough video has been recorded — the exact shots to capture:

1. Server start + readiness check passing in the terminal (`READINESS: READY`).
2. Login, “Load demo”, submit job, verdict banner `Patch supported`.
3. Advisory panel: `MOCK` (or `LIVE`) badge, exact model id, explanation text.
4. Candidate patch diff block, clearly labelled untrusted / never applied.
5. Harness verdict on the candidate (`environment_masked` for the mock
   placeholder) with the four-condition matrix visible.
6. Usage & cost panel: per-call tokens, `$0.00`, remaining `$10.00`.
7. Human Approve/Reject buttons + recorded decision with name and reason.
8. Closing frame: limitations + access note, verbatim from the UI.

Existing stills: `artifacts/ui-mock.png`, `artifacts/ui-live-disabled.png`.

## 4c. One concrete next step for the interactive demo (post-validation)

GitHub Actions proves the integration but leaves no persistent interactive
website. The cheapest interactive path: run the existing server on your own
machine with the key in a local git-ignored `.env` (`META_MODE=live`), where
`data/meta-budget.json` gives truly durable accounting across restarts — no
new hosting, no new code. Cost: one advisory cycle ≤ $0.05 against the
approved $10; hosting $0. Recommended only AFTER the $0.05 smoke test passes.

## 5. Demo recording plan — 3:00 max (our editorial plan, not organizer wording)

Confirmed by the organizers: a 3-minute demo video, judges score from what
the team built during the event. Production target: **no longer than 3:00**.
What the slide does NOT specify — file format, resolution, hosting platform,
or exact maximum-duration enforcement — must be verified in the actual CV
submission form before exporting.

**Pre-existing vs event-built (say this on camera at 0:00–0:15):** the causal
verification engine, job queue, accounts, audit log, report UI and diagrams
are pre-existing infrastructure. Built during this event: the Meta advisory
workflow, the central budget manager, the four integration states, the
advisory UI panel, the smoke workflow, and the ops tooling (§9 table).

### 5a. Exact click-through sequence

1. Terminal: start the server, run the readiness check → `READINESS: READY`.
2. Browser: log in → “Load demo” → submit job → wait for `Patch supported`.
3. Advisory panel: click “Explain & propose a candidate patch” → show the
   LIVE badge (only if validated live), exact model id, explanation text.
4. Scroll: candidate patch diff, labelled untrusted / never applied.
5. Click “Summarize the verification result” → harness verdict + evidence.
6. Second job (fake patch): verdict `environment_masked` + matrix close-up.
7. Usage & cost panel → exported Markdown report → human Approve/Reject with
   name + reason → recorded decision shown.
8. Closing frame: limitations + access note, verbatim.

Accelerated waiting periods (job runs) must be labelled on screen
(e.g. “waiting period shortened”).

### 5b. Final English narration script (read verbatim, ~2:55 at calm pace)

> 0:00 “Conventional tests can declare success while the flaw is still
> there. AegisCode asks a harder question: did the patch really fix the
> flaw — or did the environment merely mask it? The verification engine
> you see is our existing infrastructure. What we built this week is the
> Meta-powered advisory loop on top of it.”
>
> 0:15 “Here is our small app fetching a template without validation. The
> baseline run shows the vulnerability recurring when the resource is
> available — evidence, not an opinion.”
>
> 0:40 “With model muse-spark-1.3, the Meta Model API explains the finding
> and proposes a candidate patch. This is a genuine live response — the
> request id and token counts are on screen. The model is advisory only:
> untrusted code, never applied, never merged.”
>
> 1:20 “The same independent four-condition harness now tests the
> candidate. The model cannot touch the verdict, the assertions, or the
> sandbox policy. Result: patch_supported, with the full condition matrix
> as evidence.”
>
> 2:00 “The honest negatives. A fake patch that changes nothing gets
> environment_masked — the conventional test would have celebrated it.
> And a hanging run resolves to inconclusive, never to a fix. Both are
> real, reproducible outcomes.”
>
> 2:30 “The exported report, the usage ledger, and the cost: every token
> accounted, this cycle reserved at most five cents against a ten-dollar
> approved budget. The Meta integration contributes the explanation and
> the draft — verification stays independent.”
>
> 2:50 “Demonstrated: advisory generation plus independent proof. Key
> limitation: one workflow, one model, and live access required confirmed
> credentials — mock mode otherwise.”

**Contingency (mandatory):** the 0:40–1:20 segment requires a validated
live run. If validation has not succeeded by recording time, record that
segment as a **labelled replay of the recorded real run** (on-screen text
+ spoken label), or record after validation succeeds. Never label mock
output as live. Never show secrets, account details, or raw keys on screen
— blur the terminal/browser chrome outside the app if needed.

### 5c. Shot list and recording instructions

Shots (match §5a steps 1–8): (1) terminal readiness PASS; (2) verdict
banner; (3) advisory LIVE badge + model id + explanation; (4) candidate
diff; (5) harness verdict + evidence; (6) `environment_masked` matrix;
(7) usage & cost → exported report → recorded human decision;
(8) limitations frame. Existing stills: `artifacts/ui-mock.png`,
`artifacts/ui-live-disabled.png`.

Instructions: 1080p screen capture of the app only (no account pages);
English narration read from §5b; system audio off; export per the CV form’s
format/resolution once verified; keep the master under 3:00 — cut from
the 2:00–2:30 alternative-cases segment first, never from limitations.
My tools cannot record video: no video file is claimed to exist.

## 6. What the Meta integration is — and is not

- IS: one end-to-end advisory workflow (explain → candidate patch → independent
  harness test → summary), plus a persistent central budget manager and
  four explicit states (`mock` / `live_disabled` / `live_configured` /
  `live_verified`).
- IS NOT: autonomous merging, deployment, command execution, verdict control,
  background polling, model switching, or extra models — none exist in this
  repository. No image, audio, or segmentation features were added.

## 7. Known limitations and safety boundaries

- Live access verified 2026-10-27: the stored key authenticates
  (`muse-spark-1.3`, playground reply `SMOKE_OK`, no payment method required).
  API response-shape diagnosis pending; project spend so far: $0.00.
- `live_disabled` refuses and never substitutes mock output for a live result.
- A key alone never marks the integration "connected" or "working".
- The $0.05 per-cycle reservation is a conservative application-side ceiling,
  not a guaranteed provider billing cap; costs stay *estimated* until
  provider billing confirms them.
- Whether free-credit terms change the standard-mode data-use assurance is
  unresolved in Meta's public documentation and flagged as needing
  confirmation — the project claims neither outcome.
- Full-workflow live validation is capped at $0.50 within the $10 budget.

## 8. Submission checklist (confirmed requirements + verifications)

Confirmed from the organizers' kickoff slide: submit on the CV platform with
every teammate · demo video of 3 minutes · judges score only what the team
built during the event · public GitHub repository, checked in a logged-out
browser · deadline **November 4, 9:00 PM ET** (01:00 UTC Nov 5).

- [ ] Demo video ≤ 3:00, English, follows the §5b script; file format /
      resolution / hosting verified in the actual CV form (the slide does
      not specify them).
- [ ] Repository link, with this guide and the README as the entry points.
- [ ] Architecture diagram (`assets/fig4-architecture.svg`) is current.
- [ ] Setup instructions verified: all §1–§4c paths exist (checked 2026-10-26);
      full clean-checkout run pending the approved push.
- [ ] Meta's contribution is described exactly as in section 6 (no inflated claims).
- [ ] Limitations in section 7 are disclosed, not hidden.
- [ ] Meta's contribution is exactly as in section 6 — pre-existing
      infrastructure is NOT presented as newly built (§9 table + on-camera
      statement at 0:00–0:15 of the script).
- [ ] No secrets, tokens, keys, or private data are committed (see `.gitignore`;
      `git ls-files | grep -iE '\.env|pem$|secret'` returns nothing).
- [ ] Secret scan clean (checked 2026-10-26): no secret filenames tracked, no
      key material in tracked or new files (sole pattern match is a test
      asserting an ephemeral in-memory key header — no real key), `data/`
      ignored, `.env` family git-ignored with `.env.example` placeholders
      only. Test-fixture username `kamel` and LICENSE attribution are not
      secrets.
- [ ] Repository public AND reviewed logged-out (request visibility change
      separately — never automatic). Blockers: hackathon work unpushed (push
      pending approval); teammate list for the CV form still needed.
- [ ] No commit, push, deployment, visibility change, or budget change was made
      without the owner's separate approval.

## 9. Pre-existing vs hackathon-added work (fill in per event rules)

| Component | Status |
|---|---|
| `core/` causal engine (matrix, classifier, executor, isolation, evidence, reports) | Pre-existing |
| `server/` job queue, accounts, audit log, API | Pre-existing |
| `web/` UI shell, report rendering, diagrams | Pre-existing |
| `server/src/meta-pricing.js`, `meta-client.js`, `budget.js`, `advisory.js` | Added during hackathon |
| `server/test/meta.test.js`, `server/test/budget.test.js` | Added during hackathon |
| Meta advisory panel in `web/` (`#advisory-card`, states, usage & cost) | Added during hackathon |
| `.env.example`, readiness check, demo reset, this guide | Added during hackathon |
| Meta Model API live usage to date | None — zero live calls made |
