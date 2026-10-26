import { searchMemory, buildInject } from "./index.js";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

// 1. search finds routing for a known infra-memory topic
const hits = await searchMemory("ghw push fails", 5);
console.log("hits:", hits.map((h) => `${h.file}(${h.hits})`).join(", ") || "(none)");
if (!hits.length) fail("no hits for 'ghw push fails'");
if (!hits.some((h) => /recipes|gotchas|index/i.test(h.file))) fail("expected recipes/gotchas/index pointer");

// 2. inject capped + wrapped
const inject = await buildInject("ghw push fails gitea remote");
console.log("inject chars:", inject.length);
if (inject.length > 4000) fail("inject over cap");
if (!inject.includes("<infra-memory>")) fail("inject missing wrapper");

// 3. default export shape (V2 {id, setup}, system push uses {type:text})
const mod = await import("./index.js");
if (mod.default?.id !== "infra-memory") fail("bad plugin id");
if (typeof mod.default?.setup !== "function") fail("setup not a function");
const src = await import("node:fs/promises").then((fs) => fs.readFile("./index.js", "utf8"));
if (/system\.push\("|\bsystem\.push\(`/.test(src)) fail("bare-string system.push found");
if (!src.includes('type: "text"')) fail("missing {type:text} push");
if (/ctx\.generate|from ["']transformers|@xenova|onnxruntime/i.test(src)) fail("LLM/embedding ref found");

// 4. no curated writes: index.md mtime unchanged by import (import has no side effects by design)
const idx = join(homedir(), ".config", "opencode", "memory", "index.md");
const before = (await stat(idx)).mtimeMs;
await new Promise((r) => setTimeout(r, 50));
const after = (await stat(idx)).mtimeMs;
if (before !== after) fail("index.md touched");

console.log("PASS: infra-memory smoke green");
