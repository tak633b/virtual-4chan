// Central configuration. Reads an optional ./.env (no dependency) then exposes
// typed constants used across the app.
import { readFileSync, existsSync } from 'node:fs';

// --- tiny .env loader (KEY=VALUE per line, # comments) ---------------------
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

export const LM_BASE_URL = process.env.LM_BASE_URL || 'http://127.0.0.1:1234/v1';
export const MODEL = process.env.MODEL || 'qwen-agentworld-35b-a3b-oq4-mlx';
export const PORT = Number(process.env.PORT || 3000);
export const DB_PATH = process.env.DB_PATH || './world.db';

// The model's knowledge cutoff — anchors the simulated web to a believable era.
export const KNOWLEDGE_CUTOFF = 'October 2024';

// Bump to mint a fresh universe; old pages remain under the old epoch key.
export const WORLD_EPOCH = process.env.WORLD_EPOCH || 'v1';

// Thinking mode. qwen-agentworld is a Language World Model (arXiv:2606.24597) whose
// long chain-of-thought IS its next-state-prediction / simulation mechanism — SFT was
// designed to put it in "thinking" mode, and suppressing it reverts to the weaker
// non-thinking regime (lower factuality/consistency). We default OFF for a snappy
// browse demo (the prefill kill-switch), but THINKING=on is the higher-fidelity mode:
// the model reasons (streamed to the loading ticker) then emits the page; we keep only
// the final content. It roughly doubles first-visit latency; revisits are cached either way.
export const THINKING = /^(on|1|true|yes)$/i.test(process.env.THINKING || 'off');

// Token budgets. Thinking is a runtime setting, so we expose both variants and the
// server picks per request. Thinking needs headroom for the reasoning trace AND the page.
export const PAGE_TOKENS_FAST = Number(process.env.PAGE_MAX_TOKENS || 6000);
export const PAGE_TOKENS_THINK = Number(process.env.PAGE_MAX_TOKENS_THINK || 12000);
export const SERP_TOKENS = Number(process.env.SERP_MAX_TOKENS || 2400);

// Hard ceiling on a single generation before we give up. Thinking needs a much larger
// ceiling: a rich page with full reasoning can run minutes at local speeds, and an early
// abort would waste the whole reasoning trace.
export const GEN_TIMEOUT_FAST = Number(process.env.GEN_TIMEOUT_MS || 240_000);
export const GEN_TIMEOUT_THINK = Number(process.env.GEN_TIMEOUT_MS_THINK || 600_000);
