interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * HERB 2.0 (herb.ac.cn) — Traditional Chinese Medicine herb/ingredient/target/
 * disease knowledge base, proxied live per request.
 *
 * herb.ac.cn is a umi single-page app with no REST surface: every path
 * returns the same ~900-byte shell. The real API is one POST endpoint that
 * dispatches on a `func_name` body field (found in the site's own JS bundle),
 * confirmed live 2026-09-08 for all seven verbs it exposes:
 *   search_api, detail_api, browse_api, paper_api, paper_detail_api,
 *   experiment_api, experiment_detail_api.
 *
 * LICENSING (Bruce, fleet #1389, 2026-09-08 — settled, do not re-raise): a
 * live per-request upstream call on a caller's behalf is a client, not a
 * publisher, so it needs no explicit reuse grant the way bulk-copying a
 * dataset would. This pack MUST stay a proxy: no bulk download, no full local
 * mirror, no cached complete copy of herb.ac.cn's data. Each tool call makes
 * one (occasionally two, see herb_detail) live upstream request and returns
 * what comes back — nothing is stored between calls.
 *
 * hosting-claims-ok: this file never claims to host, mirror or cache
 * herb.ac.cn's data — every description below says the data COMES FROM HERB
 * and is fetched live.
 *
 * EVIDENCE TIERING — the point of this pack, not a nice-to-have. HERB mixes
 * genuinely different kinds of evidence in tables that all look alike (an id,
 * a name, maybe a p-value). Every relationship row this pack returns carries
 * an `evidence_tier`:
 *   - traditional_use          — from a Chinese Pharmacopoeia-style herb
 *                                 summary (Function/Indication/Meridians).
 *                                 Centuries of use, not a clinical trial.
 *   - human_clinical           — a PubMed-cited paper whose HERB-assigned
 *                                 "Experiment type" includes "Clinical
 *                                 Experiment" (i.e. it studied humans).
 *   - laboratory               — a PubMed-cited paper whose experiment type
 *                                 is cell-culture / animal-model only.
 *   - computational_prediction — a statistical or database-mined
 *                                 association (herb/ingredient x target/
 *                                 disease enrichment p-values, curated
 *                                 cross-references, differential-expression
 *                                 enrichment) with NO clinical or
 *                                 experimental confirmation behind it.
 *   - compositional_fact       — "this ingredient occurs in this herb". Not
 *                                 an efficacy claim at all.
 * An `evidence_tier` of `computational_prediction` is NOT evidence a herb or
 * ingredient treats anything — it is a hypothesis worth investigating, and
 * every tool description below says so.
 */


const UA = 'pipeworx-herb-tcm/1.0 (+https://pipeworx.io)';
const BASE_URL = 'http://herb.ac.cn/chedi/api/';
const UPSTREAM_NAME = 'HERB 2.0 (herb.ac.cn)';
// herb.ac.cn is http-only, Chinese-hosted, and slow — measured 3-8s per call
// even for a light query. Bounded well above DEFAULT_FETCH_TIMEOUT_MS (25s)
// so a genuinely slow-but-alive response isn't cut off, but still finite so a
// truly dead upstream fails fast and namably rather than holding the Worker.
const TIMEOUT_MS = 30_000;

async function chediCall<T>(func_name: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout(
    BASE_URL,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ func_name, ...params }),
    },
    UPSTREAM_NAME,
    TIMEOUT_MS,
  );
  if (!res.ok) throw await httpError(res, UPSTREAM_NAME);
  return parseJson<T>(res, UPSTREAM_NAME);
}

// ── Table shape helpers ─────────────────────────────────────────────
// Every HERB verb returns "tables": an array whose first element is a header
// row and whose remaining elements are data rows, positionally aligned to the
// header. Cells are sometimes a plain string/number and sometimes an object
// carrying a display link (`{link, title}` for a cross-reference, or
// `{style, title}` for italicized Latin names) — even the HEADER cells do
// this in the differential-expression tables (`{filterable, sortable,
// title}`). unwrapCell/headerLabel below normalize both shapes to plain
// strings so callers get clean JSON, not HERB's UI hints.
type Cell = string | number | boolean | null | { title?: unknown; [k: string]: unknown };
type Table = Cell[][];

function flattenTitle(title: unknown): string {
  if (Array.isArray(title)) return title.map(String).join(' ');
  return String(title);
}

function headerLabel(h: Cell): string {
  if (h && typeof h === 'object' && 'title' in h) return flattenTitle((h as { title: unknown }).title);
  return String(h);
}

