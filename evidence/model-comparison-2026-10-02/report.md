# Stronger model comparison

**Version:** 1.0\
**Measured:** 2026-10-02, Europe/Belgrade\
**Maintained by:** Codex\
**Scope:** Local application model switch and one paid synthetic English-to-German comparison. Translation observations below are an AI assessment, without human approval.

The translator now defaults to **`gpt-6-astra`, low reasoning**. It completed all eight inputs; `gpt-4.1-mini` completed six. Astra preserved protected decimal punctuation and resolved selected technical ambiguities better in this sample. It cost approximately **38.4 times more per attempt** and took approximately twice as long on the six pairs both models completed. This small comparison does not establish general model superiority or satisfy AC1.

## Results

| Measure                                             | `gpt-4.1-mini` | `gpt-6-astra`, low |
| --------------------------------------------------- | -------------: | -----------------: |
| Attempted documents                                 | 8              | 8                  |
| Successful downloads                                | 6              | 8                  |
| Failed documents                                    | 2              | 0                  |
| Known cost, including failed work                   | $0.009948      | $0.381990          |
| Mean known cost per attempt                         | $0.0012435     | $0.04774875        |
| Successful wall-time p50, nearest rank              | 7.094 s, n=6   | 15.019 s, n=8      |
| Successful wall-time p95, nearest rank              | 8.455 s, n=6   | 18.271 s, n=8      |
| Mean time on the six common successful pairs        | 7.426 s        | 15.928 s           |
| Completed paid calls, agent turns included          | 24             | 30                 |
| Input / output tokens                               | 12,050 / 3,205 | 17,834 / 4,073     |
| Cached input / cache-write tokens                   | 0 / 0          | 0 / 0              |
| Reasoning tokens, already included in output        | 0              | 134                |
| Published numeric occurrences preserved             | 16/16          | 24/24              |
| Published accepted blocks covered                   | 60/60          | 80/80              |
| Unknown exposure / active reservation at completion | $0 / $0        | $0 / $0            |

Total known spend was **$0.391938**, below the $5 comparison accounting cap. Costs are calculated from returned usage at versioned prices, rather than reconciled against a provider invoice. Successful files passed the existing publication guards; the numeric and coverage figures describe those enforced outcomes.

| Paired input       | Mini result · time · known cost       | Astra result · time · known cost |
| ------------------ | ------------------------------------- | -------------------------------- |
| Battery — Markdown | Succeeded · 8.455 s · $0.0011880      | Succeeded · 13.013 s · $0.043580 |
| Battery — PDF      | Succeeded · 7.858 s · $0.0011488      | Succeeded · 18.271 s · $0.063000 |
| Seal — Markdown    | Succeeded · 8.166 s · $0.0013884      | Succeeded · 15.019 s · $0.047200 |
| Seal — PDF         | Succeeded · 7.094 s · $0.0012064      | Succeeded · 15.734 s · $0.047940 |
| Ground — Markdown  | Succeeded · 6.898 s · $0.0012772      | Succeeded · 17.301 s · $0.054460 |
| Ground — PDF       | Succeeded · 6.085 s · $0.0010232      | Succeeded · 16.229 s · $0.047780 |
| Cell — Markdown    | Invalid output · 6.391 s · $0.0012996 | Succeeded · 12.983 s · $0.038170 |
| Cell — PDF         | Invalid output · 7.603 s · $0.0014164 | Succeeded · 13.948 s · $0.039860 |

## Translation observations and remaining quality gate

Both mini cell outputs changed `4.2` to `4,2`. This is a German locale punctuation convention, but it violates this application's byte-exact numeric policy. The validator retained the completed paid checkpoints and cost, returned `INVALID_MODEL_OUTPUT`, and published no artifact. Astra preserved `4.2` in both formats. No failed or uncertain call was retried.

Inspection of the saved source/translation pairs gives these provisional semantic observations:

| Source meaning                                  | Mini output                                  | Astra output                  | AI assessment                                                                             |
| ----------------------------------------------- | -------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| PDF seal is a tamper-evident security label     | `Dichtung`, a gasket/seal                    | `Sicherheitssiegel`           | Astra respects the later label definition; mini's Markdown `Siegel` was also appropriate. |
| Electrical lead is a cable, not the metal lead  | Markdown `Metallleitung`; PDF `Metallleiter` | `Metall Blei` in both formats | Astra preserves the explicit distinction between the cable and metal.                     |
| Ground Markdown remains isolated during service | `während des Betriebs`                       | `während der Wartung`         | Astra preserves the maintenance context more closely.                                     |

