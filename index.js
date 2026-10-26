// infra-memory v2 plugin — deterministic router inject over the curated
// ~/.config/opencode/memory/ tree. No LLM, no embeddings, no deps.
//
// Changed 2026-10-11 (audit pass):
//  - stopword filtering, so AND-scoring is not dominated by "the"/"and";
//  - a minimum score, so a weak match injects NOTHING instead of noise;
//  - captures moved to MEMORY_DIR/captures/ (a subdir) so they can never be
//    re-indexed as topic files — they used to be written into the tree and fed
//    straight back into search results;
//  - mtime+TTL cache, so a request does not re-read the whole tree;
//  - debug is runtime-toggleable, logs to a rotating file by default, and
//    records the REASON for every decision (the thing you actually need while
//    the plugin is new).
import { readdir, readFile, appendFile, stat, mkdir, cp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PREFIX = "[infra-memory]";
// Canonical agent-memory tree lives in the V2 tree (2026-10-19); the V1 path
// ~/.config/opencode/memory is a symlink into it, so both spellings resolve.
const MEMORY_DIR = join(homedir(), ".config", "opencode", "memory");
const CAPTURE_DIR = join(MEMORY_DIR, "captures");

const INJECT_CAP = 4000;
const SEARCH_HITS = 10;
const READ_CAP = 8000;
const MIN_TERM_LEN = 3;
/** A match must score at least this to be worth spending context on.
 *  Raised 2 -> 4 on 2026-10-11. At 2 the marginal score-3 matches were buying
 *  ~1400 chars each: `toggle/any/switch` scored exactly 3 on three common words
 *  and cleared the gate. The score-5+ matches were the ones genuinely routing
 *  to relevant memory; 4 keeps those and drops the noise floor. Tunable at
 *  runtime via `infra_debug`. */
const MIN_SCORE = 3;
const CACHE_TTL_MS = 30_000;
const MAX_DEBUG_LOG_BYTES = 2 * 1024 * 1024;
const RING_MAX = 50;

/** Explicit capture directives only. Bare "remember" in prose no longer fires. */
const CAPTURE_RE =
  /\b(?:remember|save)\s+(?:this|that)\b|\bremember:\s|\bdon'?t forget\b|\bdo not forget\b/i;

/** 3-letter English stopwords all passed the old length filter and matched
 *  nearly every file, which made the AND-scoring close to arbitrary. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one",
  "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old",
  "see", "two", "way", "who", "did", "let", "put", "say", "she", "too", "use", "why",
  "yes", "yet", "also", "back", "been", "being", "does", "each", "from", "have", "into",
  "just", "like", "make", "many", "more", "most", "much", "must", "only", "other", "over",
  "same", "some", "such", "than", "that", "them", "then", "they", "this", "those", "very",
  "want", "were", "what", "when", "where", "which", "will", "with", "your", "about", "after",
  "again", "could", "first", "found", "give", "here", "know", "less", "long", "need", "never",
  "still", "take", "thing", "think", "three", "under", "using", "work", "would", "write",
  "used", "made", "done",
]);

// --- debug state: runtime-toggleable, env only supplies the default ---------
const STATE_KEY = "__infra_mem__";
const RING_KEY = "__infra_mem_ring__";
/** Boot-signature dedup: twin bundle evaluations run setup twice seconds apart
 *  (same class as auto-resume's reload twins) and each one logged a boot line —
 *  256 of 223+ boot lines were identical repeats. The signature survives in
 *  globalThis across re-evaluations in one process; a new process or a changed
 *  config still logs exactly once. */
const BOOT_SIG_KEY = "__infra_mem_boot_sig__";

const state = () => (globalThis[STATE_KEY] ??= { registeredAt: null, counters: {} });

/** Per-session injection ledger: the user-message key we last injected for, and
 *  whether a compaction has re-armed the next injection. Compaction is the one
 *  event that must clear it — it is the only moment the injected text is no
 *  longer in the model's context, so skipping the next injection there would
 *  lose the memory for the rest of a long turn. */
function injectionLedger() {
  const s = state();
  return (s.injections ??= { bySession: {} });
}

/** Per-session ledger entry: the user-message key last served for this
 *  session, plus whether a compaction re-armed the next injection.
 *  Rearm MUST be per-session: a single global flag lets session B consume
 *  session A's re-arm (B re-injects, flag clears, A then dedupes and loses
 *  its memory for the rest of the turn). */
function ledgerEntry(sid) {
  const ledger = injectionLedger();
  let e = ledger.bySession[sid];
  if (!e || typeof e !== "object") {
    e = { key: typeof e === "string" ? e : null, rearmed: false };
    ledger.bySession[sid] = e;
  }
  return e;
}

/** Re-arm the next injection. With a sid only that session re-arms;
 *  without one (compaction hook carries no sid) every known session
 *  re-arms — over-injection by one turn is safe, losing memory is not.
 *  Unknown sids need nothing: first evaluation injects anyway. */
function rearmInjection(sid) {
  if (sid) {
    ledgerEntry(sid).rearmed = true;
    return;
  }
  const ledger = injectionLedger();
  for (const k of Object.keys(ledger.bySession)) ledgerEntry(k).rearmed = true;
}

function isDebug() {
  const s = state();
  // Default ON: this plugin is new and under observation, and a monitoring
  // system that defaults off is decoration. Explicit opt-out wins — via env
  // (INFRA_MEMORY_DEBUG=0) or the infra_debug tool — and survives reloads;
  // anything else re-reads the env every call so a hot-reload picks up a
  // default change with no restart and no stale cache.
  if (s.debugOverride !== undefined) return !!s.debugOverride;
  return process.env.INFRA_MEMORY_DEBUG !== "0";
}

function debugLogFile() {
  // Default lives OUTSIDE the plugin dir: the server hot-reloads plugin
  // files, so per-request debug writes next to index.js risk re-evaluation
  // churn. ~/opencode/findings/ is the box convention (cf. sinkhole-guard).
  return process.env.INFRA_MEMORY_LOG_FILE || join(homedir(), "projects", "opencode", "permanent_files", "findings", "infra-memory-debug.jsonl");
}

const log = (level, msg) => {
  try {
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`${LOG_PREFIX} ${msg}`);
  } catch { /* logging never breaks hooks */ }
};

