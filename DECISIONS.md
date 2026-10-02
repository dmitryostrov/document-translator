# Document Translator Decisions

The baseline private GitHub delivery, CI and real-provider fresh-clone verification passed at their recorded commits. This revision includes later Spanish/upload work, five review fixes and the guarded Astra model comparison. Check the current commit's GitHub Actions result for its remote fake-provider verification; the older real-provider clone proof does not establish this revision's live delivery. AC1 is unmet; human held-out quality acceptance and captured/authenticated Claude Code use remain open. Cursor validation was excluded.

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
| Candidate terminology                   | 256/261 (98.08%); four AI-curated terms with loose substring counting on the prompt-development corpus; AC1 unmet                                                 |
| Protected numeric occurrences           | 161/161 among published sequential cold documents; validator-enforced gate, not independent model quality                                                         |
| Weak pair probe                         | One successful English→French sample; insufficient quality evidence                                                                                               |
| Worker SIGKILL                          | Latest fake run: seven boundaries, resume/attention 2.407–32.688 s, no duplicated fixture invocation                                                              |
| API / Redis / PostgreSQL SIGKILL        | Accepted identity/checkpoints/artifact survived; ten total chaos cases                                                                                            |
| Retained completed/failed broker IDs    | New generation in ~2.27 s; active/no DB claim ~7.08 s                                                                                                             |
| Provider failure handling               | 500/timeout unknown without replay; paid invalid output retains cost; explicit 429 stops after three attempts                                                     |
| Fairness                                | Latest token/chunk/admission counts are in fairness.json; 200 pages of short repeated synthetic prose, not a representative manual                                |
| Rerender                                | Zero provider calls; previous artifact preserved                                                                                                                  |
| Visible instruction attack fixtures     | Three published real-provider fixtures passed numeric/coverage gates; 0/3 published mutations is enforced, not an independent injection-resistance metric         |

Measured 2026-09-30 UTC (2026-10-01 local), Windows Docker Desktop/Linux containers, Bun 1.4.2, model `gpt-4.1-mini`, prompt `translation-v2`, four model slots. Ten fixed synthetic English-to-German inputs were repeated at concurrency one and four. They comprise four closely related template families: 1/4-page PDF and 2/16-paragraph Markdown with repeated battery/motor text. These are development fixtures, not a diverse corpus or a forecast for real manuals. The figures also predate the isolated parser and `visible-v3` policy.

Cold means no owner-local result-memory reuse; provider prefix caching is enabled. Wall time includes upload/preflight, approval/start request, queue/admission, all model turns, validation and publication; it excludes human think time. p95 uses nearest rank. Rates per million tokens: $0.40 input, $0.10 cached, $1.60 output; no separately charged writes reported. Usage accounting is not provider invoice reconciliation.

Evidence: [final measurements](evidence/live-measurements.json), [first run](evidence/live-measurements-initial.json), [quality](evidence/quality.json), [40 review examples](evidence/quality-review.md), [chaos](evidence/chaos.json), [regressions](evidence/regressions.json), [fairness](evidence/fairness.json), [live MCP](evidence/mcp-live.json), [agent/attack scenarios](evidence/live-scenarios.json), [prefix probe](evidence/prefix-probe.json), [lease/native-stall proof](evidence/lease-proof.json), [folder API kill](evidence/folder-chaos.json), [folder fairness](evidence/folder-fairness.json), [in-flight infrastructure kills](evidence/infrastructure-chaos.json).

The latest combined fake-provider run passed all 14 stages on 2026-10-02, including nine discoverable Playwright tests, 18 unit tests/1,029 assertions, ten review-remediation cases, model-approval guards, parser isolation/SIGKILL and folder fairness. Current token/chunk/admission counts are recorded in the linked fairness evidence; the 200-page fixture is short repeated synthetic prose. Six earlier publication-focused checks remain separately recorded. The combined gate makes no paid calls.

The separate prefix probe deliberately disables local result memory and sends four identical fixed requests through distinct accounted ledger identities, using a stable routing cache key. Three repeats each reported 1,536 cached tokens and no cache-write charge. Total output lengths varied slightly, so the exact input-price reduction is the clean comparison; the small latency difference is not a general speedup claim. These calls are excluded from the 20-document cold benchmark.

The first real corpus completed 12/20 cold samples; eight paid outputs failed because the model confused glossary evidence references with block selection. All paid checkpoints remain recorded. All-block instructions and count/ID schema constraints fixed the subsequent corpus.

The agent's controlled example used “The seal must be replaced after every inspection.” An isolated completion produced **Dichtung** (gasket). Retrieving the later definition of a tamper-evident adhesive security label produced **Siegel**. Both baseline and agent calls are accounted for. This demonstrates contextual value in one example, not a general benchmark.

Quotes use observed synthetic ranges only when model, prompt, policy, pair and size match. The earlier `visible-v2` calibration does not match the current `visible-v3` policy; new quotes show an unmeasured size-based token projection and no ETA. Its range uses exact source/previous-context token counts, 600–2400 prompt/glossary tokens per translation chunk, output at 0.9–1.6 times source tokens and 2–4 bounded terminology turns. These assumptions are exposed in the quote and UI. The conservative approval reservation is separate and includes bounded outputs/agent turns; projections are not guarantees and omit retry/cache variation.

## Deliberate format limits

The 25 MiB upload and 250-page limits were proposed in the plan as bounded MVP resource choices. The assessment sets no such thresholds; it asks us to handle huge/400-page inputs explicitly. These exact thresholds are not measured capacity ceilings. The byte cap limits upload/storage and parser exposure; page/word/chunk limits bound extraction and paid work separately, because file size is a poor proxy for translation cost. Increasing them requires measuring extraction memory/time, admission fairness and recovery on representative large documents. Model context size is handled by chunking.

