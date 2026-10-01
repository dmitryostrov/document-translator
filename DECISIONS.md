# Document Translator Decisions

Local implementation and runtime testing are substantially complete. Private GitHub delivery, CI and fresh-clone verification are being completed under the user's latest authorization. Human reference approval and authenticated Claude Code translation remain separate gates. Cursor validation was excluded.

The selected stack is Bun/TypeScript, Hono, PostgreSQL and Redis/BullMQ. PostgreSQL owns accepted work, leases, generations, approval, provider accounting and immutable artifact versions. BullMQ supplies delivery notifications. One reconciler repairs missed delivery; there is no outbox or dispatcher lease.

The official TypeScript `@openai/agents` SDK is used under the user's no-Python constraint. The assessment's literal Python package name remains an evaluator-acceptance question.

Working branding is provisionally Stark Future, following the user's candidate website. Employer authorship is unconfirmed.

## Measured evidence

| Measurement                             | Result                                                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final cold completion                   | 20/20, zero failures                                                                                                                                              |
| Real-provider p50 / p95                 | 7.499 s / 13.952 s, N=20                                                                                                                                          |
| Mean known cost / document              | $0.0013247, including every agent/direct turn                                                                                                                     |
| Concurrency 1                           | N=10, p50 7.592 s, p95 13.776 s, mean $0.0013588                                                                                                                  |
| Concurrency 4                           | N=10, p50 7.221 s, p95 14.288 s, mean $0.0012906; no latency improvement claimed                                                                                  |
| Cold usage                              | 33,055 input / 8,295 output tokens; cached input 0, cache-write 0                                                                                                 |
| Provider prefix-cache discount          | $0 observed; no caching benefit assumed                                                                                                                           |
| Separate identical-request prefix probe | First: 1,774 input / 0 cached tokens, $0.0040984 total. Three repeats: 1,536 cached tokens each, mean $0.003612 total; exact input discount $0.0004608 per repeat |
| Warm same-owner repeat                  | N=1, 6.386 s, $0.0010568, three calls; glossary variation prevented a result-memory hit                                                                           |
| Candidate terminology                   | 256/261 (98.08%), AI-curated references; human approval pending                                                                                                   |
| Protected numeric occurrences           | 161/161 (100%) in the ten sequential cold documents                                                                                                               |
| Weak pair probe                         | One successful English→French sample; insufficient quality evidence                                                                                               |
| Worker SIGKILL                          | Seven boundaries, resume/attention 2.375–32.330 s, no duplicated fixture invocation                                                                               |
| API / Redis / PostgreSQL SIGKILL        | Accepted identity/checkpoints/artifact survived; ten total chaos cases                                                                                            |
| Retained completed/failed broker IDs    | New generation in ~2.27 s; active/no DB claim ~7.08 s                                                                                                             |
| Provider failure handling               | 500/timeout unknown without replay; paid invalid output retains cost; explicit 429 stops after three attempts                                                     |
| Fairness                                | 200-page PDF + two small owners; small paid admission 0.385 / 0.385 s, all complete, six ownership denials                                                        |
| Rerender                                | Zero provider calls; previous artifact preserved                                                                                                                  |
| Visible instruction attack fixtures     | Three real-provider fixtures, all validated; 0/3 numeric/coverage mutations observed; not a general injection guarantee                                           |

Measured 2026-09-30 UTC (2026-10-01 local), Windows Docker Desktop/Linux containers, Bun 1.4.2, model `gpt-4.1-mini`, prompt `translation-v2`, four model slots. The ten fixed synthetic English-to-German inputs (five PDF, five Markdown) were repeated with distinct owners at request concurrency one and four. PDFs are 1/4-page prose; Markdown has 2/16 technical paragraphs. These samples do not forecast 200-page manual latency.

Cold means no owner-local result-memory reuse; provider prefix caching is enabled. Wall time includes upload/preflight, approval/start request, queue/admission, all model turns, validation and publication; it excludes human think time. p95 uses nearest rank. Rates per million tokens: $0.40 input, $0.10 cached, $1.60 output; no separately charged writes reported. Usage accounting is not provider invoice reconciliation.