/** Debug line: console + rotating JSONL. Never throws, never blocks. */
/** Short, greppable form of a session id — the convention every other log on
 *  this box uses (…LTaEuA05). Undefined-safe: hooks may omit the id. */
function shortSid(id) {
  const s = typeof id === "string" ? id : "";
  return s.length > 9 ? "…" + s.slice(-8) : s || "unknown";
}

/** Buffered debug writer: ring (in-memory tail) + batched JSONL appends.
 *  The context hook fires before every model call, so per-evaluation
 *  stat+appendFile on the hot path is a needless syscall rate. Buffer up
 *  to 50 entries or 5s, then flush once. Rotation is dated with keep-5:
 *  the old file→file.1 scheme kept one stale snapshot and silently
 *  overwrote it on every later rotation. */
const DBG_BUF_KEY = "__infra_mem_dbg_buf__";
const DBG_FLUSH_KEY = "__infra_mem_dbg_flush__";
const DBG_FLUSH_N = 50;
const DBG_FLUSH_MS = 5000;
const DBG_KEEP_ROTATED = 5;

async function dbgFlush() {
  globalThis[DBG_FLUSH_KEY] = null;
  const buf = globalThis[DBG_BUF_KEY] ?? [];
  if (!buf.length) return;
  globalThis[DBG_BUF_KEY] = [];
  try {
    const file = debugLogFile();
    const st = await stat(file).catch(() => null);
    if (st && st.size > MAX_DEBUG_LOG_BYTES) {
      const { rename, readdir, unlink } = await import("node:fs/promises");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await rename(file, `${file}.${stamp}`).catch(() => {});
      const dir = dirname(file);
      const base = file.split("/").pop();
      const rotated = (await readdir(dir).catch(() => []))
        .filter((n) => n.startsWith(`${base}.`))
        .sort();
      while (rotated.length > DBG_KEEP_ROTATED) {
        const old = rotated.shift();
        await unlink(join(dir, old)).catch(() => {});
      }
    }
    await appendFile(file, buf.join(""), "utf8");
  } catch { /* monitoring must not affect behavior */ }
}

function dbgSchedule() {
  if (globalThis[DBG_FLUSH_KEY]) return;
  globalThis[DBG_FLUSH_KEY] = setTimeout(() => {
    void dbgFlush();
  }, DBG_FLUSH_MS);
  globalThis[DBG_FLUSH_KEY]?.unref?.();
}

async function dbg(obj) {
  if (!isDebug()) return;
  try {
    const entry = { ts: new Date().toISOString(), ...obj };
    console.log(`${LOG_PREFIX}:debug ${JSON.stringify(obj).slice(0, 500)}`);
    const ring = (globalThis[RING_KEY] ??= []);
    ring.push(entry);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    const buf = (globalThis[DBG_BUF_KEY] ??= []);
    buf.push(`${JSON.stringify(entry).slice(0, 1000)}\n`);
    if (buf.length >= DBG_FLUSH_N) await dbgFlush();
    else dbgSchedule();
  } catch { /* monitoring must not affect behavior */ }
}

function bump(key, n = 1) {
  const s = state();
  s.counters[key] = (s.counters[key] ?? 0) + n;
  return s.counters[key];
}