The predeclared automated lexeme diagnostic **does not establish a quality improvement**: on the six common successful pairs, mini scored 57/92 (62.0%) and Astra 54/92 (58.7%). Across each model's published files, the scores were 57/92 and 83/136 respectively, with different denominators. The fixed list misses valid compounds such as `Sicherheitssiegel`, `Siegeletikett`, `Elektromotor` and `Anschlusskontakt`; some hits also depend on inflection or per-block wording. The references were not expanded after seeing outputs, and no retrospective passing score is claimed.

**AC1 remains UNMET.** Required next evidence is a held-out corpus with at least 40 human-approved terminology references meeting the ≥95% target, independent semantic review and the defined web/MCP format coverage. This run supplies eight new synthetic inputs through the web/API core. It does not add a live Astra MCP assessment, human acceptance, layout/OCR validation or captured authenticated Claude use. Existing fake MCP tests pass. The earlier user PDFs, format caps and conservative preflight policy were preserved.

## Method, pricing and controls

Four fresh synthetic topics were encoded as PDF and Markdown. Each exact input byte sequence was reused for the two models; hashes are in [manifest.json](manifest.json). Every attempt used a separate owner, preventing local result-memory reuse. Calls were sequential, mini first and Astra second, with the same prompts, visibility policy, source blocks, tool bounds and output limits. Provider prefix caching was enabled but reported no reads or writes in this run. Nonrandom order, provider variability, four related topics and a single run limit generalisation; the p95 values are nearest-rank descriptions of six/eight successes.

The official [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra) supplies standard per-million-token prices: $10 input, $1 cached input, $12.50 cache write and $50 output. The [mini reference](https://developers.openai.com/api/docs/models/gpt-4.1-mini) profile is $0.40/$0.10/$0.40/$1.60. Rates, reasoning and cache settings are explicit profiles; unknown model names fail locally. Current per-call bounds stay below the long-context surcharge threshold.

Astra uses low reasoning and `prompt_cache_options.ttl="30m"`, following the [migration guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart). Saved agent response metadata confirms the actual model, low effort and 30-minute cache option. Accounting includes reasoning within total output and prices actual reads/writes separately. Reservations use the higher input/cache-write price; a one-chunk Astra quote reserved at most $2.150001 in this run, while actual document costs ranged from $0.03817 to $0.06300.

Quotes bind model, effort and rates. The live mini quote rejected after the switch with `QUOTE_STALE` and zero calls. A fake integration test changed settings after approval and produced `MODEL_CONFIGURATION_CHANGED` before any call. Each paid comparison receipt matched status, and completed-call costs matched an independent calculation at that model's rates. Before each sequential approval, the harness checked prior known cost, unresolved exposure, active reservations and the next job's entire reservation against $5.

## Verification, evidence and delivery state

All 14 combined fake-provider stages passed, with 18 unit tests/1,029 assertions and nine Playwright tests. This includes the ten-case process/container kill matrix, two additional submitted-call infrastructure kills, parser isolation/SIGKILL, lease renewal, fairness, cancellation, MCP and zero-call rerender. The test stack returned to stopped. The normal five-service stack remains running on Astra/low; its UI displayed the model and canceled a prepared quote with zero cost and no page errors.

The original runner used one block-evidence filename per topic, allowing PDF records to replace Markdown records. All downloaded documents, per-attempt scores, calls, costs and database checkpoints were retained. A read-only post-analysis recovered 16 separate format-specific records and verified their input hashes, literal checks and all 14 downloaded artifact checksums. The original ambiguous filenames are superseded by the explicit records in [analysis.json](analysis.json). The current runner includes the format in filenames. Its executed version is retained as [runner-source.ts](runner-source.ts), matching the original execution manifest. No extra provider calls were made for this repair.

- [Comparison rows, usage, prices, quotes and control](comparison.json)
- [Checkpoint analysis, failure details, actual model settings and separate record paths](analysis.json)
- [Predeclared AI reference lexemes](references.json)
- [Input hashes](manifest.json) and [executed source fingerprints](source-manifest.json)
- [Live browser proof](ui-smoke.json) and [displayed quote](stronger-quote.png)
- [Full regression gate](../verification.json), [approval guards](../contracts.json), [browser suite](../e2e.json) and [kill matrix](../chaos.json)

The comparison and `final-state.json` were captured before publication, when these changes were local and uncommitted. That metadata remains historical evidence. Current publication and CI status are described in the repository README and the pushed commit's checks; the baseline real-provider fresh-clone evidence applies only to its recorded commit. No new live clone proof, Cursor validation, Python or delegated implementation was used for this comparison.
