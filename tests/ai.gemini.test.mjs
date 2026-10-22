// AI provider behaviour: empty-answer bug (thinking tokens), retries, no-context handling, provider failures never crash a conversation.
import { makeRunner } from "./harness.mjs";
import { GeminiAIProvider, MockAIProvider } from "../server/services/ai/AIProvider.js";
const t = makeRunner({}); const { check } = t;
const realFetch = globalThis.fetch;
const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
const ok = (text) => reply(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
let calls = [];
const stub = (...seq) => { calls = []; let i = 0; globalThis.fetch = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return seq[Math.min(i++, seq.length - 1)]; }; };
const g = new GeminiAIProvider("k", "gemini-2.5-flash");
const base = { systemPrompt: "You are Siri from Leomox.", messages: [{ role: "user", content: "నమస్కారం" }], fallbackMessage: "FALLBACK" };

console.log("\n== Gemini request ==");
stub(ok("నమస్కారం!")); let r = await g.generateResponse({ ...base, context: "Leomox sells IT services", knowledgeOnly: true });
check("answer returned (not the fallback)", r.text === "నమస్కారం!" && !r.usedFallback);
check("thinking is disabled and the token budget leaves room for the answer (the 'always fallback' bug)", calls[0].body.generationConfig.thinkingConfig?.thinkingBudget === 0 && calls[0].body.generationConfig.maxOutputTokens >= 1024);
check("prompt asks for the customer's language", /same language/.test(calls[0].body.systemInstruction.parts[0].text));
stub(ok("x")); await new GeminiAIProvider("k", "gemini-2.5-pro").generateResponse({ ...base, context: "c" });
check("no thinkingConfig on models that do not support disabling it", !calls[0].body.generationConfig.thinkingConfig);

console.log("\n== No knowledge-base match ==");
stub(ok("Hello, I am Siri.")); r = await g.generateResponse({ ...base, context: "", knowledgeOnly: false });
check("a normal agent still answers from its prompt (greetings, small talk) instead of always returning the fallback", r.text === "Hello, I am Siri." && calls.length === 1 && /No knowledge-base passage matched/.test(calls[0].body.systemInstruction.parts[0].text));
stub(ok("never")); r = await g.generateResponse({ ...base, context: "", knowledgeOnly: true });
check("a knowledge-only agent returns the fallback WITHOUT calling the model", r.usedFallback && r.text === "FALLBACK" && calls.length === 0);
stub(ok("never")); r = await g.generateResponse({ ...base, systemPrompt: "", context: "", knowledgeOnly: false });
check("an agent with no prompt and no context also uses the fallback", r.usedFallback && calls.length === 0);

console.log("\n== Provider errors ==");
stub(reply(503, { error: "overloaded" }), ok("recovered")); r = await g.generateResponse({ ...base, context: "c" });
check("a transient 503 is retried once and succeeds", r.text === "recovered" && calls.length === 2);
stub(reply(200, { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }), ok("second try")); r = await g.generateResponse({ ...base, context: "c" });
check("an empty answer is retried once", r.text === "second try" && calls.length === 2);
stub(reply(400, { error: "API key not valid" })); let err; try { await g.generateResponse({ ...base, context: "c" }); } catch (e) { err = e; }
check("a permanent error (bad key) is thrown after one attempt, with the provider's reason", err && /400/.test(err.message) && calls.length === 1);
stub(reply(200, { promptFeedback: { blockReason: "SAFETY" }, candidates: [] })); r = await g.generateResponse({ ...base, context: "c" });
check("a safety-blocked reply returns the fallback and says why", r.usedFallback && /SAFETY/.test(r.error));

console.log("\n== Mock provider keeps working ==");
const m = new MockAIProvider();
check("mock: no context + knowledge-only -> fallback; with context -> grounded echo", (await m.generateResponse({ ...base, context: "" })).usedFallback && /Based on the knowledge base/.test((await m.generateResponse({ ...base, context: "abc" })).text));
globalThis.fetch = realFetch;
const { pass, fail, failures } = t.summary(); console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log("FAIL:", failures.join(" | ")); process.exit(1); } process.exit(0);