All encrypted PDFs are rejected at preflight, even when they open without a password. Password input, permission handling and a consistent decrypted representation for Poppler/PDF.js were cut. This is a scope decision, not a limitation of OpenAI or Bun. A future implementation should distinguish open-password protection from empty-password encryption, avoid persisting passwords and define permitted extraction explicitly.

PDF output reflows prose/bullets with a Unicode font. OCR, scanned PDFs, complex tables/columns and pixel-perfect image reconstruction are excluded. Ambiguous visibility rejects before provider calls; proven hidden text is excluded with warnings. Mixed images require explicit text-only scope acknowledgment. Marker screening is a local policy, not confidentiality clearance.

Downloads replace an unsafe rich preview. Markdown code/destination targets stay in its AST. Model/result memory is owner/model/prompt/policy/glossary/context scoped; varying glossaries reduce hits. Exact repeated margin text uses ordered aliases; body repetition is retained.

Redis adds a service and DB/broker coordination burden. The small concurrency comparison does not establish a performance win attributable to BullMQ. A conservative call ledger trades automatic retries for actionable uncertainty: submitted calls may be charged even after cancellation, 500, timeout or process death.

Production authentication/TLS, quotas, retention/GC, cloud storage, invoice reconciliation, metrics/alerts and backup drills remain operations work. Runtime schema creation is idempotent but lacks a production migration/version lifecycle. Glyph-remapping needs the deferred render/OCR comparison.

AC1 is unmet: the current terminology score uses four AI-curated terms with loose substring counting on the prompt-tuning corpus. Forty development examples are ready for review, but they are not independent held-out references or human semantic approval. Real SDK MCP clients translated both formats without UI. The Claude Code record's `Connected` field is author-entered metadata without captured CLI output; it cannot close the clean-client connection or authenticated-use gate. The baseline private repository and genuine real-provider clone proof remain historical evidence at their exact commits; see [fresh-clone proof](evidence/fresh-clone-live.json). No Cursor assessment is claimed.

Nine conventional Playwright E2E tests pass, including actual downloads/checksums, preserved Markdown literals, receipts, Spanish target selection/accounting, named input errors, oversized browser/API rejection, cancellation before approval and layout/keyboard checks. Standalone E2E and full verification preserve the prior test-service state. Healthcheck frequency and adaptive browser polling remain separate unresolved efficiency work.

Two tiny synthetic real Spanish controls completed as PDF and Markdown, preserving 3/3 and 2/2 numeric occurrences. Known costs were $0.0006076 and $0.0009312; the pair still has insufficient quality evidence. An initial browser harness forgot to reselect Spanish after reload and produced a German Markdown control costing $0.0006992; its output/charge were preserved and the Spanish check was corrected. These controls are excluded from the twenty-document benchmark. Two user PDFs were rejected by the conservative visibility profile with no paid calls, exposing practical compatibility limits. A 45.75 MiB, 1,102-page encrypted input was rejected by size with no job or paid work. The upload test found Bun resetting oversized connections before an application error; browser prechecks and an application body bound now return the named 413 for tested fixed-length and chunked uploads.

## Parser and credential boundary

The current parser runs in a separate unprivileged, read-only-root container with dropped capabilities, no network and no OpenAI/database/editor credential access. It retains the shared document volume, so complete per-job filesystem isolation is still future work. A private Unix socket replaces direct worker-child parsing; unique staging files prevent orphan renders publishing into an artifact path. Native deadlines and fake lease hooks remain bounded. Missing key setup fails Compose by name; missing/empty runtime keys fail preflight before transport. Key failures after approval are rejected local calls rather than billed unknown exposure.

## Three more weeks

Deliberate approved model escalation, an OpenAI Batch economy adapter with charged partial/expired result reconciliation, and native OCR/font-remapping comparison. Also measure layout fidelity, add human glossary review, production authentication/storage/retention. No Python fallback. A paid injection classifier is excluded.

## Stronger default model — 2026-10-02

The user's model-comparison request selects `gpt-6-astra` at low reasoning as the new default, while retaining `gpt-4.1-mini` as an explicit cheaper profile. This changes the default for newly quoted work. Selective retry/escalation of previously failed units remains future work; completed or uncertain paid calls are never automatically repeated.

The official [migration guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart) requires reasoning rather than `none` and the current cache TTL setting. The Responses adapter and Agents SDK use the same low effort and 30-minute TTL. Prompts, visibility policy, tool limits, four-turn bound and 2,000-token agent output bound remain the same for the comparison. Responses use their existing bounded output setting.

The [official model prices](https://developers.openai.com/api/docs/models/gpt-6-astra) are registered separately from mini: $10 uncached input, $1 cached input, $12.50 cache write and $50 output per million tokens. Reservation pricing covers possible cache writes; actual accounting separates reads/writes and includes reasoning within total output. Quotes and every paid ledger admission bind model, reasoning and rate version. Model drift rejects stale approval or stops approved work before transport. Historical receipts retain their stored model and rates.

The [paired comparison](evidence/model-comparison-2026-10-02/report.md) completed eight Astra files and six mini files. Mini's two rejected outputs changed protected decimal punctuation from `4.2` to `4,2`; costs remain counted, and no retry occurred. Astra also handled selected contextual ambiguities better in AI inspection. Mean known cost per attempt rose from $0.0012435 to $0.04774875 (38.4 times); mean wall time on six common successes rose from 7.426 to 15.928 seconds. Total known spend was $0.391938 with zero unresolved exposure. The fixed diagnostic lexemes miss valid German compounds and do not show an established quality gain. Human AC1 approval remains required.