function cellValue(c: unknown): unknown {
  // Most cells are `{link, title}` / `{style, title}`. A few — "Database
  // sources" on ingredient_target being the one hit live — are an ARRAY of
  // those link objects (an ingredient can cite more than one source db), so
  // unwrap element-wise rather than only handling the single-object shape.
  if (Array.isArray(c)) return c.map((el) => cellValue(el));
  if (c && typeof c === 'object' && 'title' in (c as Record<string, unknown>)) {
    return flattenTitle((c as { title: unknown }).title);
  }
  return c as Cell;
}

/** Turn a HERB table into `{ headers, rows }` with every cell unwrapped to a
 *  plain value and every row turned into a `header -> value` object. */
function tableToRows(table: Table | undefined): { headers: string[]; rows: Record<string, unknown>[] } {
  if (!table || table.length === 0) return { headers: [], rows: [] };
  const headers = table[0].map(headerLabel);
  const rows = table.slice(1).map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = i < row.length ? cellValue(row[i]) : null;
    });
    return obj;
  });
  return { headers, rows };
}

function withTier(rows: Record<string, unknown>[], tier: string): Record<string, unknown>[] {
  return rows.map((r) => ({ ...r, evidence_tier: tier }));
}

const CATEGORY_LABEL: Record<string, string> = {
  herb: 'Herb',
  ingredient: 'Ingredient',
  target: 'Target',
  disease: 'Disease',
};

// Every section herb_detail can return, across all four categories. Which of
// these a given record actually has depends on its category and its data;
// asking for a section the record lacks is fine (it is simply absent from the
// response, same as before `sections` existed).
const DETAIL_SECTIONS = [
  'summary',
  'herb_ingredient',
  'herb_target',
  'herb_disease',
  'ingredient_target',
  'ingredient_disease',
  'target_disease',
  'ingredient_alias',
  'drug_paper_target',
  'drug_paper_disease',
];

// ── PubMed-cited relationship tiering ───────────────────────────────
// drug_paper_target / drug_paper_disease rows (found in herb_detail and
// ingredient detail) carry a "Paper id" but not the paper's own experiment
// type, so they can't be tiered human_clinical vs laboratory in isolation.
// paper_api (unfiltered) returns HERB's ENTIRE reference index — ~2,000 rows,
// one live call, not stored — including "Experiment type" per Reference id.
// Fetching it once per detail call and building an in-memory lookup avoids
// firing one paper_detail_api request per cited paper (a single herb can cite
// 20-100+ papers), which would be impolite fan-out against a slow host for
// data this call already returns in one shot. Nothing from this lookup is
// cached across calls.
async function fetchPaperExperimentTypes(): Promise<Map<string, string>> {
  const data = await chediCall<{ paper_data?: Table }>('paper_api', {
    filter_drug_type: '',
    filter_experiment_type: '',
    sort_by: '',
  });
  const { rows } = tableToRows(data.paper_data);
  const map = new Map<string, string>();
  for (const r of rows) {
    const id = r['Reference id'];
    const type = r['Experiment type'];
    if (typeof id === 'string' && typeof type === 'string') map.set(id, type);
  }
  return map;
}

function tierFromExperimentType(experimentType: string | undefined): 'human_clinical' | 'laboratory' {
  return experimentType && experimentType.includes('Clinical Experiment') ? 'human_clinical' : 'laboratory';
}

/** Tier drug_paper_target / drug_paper_disease rows using the reference index. */
function tierPaperRows(
  rows: Record<string, unknown>[],
  experimentTypes: Map<string, string>,
): Record<string, unknown>[] {
  return rows.map((r) => {
    const paperId = r['Paper id'];
    const type = typeof paperId === 'string' ? experimentTypes.get(paperId) : undefined;
    return { ...r, experiment_type: type ?? 'unknown', evidence_tier: tierFromExperimentType(type) };
  });
}

const EVIDENCE_TIER_NOTE =
  'Every relationship row carries an evidence_tier. computational_prediction means a statistical or ' +
  'database-mined association with NO clinical or experimental confirmation — it is a hypothesis, not ' +
  'proof the herb/ingredient treats the condition. traditional_use reflects historical TCM practice, not a ' +
  'trial. Only human_clinical rows come from a paper that studied humans.';