function lastStats() {
  const s = state();
  return {
    registeredAt: s.registeredAt,
    // The EFFECTIVE switch, not `s.debug` — that field is never assigned
    // anywhere, so reading it reported `false` unconditionally and made a
    // working debug pipeline look dead (2026-10-11). isDebug() is the single
    // source of truth for whether entries are being written.
    debug: isDebug(),
    // Heartbeat: the last time the context hook evaluated ANYTHING for any
    // session, including deduped evaluations. If the log is quiet and this is
    // fresh, the hook is alive and skipping; if it is stale, the hook is not
    // being invoked. Added 2026-10-11 after 41 min of silence that nothing
    // could attribute.
    lastEvaluatedAt: state().lastEvaluatedAt ?? null,
    injectedFor: Object.keys((state().injections ?? {}).bySession ?? {}),
    debugLogFile: debugLogFile(),
    memoryDir: MEMORY_DIR,
    minScore: MIN_SCORE,
    counters: s.counters ?? {},
  };
}

// --- terms ------------------------------------------------------------------
function stem(t) {
  if (t.length <= 4) return t;
  // Handle doubled consonants (running -> run, stopped -> stop)
  const doubleConsonant = (s) => {
    if (s.length >= 2 && s[s.length-1] === s[s.length-2] && !/[aeiou]/.test(s[s.length-1])) {
      return s.slice(0, -1);
    }
    return s;
  };
  if (t.endsWith("ing")) {
    const base = doubleConsonant(t.slice(0, -3));
    if (base.length >= 3) return base;
  }
  if (t.endsWith("ed")) {
    const base = doubleConsonant(t.slice(0, -2));
    if (base.length >= 3) return base;
  }
  if (t.endsWith("er")) {
    const base = doubleConsonant(t.slice(0, -2));
    if (base.length >= 3) return base;
  }
  if (t.endsWith("est")) {
    const base = doubleConsonant(t.slice(0, -3));
    if (base.length >= 3) return base;
  }
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function termsOf(text, max = 8) {
  const seen = new Set();
  const out = [];
  for (const t of String(text || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (t.length < MIN_TERM_LEN || seen.has(t)) continue;
    if (STOPWORDS.has(t)) continue;
    const s = stem(t);
    if (seen.has(s)) continue;
    seen.add(t);
    seen.add(s);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// --- topic files + content cache -------------------------------------------
/** mtime/size keyed content cache; TTL-bounded so an edit shows up on its own. */
let cache = { at: 0, files: null, contents: new Map() };

function invalidate() {
  cache = { at: 0, files: null, contents: new Map() };
}

/** Bundled starter tree, installed on first run iff the user has no `.md`
 *  files of their own. Documented in README.md ("Setup behavior"). Exported
 *  so the rule can be tested without touching the real memory dir. */
const DEFAULT_MEMORY_DIR = join(dirname(fileURLToPath(import.meta.url)), "default-memory");
export async function ensureDefaultMemory(dir = MEMORY_DIR, src = DEFAULT_MEMORY_DIR) {
  try {
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir, { withFileTypes: true });
    // Any .md at all means the user has their own process — leave it alone.
    // Compatibility is on them per the README contract; we never overwrite.
    if (entries.some((e) => e.isFile() && e.name.endsWith(".md"))) return "present";
    const starters = await readdir(src).catch(() => []);
    for (const f of starters) {
      if (!f.endsWith(".md")) continue;
      await cp(join(src, f), join(dir, f), { errorOnExist: false }).catch(() => {});
    }
    return "installed";
  } catch {
    return "skipped";
  }
}

async function topicFiles() {
  const now = Date.now();
  if (cache.files && now - cache.at < CACHE_TTL_MS) return cache.files;
  let entries = [];
  try {
    entries = await readdir(MEMORY_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    // attic-*: archived splits. log-*: older capture runs. captures/ is a
    // subdir and is excluded by isFile() above — captures are NEVER indexed.
    .filter((n) => !n.startsWith("attic-") && !n.startsWith("log-") && !n.startsWith("capture-"))
    .sort();
  cache = { at: now, files, contents: new Map() };
  return files;
}

async function cachedText(name) {
  const path = join(MEMORY_DIR, name);
  const st = await stat(path).catch(() => null);
  if (!st) return "";
  const hit = cache.contents.get(name);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
  let text = "";
  try {
    text = (await readFile(path, "utf8")).toLowerCase();
  } catch {
    return "";
  }
  cache.contents.set(name, { mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

export async function searchMemory(query, limit = SEARCH_HITS) {
  const now = Date.now();
  const terms = termsOf(query);
  if (!terms.length) return [];
  const files = await topicFiles();
  const scored = [];
  for (const name of files) {
    const raw = await cachedText(name);
    if (!raw) continue;
    let hits = 0;
    const lines = [];
    const matched = [];
    for (const t of terms) {
      const st = stem(t);
      if (raw.includes(t) || raw.includes(st)) {
        hits++;
        matched.push(t);
        const idx = raw.indexOf(t) >= 0 ? raw.indexOf(t) : raw.indexOf(st);
        lines.push(raw.slice(Math.max(0, idx - 80), idx + 120).replace(/\s+/g, " ").trim());
      }
    }
    if (hits === 0) continue;

    // Phrase bonus: if the full query appears as an exact phrase, boost
    const queryLower = String(query || "").toLowerCase().trim();
    let phraseBonus = 0;
    if (queryLower.length >= 5 && raw.includes(queryLower)) {
      phraseBonus = 3;
    }

    // Temporal decay: prefer recent files
    let decayFactor = 1.0;
    try {
      const st = await stat(join(MEMORY_DIR, name));
      const ageDays = (now - st.mtimeMs) / (24 * 60 * 60 * 1000);
      if (ageDays > 7) {
        decayFactor = Math.max(0.5, 1.0 - (ageDays - 7) / 90);
      }
    } catch {
      // keep default
    }

    const rawScore = hits + phraseBonus;
    const score = rawScore * decayFactor;
    if (score > 0) scored.push({ file: name, hits: Math.round(score), matched, snippet: lines.slice(0, 3).join(" … ").slice(0, 400), rawScore, decayFactor });
  }
  return scored.sort((a, b) => (b.rawScore * b.decayFactor) - (a.rawScore * a.decayFactor) || a.file.localeCompare(b.file)).slice(0, limit);
}

/**
 * The full decision, including WHY. The hook pushes `text` only when
 * `suppressed` is false — so a weak match costs zero context.
 */
export async function decide(query) {
  const t0 = Date.now();
  const terms = termsOf(query);
  const hits = terms.length ? await searchMemory(query, 3) : [];
  const score = hits[0]?.hits ?? 0;
  // One rule, no exceptions. An earlier draft let a single 5+ character match
  // through on the theory that a long term is distinctive — but the snippet is
  // built FROM the matched terms, so that check was vacuous and "banana
  // smoothie recipe" (score 1) injected anyway. Memory files are large; one
  // common word matching one file is noise, not a route. MIN_SCORE stays a
  // single tunable number, which is what makes it debuggable.
  let suppressed = null;
  if (!terms.length) suppressed = "no-usable-terms";
  else if (!hits.length) suppressed = "no-match";
  else if (score < MIN_SCORE) suppressed = `below-min-score(${score}<${MIN_SCORE})`;
  if (suppressed) {
    return {
      text: "",
      suppressed,
      terms,
      score,
      hits: hits.map((h) => `${h.file}(${h.hits})`),
      chars: 0,
      ms: Date.now() - t0,
    };
  }
  const text = buildInjectFrom(hits);
  return {
    text,
    suppressed,
    terms,
    score,
    hits: hits.map((h) => `${h.file}(${h.hits})`),
    chars: text.length,
    ms: Date.now() - t0,
  };
}

/** Always returns the wrapper — the smoke test pins that contract. */
export function buildInjectFrom(hits) {
  const parts = [
    "<infra-memory>",
    "Router: ~/.config/opencode/memory/index.md (read it for routing; excerpts below are pointers, not copies).",
  ];
  if (!hits.length) {
    parts.push("No keyword match — read index.md ROUTING section for where to look.");
  } else {
    for (const h of hits) parts.push(`- ${h.file} :: ${h.snippet}`);
  }
  parts.push("</infra-memory>");
  return parts.join("\n").slice(0, INJECT_CAP);
}

export async function buildInject(query) {
  return buildInjectFrom(await searchMemory(query, 3));
}

/** The newest user message as { id, text }. The id is the injection key: the
 *  same user message produces the same terms, so re-evaluating it on every
 *  model call re-injects identical text (2026-10-11: one "toggle any switch"
 *  turn injected the same 1411 chars 21 times). Returns id=null when the host
 *  gives none, in which case the caller falls back to text-based keying. */
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return { id: null, text: "" };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m?.role ?? m?.info?.role;
    if (role !== "user") continue;
    const content = m?.content ?? m?.info?.parts ?? m?.parts;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).join(" ").slice(0, 2000);
    } else if (typeof m?.text === "string") text = m.text;
    const id = typeof m?.id === "string" ? m.id : typeof m?.info?.id === "string" ? m.info.id : null;
    return { id, text };
  }
  return { id: null, text: "" };
}

/** Capture the SENTENCE that asked to be remembered, not the whole prompt. */
function captureLine(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const m = CAPTURE_RE.exec(flat);
  if (!m) return "";
  const start = Math.max(flat.lastIndexOf(".", m.index - 1) + 1, flat.lastIndexOf("\n", m.index) + 1, 0);
  const dot = flat.indexOf(".", m.index);
  const sentence = flat.slice(start, dot === -1 ? undefined : dot + 1).trim();
  return sentence.slice(0, 500);
}

let captureDirReady = null;
async function appendCapture(line) {
  const now = new Date();
  const file = join(CAPTURE_DIR, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}.md`);
  const clean = String(line).replace(/\s+/g, " ").trim().slice(0, 500);
  if (!clean) return;
  try {
    captureDirReady ??= mkdir(CAPTURE_DIR, { recursive: true });
    await captureDirReady;
    await appendFile(file, `\n- ${now.toISOString().slice(0, 10)}: ${clean}\n`, "utf8");
    void dbg({ capture: clean.slice(0, 120), file });
    bump("captures");
    log("info", `captured to ${file}`);
  } catch (e) {
    log("warn", `capture failed: ${e.message}`);
  }
}

/**
 * Hot-reload latch.
 *
 * `ctx.session.hook()` returns a registration with `.dispose()` (confirmed
 * against the v2 plugin docs), so a re-evaluated build can retire the previous
 * one instead of bailing out. The old code set a boolean and returned early,
 * which meant a config change never took effect until a server restart — and,
 * worse, nothing ever unregistered the first build's hooks.
 *
 * Returns the retired handle when there was one, so setup can log it.
 */
async function retirePrevious() {
  const s = state();
  const prev = s.registrations;
  if (!prev?.length) return null;
  const when = s.registeredAt;
  for (const r of prev) {
    try {
      await r.dispose();
    } catch (e) {
      log("warn", `retiring previous registration failed: ${e.message}`);
    }
  }
  s.registrations = [];
  s.retiredAt = new Date().toISOString();
  log("info", `retired ${prev.length} hook registration(s) from ${when} — re-registering with current config`);
  return when;
}

export default {
  id: "infra-memory",
  setup: async (ctx) => {
    // Liveness check FIRST: if the tree is gone we leave existing hooks
    // alone (they degrade to empty results) rather than retiring them and
    // going fully dead until the next re-evaluation.
    try {
      await stat(MEMORY_DIR);
    } catch {
      log("warn", `memory dir missing: ${MEMORY_DIR} — keeping previous hooks, inject degraded`);
      return;
    }
    // Retiring before registering: a failure below leaves the old hooks
    // gone rather than doubled. The reverse order risks double-injection.
    await retirePrevious();
    // First-run bootstrap: a starter tree iff the user has nothing of their
    // own (never overwrites). Runs before any hook reads the tree.
    void ensureDefaultMemory().then((r) => {
      if (r !== "present") void dbg({ memoryBootstrap: r });
    });
    const s = state();
    s.registeredAt = new Date().toISOString();
    s.retiredAt = null;
    const registrations = [];
    /** AbortControllers for the event-stream subscriptions, aborted on dispose
     *  so a reloaded plugin does not leave a live reader behind. */
    const subscriptions = [];

    registrations.push(await ctx.session.hook("context", async (event) => {
      try {
        const msg = lastUserMessage(event.messages);
        if (!msg.text) return;
        const key = msg.id ?? msg.text.slice(0, 200);
        const sid = event.sessionID ?? "unknown";
        const entry = ledgerEntry(sid);
        // Once per turn, not once per model call. The context hook fires before
        // every generation, including each tool round-trip, but the newest user
        // message does not change mid-turn — so re-deciding it re-derives the
        // same terms and re-injects byte-identical text. Observed 2026-10-11:
        // one "toggle any switch" turn pushed the same 1411 chars 21 times
        // (~28k chars of duplicate context). Compaction re-arms: that is the
        // only point where the injected text is genuinely gone.
        const already = entry.key;
        // Heartbeat FIRST, before any early return: "is the hook seeing
        // traffic" must be answerable even when every evaluation below is
        // skipped. 2026-10-11: the log went 41 min without a context entry and
        // nothing distinguished "quiet because deduped" from "quiet because
        // dead". This timestamp, surfaced in status, ends that ambiguity.
        state().lastEvaluatedAt = new Date().toISOString();
        if (already === key && !entry.rearmed) {
          bump("deduped");
          // Deduped evaluations ARE logged, cheaply: without this line the
          // dedupe counter is the only evidence the hook fired, and a counter
          // with no timestamp cannot distinguish a live hook from a dead one.
          void dbg({ hook: "context", sid: shortSid(event.sessionID), deduped: true, key: String(key).slice(0, 80) });
          return;
        }
        entry.rearmed = false;
        const d = await decide(msg.text);
        // The single most useful signal while tuning: why nothing was injected.
        // Attribution matters as much as the decision: without a session id a
        // gap in this log cannot be traced to the session that stopped being
        // logged (2026-10-11: the file sat at 13 entries through hours of real
        // work, and nothing in the log could say which session went quiet).
        // `sid` is the short form used by every other log on this box.
        void dbg({
          hook: "context",
          sid: shortSid(event.sessionID),
          terms: d.terms,
          score: d.score,
          hits: d.hits,
          suppressed: d.suppressed,
          chars: d.chars,
          ms: d.ms,
        });
        if (d.suppressed) {
          bump("suppressed");
          // Record the key even when suppressed: the same message will keep
          // scoring the same way, so re-deciding it on every model call is
          // wasted work as well as wasted context.
          entry.key = key;
          return;
        }
        event.system.push({ type: "text", text: d.text });
        entry.key = key;
        bump("injected");
      } catch (e) {
        log("warn", `context hook err: ${e.message}`);
        void dbg({ hook: "context", sid: shortSid(event.sessionID), error: e.message });
      }
    }));

    // Compaction drops the injected memory from context. The next model call in
    // that session must inject again, even though the newest user message is
    // unchanged — otherwise a long turn that compacts loses its memory for the
    // remainder. This is the re-arm half of the once-per-turn rule.
    //
    // Two signals, because they are NOT the same thing:
    //   - `session.compacted` is published by the server after a successful
    //     summarize. That is the event that means context was actually rewritten.
    //   - `hook("compaction")` runs DURING the checkpoint summary request (the
    //     docs: "`messages` is the transcript being summarized"), so on its own
    //     it fires too early — mid-summarize, before history has been replaced.
    //     Kept as a secondary trigger: ordering nuance aside, a host that fires
    //     it late still gets the re-arm, and the flag is idempotent.
    //
    // DCP's `compress` is NOT covered by either of the above. It is a TOOL call,
    // not a compaction event: at modelMinLimits == modelMaxLimit == 76000 with
    // mode "range" it rewrites the transcript ("Collapse selected individual
    // messages ... into detailed summaries" — dcp-prompts/compress-range.md),
    // keeping the most relevant/recent material and protected tools. So it
    // genuinely destroys injected memory and publishes no session.compacted.
    // `tool.execute.after` fires only on SUCCESS (opencode session/tools.ts
    // short-circuits before it when the tool throws), so it is exactly the
    // "context was actually rewritten" signal DCP gives us.
    try {
      const controller = new AbortController();
      subscriptions.push(controller);
      void (async () => {
        const stream = ctx.event?.subscribe?.({ signal: controller.signal });
        if (!stream) return;
        for await (const ev of stream) {
          if (ev?.type === "session.compacted") {
            rearmInjection(ev?.sessionID ?? ev?.sessionId ?? null);
            void dbg({ hook: "session.compacted", note: "injection re-armed" });
          }
        }
      })().catch((e) => {
        void dbg({ hook: "session.compacted", error: e instanceof Error ? e.message : String(e) });
      });

      // DCP compress rewrote the transcript: the next model call must inject
      // again even though the newest user message is unchanged.
      try {
        registrations.push(
          await ctx.tool.hook("execute.after", async (input) => {
            const name = String(input?.tool ?? "").toLowerCase();
            if (name !== "compress") return;
            rearmInjection(input?.sessionID ?? null);
            void dbg({ hook: "tool.execute.after", tool: name, sessionID: shortSid(input?.sessionID), note: "injection re-armed" });
          }),
        );
      } catch (e) {
        void dbg({ hook: "tool.execute.after", error: e instanceof Error ? e.message : String(e) });
      }

      registrations.push(
        await ctx.session.hook("compaction", async () => {
          rearmInjection(null);
          void dbg({ hook: "compaction", note: "injection re-armed" });
        }),
      );
    } catch (e) {
      // Not every host exposes the event stream or the compaction hook; the
      // rule degrades to per-turn only, which is still correct-but-tighter.
      void dbg({ hook: "compaction", error: e.message });
    }

    registrations.push(await ctx.session.hook("prompt", async (event) => {
      try {
        const text = event?.prompt?.text;
        if (typeof text !== "string") return;
        const line = captureLine(text);
        if (line) await appendCapture(line);
      } catch (e) {
        log("warn", `prompt hook err: ${e.message}`);
      }
    }));

    /**
     * Fallback session todos, registered ONLY when no todo-capable tool
     * exists anywhere. Detection is the LIVE tool list: the plugin inventory
     * (config entries) only proves a todo plugin is CONFIGURED, not loaded —
     * a path like `.../opencode-todo-fork` substring-matches "todo" while the
     * plugin itself fails to load (2026-10-14: deleted root index.js caused
     * the loader to skip the whole fork, inventory still listed it, fallback
     * stayed out, nothing todo-capable existed). Live tools are decisive.
     * Load-order risk is benign: fork tools are todowrite/todoread while the
     * fallback tool is `todo`, so a late-loading fork never collides; the
     * fallback /todo command registration below is try/caught for the same
     * reason. On any detection failure the fallback IS provided — a duplicate
     * `todo` tool on a broken host is confusion, but a missing one on a fresh
     * box is a missing feature, and only the latter is silent.
     */
    let todoAvailable = false;
    try {
      const listed = (await ctx.tool.list?.()) ?? [];
      const arr = Array.isArray(listed) ? listed : [];
      todoAvailable = arr.some((t) => {
        const n = String(t?.id ?? t?.name ?? t ?? "").toLowerCase();
        return n === "todo" || n === "todowrite" || n.endsWith("/todo") || n.endsWith("/todowrite");
      });
    } catch {}
    // Load order is NOT config order: this plugin's setup runs before
    // opencode-todo-fork's, so the live-tool list above can never see the fork's
    // tools and the fallback would win the `todo` name — shadowing the fork's
    // /todo (pending/done) with the scratch fallback (fresh slate). A configured
    // todo plugin is the decisive signal here; live tools still cover the case
    // where a todo plugin is loaded without appearing in this config.
    if (!todoAvailable) {
      try {
        // Derive from this plugin's own location: <config>/opencode/plugins/infra-memory/index.js
        // → config root is <config>/opencode/opencode.jsonc. XDG-based joins
        // produced <xdg>/opencode/opencode.jsonc (one segment too deep on v2).
        const cfgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "opencode.jsonc");
        const raw = await readFile(cfgPath, "utf8");
        todoAvailable = /"[^"]*(?:todo-fork|opencode-todolist|todolist-local)[^"]*"/i.test(raw);
        if (todoAvailable) log("info", "todo plugin configured in opencode.jsonc — fallback stays out");
      } catch {}
    }
    if (!todoAvailable) log("info", "no todo tool found — registering fallback session todos");
    /** Session scratch dir: `<root>/<safe-sid>/`. The ONLY directory this
     *  plugin (and the sessions-sweep janitor) ever removes. Never the root. */
    const SESSION_SCRATCH_ROOT = join("/tmp", "opencode");
    function sessionScratchDir(sid) {
      const safe = String(sid ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
      return join(SESSION_SCRATCH_ROOT, safe);
    }
    function sessionTodosPath(sid) {
      return join(sessionScratchDir(sid), "todos.json");
    }
    async function readSessionTodos(sid) {
      try {
        const d = JSON.parse(await readFile(sessionTodosPath(sid), "utf8"));
        if (d && Array.isArray(d.todos)) return d.todos;
      } catch {}
      return [];
    }
    async function writeSessionTodos(sid, todos) {
      await mkdir(sessionScratchDir(sid), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(sessionTodosPath(sid), JSON.stringify({ todos }, null, 1));
    }
    function formatTodos(todos) {
      if (!todos.length) return "No session todos yet (fresh slate).";
      return todos.map((t, i) => `${i + 1}. [${t.status ?? "pending"}] ${t.text ?? ""}`).join("\n");
    }
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "infra_search",
        description: "AND-keyword search over curated ~/.config/opencode/memory/*.md (no embeddings). Returns file + snippet pointers.",
        input: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
        options: { codemode: false },
        execute: async (input) => {
          const hits = await searchMemory(String(input?.query ?? ""), SEARCH_HITS);
          void dbg({ tool: "infra_search", q: String(input?.query ?? "").slice(0, 80), nhits: hits.length });
          if (!hits.length) return { content: "No matches. Read memory/index.md ROUTING section." };
          return { content: hits.map((h) => `[${h.hits}] ${h.file} :: ${h.snippet}`).join("\n") };
        },
      });
      editor.add({
        name: "infra_list",
        description: "List curated memory topic files (excludes attic splits and captured logs).",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => ({ content: (await topicFiles()).slice(0, 30).join("\n") || "No memory files." }),
      });
      editor.add({
        name: "infra_read",
        description: "Read one curated memory file by name (capped).",
        input: { type: "object", properties: { file: { type: "string" } }, required: ["file"], additionalProperties: false },
        options: { codemode: false },
        execute: async (input) => {
          const name = String(input?.file ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
          if (!name.endsWith(".md")) return { content: "Refused: only .md files." };
          try {
            return { content: (await readFile(join(MEMORY_DIR, name), "utf8")).slice(0, READ_CAP) };
          } catch {
            return { content: `No such memory file: ${name}` };
          }
        },
      });
      editor.add({
        name: "infra_debug",
        description:
          "Inspect and control the memory plugin. action=status (default) | on | off | reload | tail [n] | test <query>. Use to see why it did or did not inject.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "on", "off", "reload", "tail", "test"] },
            query: { type: "string" },
            n: { type: "number" },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input) => {
          const action = String(input?.action ?? "status");
          const s = state();
          if (action === "on" || action === "off") {
            s.debugOverride = action === "on";
            log("info", `debug ${action} (runtime override)`);
            void dbg({ tool: "infra_debug", toggled: action });
          }
          if (action === "reload") {
            invalidate();
            void dbg({ tool: "infra_debug", cacheInvalidated: true });
          }
          if (action === "tail") {
            const n = Math.min(Number(input?.n ?? 10) || 10, RING_MAX);
            const ring = globalThis[RING_KEY] ?? [];
            return { content: JSON.stringify(ring.slice(-n), null, 1).slice(0, 4000) || "(no debug entries yet — run with debug on)" };
          }
          if (action === "test") {
            const d = await decide(String(input?.query ?? ""));
            return {
              content: JSON.stringify(
                { query: input?.query ?? "", terms: d.terms, score: d.score, hits: d.hits, suppressed: d.suppressed, wouldInjectChars: d.chars, ms: d.ms },
                null,
                1,
              ).slice(0, 2000),
            };
          }
          return { content: JSON.stringify({ ...lastStats(), topicFiles: await topicFiles() }, null, 1).slice(0, 2000) };
        },
      });
      // Fallback /todo surface, ONLY when nothing todo-capable exists (see
      // detection above). Reads the session scratch todos this design owns:
      // `<scratch>/<sid>/todos.json`. Missing file means fresh slate — stated,
      // never an error — which is also the reboot-orphan answer.
      if (!todoAvailable) {
        editor.add({
          name: "todo",
          description: "Session scratch todos: list (default), add, start, done, cancel. State lives in the session scratch dir and dies with it; a missing file means a fresh slate.",
          input: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list", "add", "start", "done", "cancel"] },
              text: { type: "string" },
              id: { type: "number" },
            },
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (input, toolCtx) => {
            const sid = toolCtx?.sessionID ?? "unknown";
            const action = String(input?.action ?? "list");
            const todos = await readSessionTodos(sid);
            if (action === "add") {
              const text = String(input?.text ?? "").trim();
              if (!text) return { content: "Refused: add needs text." };
              const id = todos.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
              todos.push({ id, text, status: "pending" });
              await writeSessionTodos(sid, todos);
              return { content: `Added #${id}.\n` + formatTodos(todos) };
            }
            if (action === "start" || action === "done" || action === "cancel") {
              const id = Number(input?.id);
              const t = todos.find((x) => Number(x.id) === id);
              if (!t) return { content: `No todo #${input?.id ?? "?"} — list shows current ids.` };
              t.status = action === "done" ? "done" : action === "cancel" ? "cancelled" : "in_progress";
              await writeSessionTodos(sid, todos);
              return { content: formatTodos(todos) };
            }
            return { content: formatTodos(todos) };
          },
        });
      }
    });

    // Fallback /todo command, same gate as the tool above: only when nothing
    // todo-capable exists. Posts this plugin's session scratch list into the
    // conversation. Try/caught: a late-loading todo plugin registering its own
    // `todo` command must not take this setup down with it.
    if (!todoAvailable && ctx.command && typeof ctx.command.transform === "function") {
      try {
        await ctx.command.transform((cmd) => {
          cmd.add({
            name: "todo",
            description:
              "Show the session scratch todo list (fallback; active only when no todo plugin is loaded).",
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: formatTodos(await readSessionTodos(sessionID)),
                delivery,
              });
            },
          });
        });
      } catch (e) {
        log("warn", `fallback /todo command skipped: ${e?.message ?? e}`);
      }
    }

    s.registrations = registrations;
    log("info", `loaded (memory dir ${MEMORY_DIR})${isDebug() ? " DEBUG=1" : ""} hooks=${registrations.length}`);
    // One boot line per distinct config per process — twin bundle evaluations
    // with an unchanged tree stay quiet instead of re-logging the same payload.
    {
      const bootSig = JSON.stringify({ d: MEMORY_DIR, s: MIN_SCORE, h: registrations.length });
      if (globalThis[BOOT_SIG_KEY] !== bootSig) {
        globalThis[BOOT_SIG_KEY] = bootSig;
        void dbg({ boot: true, memoryDir: MEMORY_DIR, minScore: MIN_SCORE, hooks: registrations.length });
      }
    }

    // Returned disposer: the host calls this when the plugin is torn down, so
    // the hooks leave with it instead of outliving the config that made them.
    return async () => {
      try {
        await dbgFlush();
      } catch { /* flush is best-effort */ }
      for (const c of subscriptions) {
        try {
          c.abort();
        } catch { /* already gone */ }
      }
      for (const r of registrations) {
        try {
          await r.dispose();
        } catch { /* already gone */ }
      }
      if (s.registrations === registrations) s.registrations = [];
      s.registeredAt = null;
      log("info", "disposed — hooks unregistered");
    };
  },
};
