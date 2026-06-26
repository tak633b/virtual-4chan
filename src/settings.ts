// Runtime-mutable settings, persisted in the world DB so they survive restarts and can be
// changed from the /settings page WITHOUT editing .env or restarting. Defaults come from
// config.ts (i.e. env / .env). This is what lets someone point the app at a remote endpoint
// (their own server, OpenRouter, etc.) instead of the local LM Studio.
import { getSetting, setSetting } from './cache';
import { LM_BASE_URL, MODEL, THINKING } from './config';

export interface Settings {
  baseUrl: string;   // OpenAI-compatible base, e.g. http://127.0.0.1:1234/v1
  model: string;     // model id to request
  apiKey: string;    // bearer token (ignored by LM Studio; required by hosted providers)
  thinking: boolean; // let the world model reason before emitting (slower, see README)
}

const DEFAULTS: Settings = { baseUrl: LM_BASE_URL, model: MODEL, apiKey: 'lm-studio', thinking: THINKING };

let current: Settings = load();

function load(): Settings {
  const raw = getSetting('config');
  if (!raw) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(raw) }; } catch { return { ...DEFAULTS }; }
}

export function getSettings(): Settings { return current; }

export function updateSettings(patch: Partial<Settings>): Settings {
  // The /settings form is write-only for apiKey (it never echoes the stored value),
  // so an empty-string submission means "keep what you have". An explicit null or
  // a literal "default" clears it back to the default. This pairs with the form's
  // "leave blank to keep" placeholder to make accidental clears impossible.
  const apiKeyPatch = patch.apiKey == null ? undefined : patch.apiKey.trim();
  const newApiKey = apiKeyPatch === undefined || apiKeyPatch === '' ? current.apiKey : apiKeyPatch;
  current = {
    baseUrl: (patch.baseUrl ?? current.baseUrl).trim() || DEFAULTS.baseUrl,
    model: (patch.model ?? current.model).trim() || DEFAULTS.model,
    apiKey: newApiKey || DEFAULTS.apiKey,
    thinking: patch.thinking ?? current.thinking,
  };
  setSetting('config', JSON.stringify(current));
  return current;
}

export function defaultSettings(): Settings { return { ...DEFAULTS }; }
