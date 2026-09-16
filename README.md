# @pipeworx/herb-tcm

HERB 2.0's Traditional Chinese Medicine knowledge base — herbs, ingredients,
gene targets, diseases, PubMed-cited papers and GEO transcriptomic
experiments — proxied live from herb.ac.cn, with every relationship row
tagged an `evidence_tier` so a statistical prediction is never mistaken for
proof of efficacy.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `herb_search(keyword, category?)` — resolve a name to an id. Accepts
  Chinese characters, pinyin, English/Latin names, gene names/aliases,
  disease names, or a HERB id itself. `category` is one of `herb` /
  `ingredient` / `target` / `disease` (default `herb`).
- `herb_browse(category, page?, page_size?)` — page through the full
  herb/ingredient/target/disease list (7,263 / 49,258 / 12,933 / 28,212 rows
  respectively).
- `herb_detail(id, category, limit?, offset?, sections?)` — the full record
  for one id: composition, traditional-use summary, and every predicted or
  literature-backed target/disease relationship, each carrying its
  `evidence_tier`. Relationship tables are paged (fleet #1399 — an unpaged
  well-studied herb ran to 806 KB): each comes back as
  `{total, offset, limit, returned, truncated, rows}` where `total` is the
  TRUE upstream row count and `truncated: true` says more rows exist — so a
  25-row slice can never be mistaken for 25 rows existing. `limit` defaults
  to 25 (the pack's precedent, set by `herb_papers`), max 200; `offset` pages;
  `sections` (e.g. `["summary","herb_ingredient"]`) fetches composition
  without pulling thousands of predicted disease rows, and an unknown section
  name errors loudly rather than silently returning nothing. We chose
  client-side slicing over a `sections`-only design because `detail_api` has
  no server-side paging (one upstream call returns everything regardless), so
  the slice costs nothing extra and the envelope keeps the caller honest.
  `ingredient_alias` (a small synonym list) is never paged.
- `herb_papers(drug_type?, experiment_type?, sort_by?, limit?, offset?)` —
  list PubMed-cited references, each tagged `human_clinical` or `laboratory`.
- `herb_paper_detail(paper_id)` — one reference's bibliographic record plus
  the specific targets/diseases it reports.
- `herb_experiments(drug_type?, species?, experiment_type?, limit?, offset?)`
  — list GEO-deposited herb/ingredient-vs-control transcriptomic experiments.
- `herb_experiment_detail(experiment_id)` — differential-expression results
  for one experiment: top up/down genes, enriched GO/KEGG terms,
  connectivity-map hit counts. Always `evidence_tier: computational_prediction`.

### Evidence tiers

Every relationship row carries one of:

| Tier | Meaning |
|---|---|
| `traditional_use` | From the herb's Pharmacopoeia-style summary (Function/Indication/Meridians). Historical use, not a trial. |
| `human_clinical` | A PubMed-cited paper whose HERB-assigned "Experiment type" includes "Clinical Experiment" — it studied humans. |
| `laboratory` | A PubMed-cited paper studying cells or animals only. |
| `computational_prediction` | A statistical enrichment or database cross-reference with **no** clinical or experimental confirmation. This is a hypothesis, not evidence the herb/ingredient treats anything. |
| `compositional_fact` | "This ingredient occurs in this herb" — a composition fact, not an efficacy claim at all. |

`herb_target` / `herb_disease` (statistical enrichment, p-value + FDR_BH
columns), `ingredient_target` / `ingredient_disease` / `target_disease`
(curated cross-references with no clinical backing) and every
`herb_experiment_detail` row are `computational_prediction`.
`drug_paper_target` / `drug_paper_disease` (PubMed-cited) are split into
`human_clinical` or `laboratory` by resolving each cited paper's own
"Experiment type" — see Data sources below for how.

## Auth

Keyless. herb.ac.cn requires no account, token or payment — it is public
data served to anyone.

## Data sources

- `http://herb.ac.cn/chedi/api/` — herb.ac.cn is a umi single-page app with
  no REST surface (every path returns the same ~900-byte shell). The real API
  is this one POST endpoint, dispatching on a `func_name` body field, found
  in the site's own JS bundle (`http://herb.ac.cn/static/umi.js`). Seven
  verbs, confirmed live 2026-09-08: `search_api`, `detail_api`, `browse_api`,
  `paper_api`, `paper_detail_api`, `experiment_api`, `experiment_detail_api`.

Notes for the next person:

- **http only**, and Chinese-hosted — measured 200ms-1.5s per call from this
  session but expect latency and occasional unreachability; several `.cn`
  sources are known-flaky from our vantage. This is a known class, not a bug
  — report it rather than retrying hard.
- Every response is served as `text/html`, including successful ones — do
  **not** branch on `Content-Type`. The only reliable signal for "no such id"
  is the HTTP status: a bad `key_id`/`label`/`paper_key_id`/`drug_GSE_id`
  returns **HTTP 500** with an HTML "Internal Server Error" page; an unknown
  `func_name` returns HTTP 200 with the literal body `null`.
  `parseJson`/`httpError` from `@pipeworx/shared` handle both shapes.
- Cells in every table are either a plain value or `{link, title}` /
  `{style, title}` — even header cells in the differential-expression tables
  come this way (`{filterable, sortable, title}`). `tableToRows` in
  `src/index.ts` unwraps every shape to a plain string/number.
- `detail_api` needs **three** params, not just the id: `key_id`, `label`
  (must match the id's category — `HERB…` ids need `label: "Herb"`, etc.)
  and `v` (the site's own UI passes the id again under this name; omitting
  it was not tested and isn't worth risking).
- `drug_paper_target`/`drug_paper_disease` rows (inside `herb_detail`) carry
  a Paper id but not that paper's own experiment type, and a cited herb can
  reference 20-100+ papers. Rather than firing one `paper_detail_api` call
  per paper (impolite fan-out against a slow host), `herb_detail` makes ONE
  extra call to `paper_api` unfiltered — which returns HERB's entire
  ~2,000-row reference index including "Experiment type" per id — and
  resolves the tier from that in-memory lookup. Nothing from it is cached
  across tool calls; it is refetched live every time `herb_detail` needs it.
- `Ingredient_alias` (inside an ingredient's `detail_api` response) is **not**
  a table — it's a one-element array holding one semicolon-joined string of
  synonyms. Treating it as a table throws (`table[0].map is not a function`);
  split on `;` instead.
- `experiment_detail_api`'s `Experiment_detail` field nests everything one
  level deeper than expected: it's an object with exactly one key, named
  "HBEXP000001 Data Detail" (the experiment id plus a fixed suffix), whose
  value is `{ data: {...} }`. The differential-expression/GO/KEGG/CMAP
  tables live under that single value's `data` field — `src/index.ts` grabs
  it with `Object.values(...)[0]?.data` rather than building the key string,
  since the exact suffix isn't documented anywhere.
- `paper_api` and `experiment_api` have no server-side pagination — each call
  returns the FULL filtered list (~2,000 papers / ~1,000 experiments
  unfiltered) in one response. `herb_papers`/`herb_experiments` slice
  client-side with `limit`/`offset`; a tighter `drug_type`/`experiment_type`
  filter reduces what herb.ac.cn itself has to compute and send.
- **Licensing**: settled by Bruce, fleet #1389 (2026-09-08) — a live
  per-request proxy call is a client, not a publisher, so it needs no
  explicit reuse grant the way bulk-copying the dataset would. This pack
  must stay a proxy: no bulk download, no full local mirror, no cached
  complete copy of herb.ac.cn's data.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "herb-tcm": {
      "url": "https://gateway.pipeworx.io/herb-tcm/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/herb-tcm/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "herb-tcm": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-herb-tcm"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-herb-tcm
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Herb Tcm data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