Evidence: [final measurements](evidence/live-measurements.json), [first run](evidence/live-measurements-initial.json), [quality](evidence/quality.json), [40 review examples](evidence/quality-review.md), [chaos](evidence/chaos.json), [regressions](evidence/regressions.json), [fairness](evidence/fairness.json), [live MCP](evidence/mcp-live.json), [agent/attack scenarios](evidence/live-scenarios.json), [prefix probe](evidence/prefix-probe.json), [lease/native-stall proof](evidence/lease-proof.json), [folder API kill](evidence/folder-chaos.json), [folder fairness](evidence/folder-fairness.json), [in-flight infrastructure kills](evidence/infrastructure-chaos.json).

The combined fake-provider run passed 12 suites. Six publication-focused checks and the added folder-fairness suite passed separately after their respective fixes. Folder fairness held two paid slots in one three-child folder and admitted another owner in 171 ms; all four jobs completed. No 13-suite combined rerun is claimed.

The separate prefix probe deliberately disables local result memory and sends four identical fixed requests through distinct accounted ledger identities, using a stable routing cache key. Three repeats each reported 1,536 cached tokens and no cache-write charge. Total output lengths varied slightly, so the exact input-price reduction is the clean comparison; the small latency difference is not a general speedup claim. These calls are excluded from the 20-document cold benchmark.

The first real corpus completed 12/20 cold samples; eight paid outputs failed because the model confused glossary evidence references with block selection. All paid checkpoints remain recorded. All-block instructions and count/ID schema constraints fixed the subsequent corpus.

The agent's controlled example used “The seal must be replaced after every inspection.” An isolated completion produced **Dichtung** (gasket). Retrieving the later definition of a tamper-evident adhesive security label produced **Siegel**. Both baseline and agent calls are accounted for. This demonstrates contextual value in one example, not a general benchmark.

Quotes show the matching observed synthetic cost/time range when model, prompt, pair and size match, otherwise a conservative reservation bound and unavailable ETA. The corpus is too small to calibrate production throughput, other languages or cache performance.

## Deliberate format limits

PDF output reflows prose/bullets with a Unicode font. OCR, scanned PDFs, complex tables/columns and pixel-perfect image reconstruction are excluded. Ambiguous visibility rejects before provider calls; proven hidden text is excluded with warnings. Mixed images require explicit text-only scope acknowledgment. Marker screening is a local policy, not confidentiality clearance.

Downloads replace an unsafe rich preview. Markdown code/destination targets stay in its AST. Model/result memory is owner/model/prompt/policy/glossary/context scoped; varying glossaries reduce hits. Exact repeated margin text uses ordered aliases; body repetition is retained.

Redis adds a service and DB/broker coordination burden. The small concurrency comparison does not establish a performance win attributable to BullMQ. A conservative call ledger trades automatic retries for actionable uncertainty: submitted calls may be charged even after cancellation, 500, timeout or process death.

Production authentication/TLS, quotas, retention/GC, cloud storage, invoice reconciliation, metrics/alerts and backup drills remain operations work. Runtime schema creation is idempotent but lacks a production migration/version lifecycle. Glyph-remapping needs the deferred render/OCR comparison.

Human approval and an independent held-out terminology/semantic evaluation are pending; the current score is provisional. Real SDK MCP clients translated both formats without UI. Clean isolated Claude Code 2.1.286 connected successfully but has no authenticated account. The earlier fresh explicit source copy built and translated through OpenAI using Docker alone, without copied dependencies/key; its historical evidence remains explicitly distinct from the new genuine Git-clone test. Commit/private-push authorization is now provided; verification is in progress. No Cursor assessment is claimed.

Seven conventional Playwright E2E tests passed after replacing the standalone smoke script, including actual downloads/checksums, preserved Markdown literals, receipts, named input errors, cancellation before approval and layout/keyboard checks. Standalone E2E and full verification preserve the prior test-service state. Healthcheck frequency and adaptive browser polling remain separate unresolved efficiency work.

## Three more weeks

Deliberate approved model escalation, an OpenAI Batch economy adapter with charged partial/expired result reconciliation, and native OCR/font-remapping comparison. Also measure layout fidelity, add human glossary review, production authentication/storage/retention. No Python fallback. A paid injection classifier is excluded.