const tools: McpToolExport['tools'] = [
  {
    name: 'herb_search',
    description:
      'Search HERB 2.0 for a herb, ingredient, gene target or disease by Chinese name, pinyin, English name, ' +
      'Latin name, gene alias or HERB id — e.g. "板蓝根", "banlangen", "Dyers Woad" and "BAN LAN GEN" all resolve ' +
      'the same herb record. Returns matching ids to pass to herb_detail. Does not itself carry evidence tiers ' +
      '(it is a name lookup, not a relationship).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: {
          type: 'string',
          description:
            'Search term: Chinese characters, pinyin, English/Latin name, gene name/alias, disease name, or a ' +
            'HERB id (e.g. HERB004520, HBIN016960).',
        },
        category: {
          type: 'string',
          enum: ['herb', 'ingredient', 'target', 'disease'],
          description: 'Which table to search. Defaults to "herb".',
        },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'herb_browse',
    description:
      "Page through HERB 2.0's full herb, ingredient, target or disease list (7,263 herbs / 49,258 ingredients / " +
      '12,933 targets / 28,212 diseases). Use herb_search instead when you already have a name to look up.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', enum: ['herb', 'ingredient', 'target', 'disease'], description: 'Table to browse.' },
        page: { type: 'number', description: '1-based page number. Defaults to 1.' },
        page_size: { type: 'number', description: 'Rows per page, max 100. Defaults to 20.' },
      },
      required: ['category'],
    },
  },
  {
    name: 'herb_detail',
    description:
      'Full record for one HERB id: herb (composition + traditional-use summary + predicted and literature ' +
      'target/disease links), ingredient (structure + predicted and literature target/disease links), target ' +
      '(curated disease associations + which herbs are statistically linked to it), or disease (which targets and ' +
      'herbs are statistically linked to it). ' +
      EVIDENCE_TIER_NOTE +
      ' A predicted herb-disease or herb-target edge (evidence_tier computational_prediction) is a screening ' +
      'hit from expression-overlap statistics, not proof of efficacy — never present it as "HERB shows herb X ' +
      'treats disease Y" without saying it is a prediction. Relationship tables are paged: each comes back as ' +
      '{total, offset, limit, returned, truncated, rows} with the TRUE upstream row count in `total` (a ' +
      'well-studied herb can have thousands of predicted disease rows — 25 are returned by default). ' +
      'truncated:true means more rows exist; page with offset, or narrow with `sections`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'HERB id, e.g. HERB004520 (herb), HBIN016960 (ingredient), HBTAR000001 (target), HBDIS000001 (disease).' },
        category: { type: 'string', enum: ['herb', 'ingredient', 'target', 'disease'], description: "Must match the id's prefix." },
        limit: {
          type: 'number',
          description:
            'Max rows returned per relationship table (herb_ingredient, herb_target, herb_disease, ' +
            'ingredient_target, ingredient_disease, target_disease, drug_paper_target, drug_paper_disease). ' +
            'Default 25, max 200. Each table always reports its true `total`.',
        },
        offset: { type: 'number', description: '0-based row offset applied to each relationship table. Default 0.' },
        sections: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'summary',
              'herb_ingredient',
              'herb_target',
              'herb_disease',
              'ingredient_target',
              'ingredient_disease',
              'target_disease',
              'ingredient_alias',
              'drug_paper_target',
              'drug_paper_disease',
            ],
          },
          description:
            'Return only these sections — e.g. ["summary","herb_ingredient"] for composition without pulling ' +
            'hundreds of predicted disease rows. Omit for all sections.',
        },
      },
      required: ['id', 'category'],
    },
  },
  {
    name: 'herb_papers',
    description:
      "List PubMed-cited papers in HERB's reference index — the literature backing herb/ingredient-target and " +
      '-disease associations. Each row is tagged evidence_tier human_clinical (its "Experiment type" includes ' +
      '"Clinical Experiment") or laboratory (cell/animal studies only). Filter by drug type or experiment type, ' +
      'or leave both blank to page through all ~2,000 references.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        drug_type: { type: 'string', enum: ['Herb', 'Ingredient'], description: 'Restrict to papers about herbs or about single ingredients.' },
        experiment_type: { type: 'string', description: 'Upstream free-text filter, e.g. "Clinical Experiment", "Animal Experiment", "Cell Experiment".' },
        sort_by: { type: 'string', description: 'Upstream sort field (optional; upstream default order is used if omitted).' },
        limit: { type: 'number', description: 'Max rows to return, default 25, max 100 (the full index is fetched upstream and sliced here).' },
        offset: { type: 'number', description: '0-based offset for paging past the first `limit` rows.' },
      },
    },
  },
  {
    name: 'herb_paper_detail',
    description:
      "One reference's bibliographic record (journal, PubMed id, experiment type, phenotype) plus the specific " +
      "targets/diseases that paper reports, tagged evidence_tier human_clinical or laboratory from the paper's " +
      'own experiment type. Use the Paper id from a drug_paper_target/drug_paper_disease row (herb_detail) or from ' +
      'herb_papers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paper_id: { type: 'string', description: 'HERB reference id, e.g. HBREF000003.' },
      },
      required: ['paper_id'],
    },
  },
  {
    name: 'herb_experiments',
    description:
      "List HERB's transcriptomic experiments (herb/ingredient treatment vs. control, GEO-deposited) — the raw " +
      'evidence behind the differential-expression predictions in herb_experiment_detail. Filter by drug type, ' +
      'species or platform.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        drug_type: { type: 'string', enum: ['Herb', 'Ingredient'] },
        species: { type: 'string', enum: ['Homo sapiens', 'Mus musculus'] },
        experiment_type: { type: 'string', enum: ['High-seq', 'Array'] },
        limit: { type: 'number', description: 'Max rows to return, default 25, max 100.' },
        offset: { type: 'number', description: '0-based offset for paging past the first `limit` rows.' },
      },
    },
  },
  {
    name: 'herb_experiment_detail',
    description:
      'Differential-expression results for one HERB transcriptomic experiment: top up/down-regulated genes and ' +
      'enriched GO terms / KEGG pathways, plus connectivity-map hit counts (compounds/knockdowns/overexpression ' +
      'signatures matching the expression pattern). Every row is evidence_tier computational_prediction — this is ' +
      'a statistical enrichment over one dataset, not a validated mechanism or a clinical finding.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        experiment_id: { type: 'string', description: 'HERB experiment id, e.g. HBEXP000001.' },
      },
      required: ['experiment_id'],
    },
  },
];

