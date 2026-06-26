# 🍀 virtual-4chan

**A 4chan-shaped anonymous imageboard, hallucinated on the fly by a local language world model. Click a board → it writes the catalog. Click a thread → it writes the posts. Click any link inside → it writes the next page. Forever.**

Type a board path, get a catalog. Open a thread, get an OP + 30–80 replies — greentext, quotelinks, IDs, image placeholders, the lot. Every link goes through `/view`; every link inside every generated page recurses into a new generation. Nothing is ever fetched from the real 4chan; the entire site is generated, click by click, by one local model — and it persists in SQLite as you browse.

Powered by **[Qwen-AgentWorld-35B-A3B](https://arxiv.org/abs/2606.24597)** — not a chat model, but a *Language World Model* trained to predict `(state, action) → next observation` across 7 domains, two of which are **Web** and **Search**. This app drives it exactly where it lives: search via its `web_search` behavior, pages via its `Web` world-model behavior (predict the next browser state *as HTML*, then render it).

It is a sibling of **[qwen-agentworld-35b-a3b-web-simulator](https://github.com/hanxiao/qwen-agentworld-35b-a3b-web-simulator)** (LLM-as-Internet) — the same engine, narrowed to one site.

## Run

Needs **Node 20+** and an OpenAI-compatible endpoint serving the model. Easiest path: **[LM Studio](https://lmstudio.ai)** → load `qwen-agentworld-35b-a3b` → turn on the local server.

```bash
npm install
npm run dev          # → http://localhost:3000
```

Pick a board, then start clicking.

## Use any endpoint

Not running the model locally? Open **⚙ Settings** and point the app at any OpenAI-compatible API — your own server, Ollama, OpenRouter, OpenAI — no restart needed.

## How it works

- **One model, three jobs.** `/search` simulates a chan-archive `web_search` (structured JSON results across boards); `/view` asks the world model to predict the destination page as a complete HTML document; [`rewrite.ts`](src/rewrite.ts) rewrites every `<a href>` to `/view?url=…` (carrying the anchor text as context) so any click recurses. Scripts are stripped, images become placeholders, pages render in a sandboxed iframe.
- **The cache is the world.** Pages persist in SQLite (built-in `node:sqlite`) — a URL, once visited, stays byte-identical across revisits and restarts. Browsing *accretes* a consistent universe.
- **Thinking.** The model's chain-of-thought *is* its simulation mechanism — but at ~30 tok/s locally it crowds out the page's token budget, so we suppress it by default (an assistant-prefill kill-switch) and stream fast. `THINKING=on` is an honest, inspectable opt-in; see [`.env.example`](.env.example).

~1100 lines of TypeScript, two dependencies (`fastify`, `node-html-parser`). No build step.

## The simulated boards

The home lists the real 4chan board codes grouped into the canonical categories (Japanese Culture, Video Games, Interests, Creative, Other). The model is conditioned per-board to match voice: `/g/` is technical-snarky, `/v/` is video-game flamewars, `/lit/` is pretentious-literary, `/mu/` is genre snobbery, `/fit/` is gym + mogging, `/ck/` is recipes, `/sci/` is Q&A, `/biz/` is crypto-pumping, etc. The prompt explicitly **bans slurs, calls to violence, and harassment of real people**; chan voice is preserved without the bigotry.

## Content notes

This generates fictional posts in the shape of a 4chan thread. The system prompt has explicit guardrails: no slurs, no doxxing, no real-people attacks. The model also has its own safety training. Output is still LLM output — it can be weird, repetitive, or off-tone, and revisiting a cached URL gives you the same bytes (seed-stable), so if you find a bad page, delete `world.db` and start over.

## Links

- 📄 Paper — **Qwen-AgentWorld: Language World Models for General Agents** · [arXiv:2606.24597](https://arxiv.org/abs/2606.24597)
- 🧠 Model — `qwen-agentworld-35b-a3b` (search *"agentworld"* in LM Studio)
- 🔌 Local runtime — [LM Studio](https://lmstudio.ai)
- 🌐 Sibling — [qwen-agentworld-35b-a3b-web-simulator](https://github.com/hanxiao/qwen-agentworld-35b-a3b-web-simulator) (LLM-as-Internet)

## License

MIT