function clampLimit(n: unknown, def: number, max: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : def;
  return Math.max(1, Math.min(max, v));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'herb_search': {
      const keyword = String(args.keyword ?? '').trim();
      if (!keyword) throw new Error('user_error: keyword is required');
      const categoryKey = String(args.category ?? 'herb').toLowerCase();
      const label = CATEGORY_LABEL[categoryKey];
      if (!label) throw new Error(`user_error: category must be one of herb, ingredient, target, disease (got "${args.category}")`);
      const data = await chediCall<{ res_data?: Table }>('search_api', { keyword, label });
      const { rows } = tableToRows(data.res_data);
      return { category: categoryKey, keyword, match_count: rows.length, matches: rows };
    }

    case 'herb_browse': {
      const categoryKey = String(args.category ?? '').toLowerCase();
      const label = CATEGORY_LABEL[categoryKey];
      if (!label) throw new Error(`user_error: category must be one of herb, ingredient, target, disease (got "${args.category}")`);
      const page = clampLimit(args.page, 1, 1_000_000);
      const page_size = clampLimit(args.page_size, 20, 100);
      const data = await chediCall<{ total_num?: number; browse_data?: Table }>('browse_api', { label, page, page_size });
      const { rows } = tableToRows(data.browse_data);
      return { category: categoryKey, page, page_size, total_num: data.total_num ?? null, items: rows };
    }

    case 'herb_detail': {
      const id = String(args.id ?? '').trim();
      const categoryKey = String(args.category ?? '').toLowerCase();
      const label = CATEGORY_LABEL[categoryKey];
      if (!id) throw new Error('user_error: id is required');
      if (!label) throw new Error(`user_error: category must be one of herb, ingredient, target, disease (got "${args.category}")`);

      const limit = clampLimit(args.limit, 25, 200);
      const offset =
        typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      // Unknown section names fail loudly: a typo that silently returned
      // nothing would look exactly like a record with no such data.
      let sections: Set<string> | null = null;
      if (args.sections !== undefined) {
        if (!Array.isArray(args.sections) || args.sections.length === 0) {
          throw new Error('user_error: sections must be a non-empty array of section names');
        }
        sections = new Set(args.sections.map((s) => String(s)));
        for (const s of sections) {
          if (!DETAIL_SECTIONS.includes(s)) {
            throw new Error(`user_error: unknown section "${s}" — valid sections: ${DETAIL_SECTIONS.join(', ')}`);
          }
        }
      }
      const wants = (section: string) => sections === null || sections.has(section);
      /** Page one relationship table, keeping the TRUE total beside the slice
       *  so a truncated result can never read as the end of the data. */
      const paged = (rows: Record<string, unknown>[]) => {
        const slice = rows.slice(offset, offset + limit);
        return {
          total: rows.length,
          offset,
          limit,
          returned: slice.length,
          truncated: offset + slice.length < rows.length,
          rows: slice,
        };
      };

      let data: Record<string, Table | Record<string, unknown> | undefined>;
      try {
        data = await chediCall('detail_api', { key_id: id, label, v: id });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const { token, body } = splitClassPrefix(raw);
        throw new Error(
          `${token}HERB 2.0 has no ${categoryKey} record for id "${id}", or the id/category pairing is wrong ` +
            `(category must match the id's prefix). Upstream said: ${body}`,
        );
      }

      const result: Record<string, unknown> = { id, category: categoryKey };

      // summary — descriptive metadata, not a relationship, so no evidence_tier
      // rows; the note below covers the one field (Indication) that IS a claim.
      if (data.summary && wants('summary')) {
        const { rows } = tableToRows(data.summary as Table);
        result.summary = rows[0] ?? null;
        if (categoryKey === 'herb') {
          result.summary_evidence_note =
            'Function / Indication / Clinical manifestations / Properties / Meridians reflect traditional TCM ' +
            'use (evidence_tier: traditional_use) — not a clinical trial result.';
        }
      }

      const relationTiers: [string, string][] = [
        ['herb_ingredient', 'compositional_fact'],
        ['herb_target', 'computational_prediction'],
        ['herb_disease', 'computational_prediction'],
        ['ingredient_target', 'computational_prediction'],
        ['ingredient_disease', 'computational_prediction'],
        ['target_disease', 'computational_prediction'],
      ];
      for (const [section, tier] of relationTiers) {
        if (data[section] && wants(section)) {
          const page = paged(tableToRows(data[section] as Table).rows);
          result[section] = { ...page, rows: withTier(page.rows, tier) };
        }
      }
      // Ingredient_alias isn't a table — it's a one-element array holding one
      // semicolon-joined string of synonyms (small, so never paged).
      if (Array.isArray(data.Ingredient_alias) && typeof data.Ingredient_alias[0] === 'string' && wants('ingredient_alias')) {
        result.ingredient_alias = (data.Ingredient_alias[0] as string)
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      // PubMed-cited edges: resolve human_clinical vs laboratory from the
      // reference index (one extra live call, only when there's something to
      // tier IN THE RETURNED SLICE — a record with zero cited papers, or a
      // `sections` filter that excludes both paper tables, costs nothing extra).
      const wantsPapers = wants('drug_paper_target') || wants('drug_paper_disease');
      if (wantsPapers) {
        const paperTargetRows = wants('drug_paper_target') ? tableToRows(data.drug_paper_target as Table | undefined).rows : [];
        const paperDiseaseRows = wants('drug_paper_disease') ? tableToRows(data.drug_paper_disease as Table | undefined).rows : [];
        const targetPage = paged(paperTargetRows);
        const diseasePage = paged(paperDiseaseRows);
        if (targetPage.rows.length > 0 || diseasePage.rows.length > 0) {
          const experimentTypes = await fetchPaperExperimentTypes();
          targetPage.rows = tierPaperRows(targetPage.rows, experimentTypes);
          diseasePage.rows = tierPaperRows(diseasePage.rows, experimentTypes);
        }
        if (data.drug_paper_target && wants('drug_paper_target')) result.drug_paper_target = targetPage;
        if (data.drug_paper_disease && wants('drug_paper_disease')) result.drug_paper_disease = diseasePage;
      }

      return result;
    }

    case 'herb_papers': {
      const filter_drug_type = args.drug_type ? String(args.drug_type) : '';
      const filter_experiment_type = args.experiment_type ? String(args.experiment_type) : '';
      const sort_by = args.sort_by ? String(args.sort_by) : '';
      const limit = clampLimit(args.limit, 25, 100);
      const offset = clampLimit((args.offset as number | undefined) ?? 1, 1, 1_000_000_000) - 1;
      const data = await chediCall<{ paper_data?: Table }>('paper_api', { filter_drug_type, filter_experiment_type, sort_by });
      const { rows } = tableToRows(data.paper_data);
      const tiered = rows.map((r) => ({ ...r, evidence_tier: tierFromExperimentType(r['Experiment type'] as string | undefined) }));
      return { total_matching: tiered.length, offset, limit, papers: tiered.slice(offset, offset + limit) };
    }

    case 'herb_paper_detail': {
      const paper_id = String(args.paper_id ?? '').trim();
      if (!paper_id) throw new Error('user_error: paper_id is required');
      const data = await chediCall<{
        paper_target?: Table;
        paper_disease?: Table;
        paper_key_summary?: Table;
        abstract?: Record<string, number>;
      }>('paper_detail_api', { paper_key_id: paper_id });
      const summaryRows = tableToRows(data.paper_key_summary).rows;
      const summary = summaryRows[0] ?? null;
      const experimentType = summary ? (summary['Experiment type'] as string | undefined) : undefined;
      const tier = tierFromExperimentType(experimentType);
      return {
        paper_id,
        summary,
        paper_target: withTier(tableToRows(data.paper_target).rows, tier),
        paper_disease: withTier(tableToRows(data.paper_disease).rows, tier),
        // HERB's abstract field is a bag-of-words frequency count, not the
        // running text — useful for a quick topic scan, not for quoting.
        abstract_word_frequencies: data.abstract ?? {},
      };
    }

    case 'herb_experiments': {
      const filter_drug_type = args.drug_type ? String(args.drug_type) : '';
      const filter_species = args.species ? String(args.species) : '';
      const filter_exp_type = args.experiment_type ? String(args.experiment_type) : '';
      const limit = clampLimit(args.limit, 25, 100);
      const offset = clampLimit((args.offset as number | undefined) ?? 1, 1, 1_000_000_000) - 1;
      const data = await chediCall<{ experiment_data?: Table }>('experiment_api', {
        filter_drug_type,
        filter_species,
        filter_exp_type,
      });
      const { rows } = tableToRows(data.experiment_data);
      return { total_matching: rows.length, offset, limit, experiments: rows.slice(offset, offset + limit) };
    }

    case 'herb_experiment_detail': {
      const experiment_id = String(args.experiment_id ?? '').trim();
      if (!experiment_id) throw new Error('user_error: experiment_id is required');
      const data = await chediCall<{
        Experiment_summary?: Table;
        Experiment_detail?: Record<string, { data?: Record<string, unknown> }>;
      }>('experiment_detail_api', { drug_GSE_id: experiment_id });

      const summaryRows = tableToRows(data.Experiment_summary).rows;
      const summary = summaryRows[0] ?? null;

      const detailWrapper = data.Experiment_detail ?? {};
      const inner = Object.values(detailWrapper)[0]?.data ?? {};

      const topN = (table: unknown, n: number) => {
        if (typeof table === 'string') return { note: table, rows: [] as Record<string, unknown>[] };
        const { rows } = tableToRows(table as Table);
        return { total: rows.length, rows: rows.slice(0, n) };
      };

      const diffGenes = tableToRows(inner.diff_top300_csv as Table | undefined).rows;
      const upGenes = diffGenes
        .filter((r) => typeof r['Log2 (FC_avg)'] === 'number' && (r['Log2 (FC_avg)'] as number) > 0)
        .slice(0, 20);
      const downGenes = diffGenes
        .filter((r) => typeof r['Log2 (FC_avg)'] === 'number' && (r['Log2 (FC_avg)'] as number) < 0)
        .slice(0, 20);

      return {
        experiment_id,
        summary,
        evidence_tier: 'computational_prediction',
        evidence_note:
          'Differential expression, GO/KEGG enrichment and connectivity-map hits below are computed from one ' +
          'dataset comparing this herb/ingredient treatment to a control — a screening result, not a validated ' +
          'mechanism or a clinical finding.',
        differentially_expressed_genes: { total: diffGenes.length, top_up_regulated: upGenes, top_down_regulated: downGenes },
        enriched_go_terms: { up: topN(inner.up_GO_csv, 15), down: topN(inner.down_GO_csv, 15) },
        enriched_kegg_pathways: { up: topN(inner.up_kegg_csv, 15), down: topN(inner.down_kegg_csv, 15) },
        connectivity_map_hit_counts: {
          compounds: Array.isArray(inner.CMAP_CP_txt) ? (inner.CMAP_CP_txt as unknown[]).length : 0,
          gene_knockdowns: Array.isArray(inner.CMAP_KD_txt) ? (inner.CMAP_KD_txt as unknown[]).length : 0,
          gene_overexpression: Array.isArray(inner.CMAP_OE_txt) ? (inner.CMAP_OE_txt as unknown[]).length : 0,
          perturbagen_classes: Array.isArray(inner.CMAP_PCL_txt) ? (inner.CMAP_PCL_txt as unknown[]).length : 0,
        },
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
