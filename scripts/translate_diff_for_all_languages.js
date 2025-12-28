#!/usr/bin/env node
'use strict';

/**
 * translate_diff_for_all_languages.js
 *
 * Expected layout:
 *   <projectRoot>/
 *     build/languages/
 *       EN.json
 *       HI.json
 *       ES.json
 *       ...
 *       updated.json   (or update.json)  <-- new English updates
 *     scripts/
 *       .env  (gitignored; contains XAI_KEY=...)
 *       translate_diff_for_all_languages.js
 *
 * Run:
 *   node translate_diff_for_all_languages.js
 */

const fs = require('fs');
const path = require('path');

// ------------------------------
// Config
// ------------------------------

const LANGUAGE_OPTIONS = {
  en: 'English',
  hi: 'हिन्दी',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  zh: '中文 (简体)',
  ja: '日本語',
  ru: 'Русский',
  pt: 'Português',
  ar: 'العربية',
  bn: 'বাংলা',
  ko: '한국어',
  it: 'Italiano',
  nl: 'Nederlands',
  sv: 'Svenska',
  tr: 'Türkçe',
  pl: 'Polski',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
};

// IMPORTANT: Grok 4 Fast Reasoning model name on xAI API
const XAI_MODEL = 'grok-4-fast-reasoning';

// OpenAI-compatible Chat Completions endpoint on xAI
const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

const EXCLUDED_TOP_LEVEL_SECTIONS = new Set(['languageOptions']); // as requested

// Chunking: if a diff section is huge, we split by top-level keys in that section
const CHUNK_CHAR_LIMIT = 14000;

// ------------------------------
// Small utilities
// ------------------------------

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeText(p, s) {
  fs.writeFileSync(p, s, 'utf8');
}

function loadJson(p) {
  const raw = readText(p);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse JSON: ${p}\n${e.message}`);
  }
}

function saveJsonPretty(p, obj) {
  const s = JSON.stringify(obj, null, 4) + '\n';
  writeText(p, s);
}

// Minimal .env loader (no deps)
function loadEnvFromDotEnv(dotEnvPath) {
  if (!fileExists(dotEnvPath)) return;
  const lines = readText(dotEnvPath).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    // strip optional quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

// Deep-merge: objects merge recursively, other types overwrite
function deepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    const out = { ...target };
    for (const [k, v] of Object.entries(source)) {
      if (k in out) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  return deepClone(source);
}

/**
 * Compute "diff object" that contains keys where updated differs from base,
 * plus keys that are new in updated. Ignores deletions (keys missing in updated).
 */
function diffObject(updated, base) {
  // If base missing entirely => whole updated is new
  if (base === undefined) return deepClone(updated);

  // If types differ or primitives differ => replace
  if (!isPlainObject(updated) || !isPlainObject(base)) {
    // Includes arrays, strings, numbers, booleans, null
    if (JSON.stringify(updated) !== JSON.stringify(base)) return deepClone(updated);
    return undefined;
  }

  // Both plain objects => recurse
  const out = {};
  for (const key of Object.keys(updated)) {
    const d = diffObject(updated[key], base[key]);
    if (d !== undefined) out[key] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Top-level section diffs: { sectionName: diffSubtree }
 */
function computeSectionDiffs(updatedEn, baseEn) {
  const diffs = {};
  for (const key of Object.keys(updatedEn)) {
    if (EXCLUDED_TOP_LEVEL_SECTIONS.has(key)) continue;
    const d = diffObject(updatedEn[key], baseEn[key]);
    if (d !== undefined) diffs[key] = d;
  }
  return diffs;
}

/**
 * Pick from obj only keys existing in "shape" (recursive).
 * Useful to provide only relevant existing translations as reference.
 */
function pickByShape(obj, shape) {
  if (obj === undefined) return undefined;
  if (!isPlainObject(shape) || !isPlainObject(obj)) return deepClone(obj);

  const out = {};
  for (const k of Object.keys(shape)) {
    if (obj[k] === undefined) continue;
    const picked = pickByShape(obj[k], shape[k]);
    if (picked !== undefined) out[k] = picked;
  }
  return out;
}

/**
 * Split a large object by its immediate keys into chunks under a size limit.
 * Only used for a section diff (which is typically a plain object).
 */
function splitObjectByTopKeys(obj, charLimit) {
  if (!isPlainObject(obj)) return [obj];

  const entries = Object.entries(obj);
  if (!entries.length) return [obj];

  const chunks = [];
  let current = {};
  let currentSize = 2; // {}
  for (const [k, v] of entries) {
    const candidate = { ...current, [k]: v };
    const candidateSize = JSON.stringify(candidate).length;
    if (candidateSize > charLimit && Object.keys(current).length > 0) {
      chunks.push(current);
      current = { [k]: v };
      currentSize = JSON.stringify(current).length;
    } else {
      current = candidate;
      currentSize = candidateSize;
    }
  }
  if (Object.keys(current).length) chunks.push(current);
  return chunks;
}

/**
 * Extract JSON object from model output that might accidentally include text.
 */
function parseJsonLoose(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty model response');

  // Fast path: direct JSON
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // Attempt to find first { ... last }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      return JSON.parse(candidate);
    }
    throw new Error('Model did not return valid JSON');
  }
}

// ------------------------------
// Prompt builder
// ------------------------------

function buildSectionPrompt({
  targetLangCode,
  targetLangName,
  sectionName,
  diffEn,
  existingTargetForDiff,
}) {
  // Keep it extremely explicit: JSON-only output.
  return [
    `You are an expert translator for Electron app UI JSON.`,
    ``,
    `Task: Translate ONLY the English strings in the JSON diff for ONE section.`,
    `Target language: ${targetLangName} (${targetLangCode}).`,
    ``,
    `Rules (must follow):`,
    `- Output MUST be valid JSON only (no markdown, no commentary, no code fences).`,
    `- Keep ALL JSON keys exactly unchanged. Translate ONLY string VALUES.`,
    `- Preserve placeholders exactly: {likeThis}, {{likeThis}}, %s, $1, etc.`,
    `- Preserve HTML tags/attributes and entities exactly; translate only user-visible text within them.`,
    `- Preserve punctuation, whitespace, and line breaks unless the target language requires a minimal tweak.`,
    `- Do NOT translate brand/model/product names: "AI Diff Tool", "Grok", "OpenAI", "xAI".`,
    `- Audience: young coders. Prefer commonly used terms; if no good equivalent, transliterate. Mixed transliteration is OK.`,
    `- Return the same JSON shape as diff_en (same nesting, same keys).`,
    ``,
    `Section name: ${sectionName}`,
    ``,
    `existing_target (reference only; may be partial):`,
    `${JSON.stringify(existingTargetForDiff || {}, null, 2)}`,
    ``,
    `diff_en (translate this):`,
    `${JSON.stringify(diffEn, null, 2)}`,
    ``,
    `Now output ONLY the translated JSON for diff_en.`,
  ].join('\n');
}

const SYSTEM_PROMPT = `You translate app UI JSON diffs. You output JSON only.`;

// ------------------------------
// xAI API call
// ------------------------------

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function xaiChatCompletion({ apiKey, prompt, model = XAI_MODEL }) {
  if (typeof fetch !== 'function') {
    throw new Error(
      `Global fetch() is not available in this Node version. Use Node 18+ (recommended) or polyfill fetch.`
    );
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const res = await fetch(XAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`xAI API error ${res.status}: ${text.slice(0, 5000)}`);
    }
    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content ?? '';
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function xaiChatCompletionWithRetry({ apiKey, prompt, model, retries = 4 }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await xaiChatCompletion({ apiKey, prompt, model });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable =
        msg.includes('429') ||
        msg.toLowerCase().includes('rate') ||
        msg.toLowerCase().includes('timeout') ||
        msg.toLowerCase().includes('temporarily') ||
        msg.toLowerCase().includes('overloaded');

      if (!retryable || attempt === retries) break;

      const backoff = 1200 * Math.pow(2, attempt);
      console.warn(`  ↻ retrying in ${backoff}ms (attempt ${attempt + 1}/${retries})…`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ------------------------------
// Main
// ------------------------------

async function main() {
  const scriptsDir = __dirname;
  const projectRoot = path.join(scriptsDir, '..');
  const languagesDir = path.join(projectRoot, 'build', 'languages');

  // Load .env from scripts folder
  loadEnvFromDotEnv(path.join(scriptsDir, '.env'));
  const apiKey = process.env.XAI_KEY;

  if (!apiKey) {
    console.error(`Missing XAI_KEY. Put XAI_KEY=<key> in scripts/.env (gitignored).`);
    process.exit(1);
  }

  const enPath = path.join(languagesDir, 'EN.json');
  if (!fileExists(enPath)) {
    console.error(`Missing EN.json at: ${enPath}`);
    process.exit(1);
  }

  // updated.json (or update.json) lives alongside EN.json
  const updatedCandidates = ['updated.json', 'update.json'];
  const updatedPath = updatedCandidates
    .map((f) => path.join(languagesDir, f))
    .find((p) => fileExists(p));

  if (!updatedPath) {
    console.error(
      `Missing updated.json/update.json in: ${languagesDir}\nExpected one of: ${updatedCandidates.join(', ')}`
    );
    process.exit(1);
  }

  const baseEn = loadJson(enPath);
  const updatedEn = loadJson(updatedPath);

  const sectionDiffs = computeSectionDiffs(updatedEn, baseEn);
  const diffSections = Object.keys(sectionDiffs);

  if (!diffSections.length) {
    console.log(`No diffs found between ${path.basename(updatedPath)} and EN.json (excluding languageOptions).`);
    process.exit(0);
  }

  console.log(`Found diffs in sections: ${diffSections.join(', ')}`);

  const languages = Object.keys(LANGUAGE_OPTIONS).filter((c) => c !== 'en');
  const perLanguageFailures = [];

  for (const langCode of languages) {
    const langName = LANGUAGE_OPTIONS[langCode] || langCode;
    const langFile = path.join(languagesDir, `${langCode.toUpperCase()}.json`);

    console.log(`\n=== ${langCode} (${langName}) → ${path.basename(langFile)} ===`);

    let targetJson = {};
    if (fileExists(langFile)) {
      targetJson = loadJson(langFile);
    } else {
      console.warn(`  ! ${path.basename(langFile)} not found. Creating a new one from scratch.`);
      targetJson = {};
    }

    try {
      for (const sectionName of diffSections) {
        const diffEnSection = sectionDiffs[sectionName];

        // Provide only relevant existing translations as reference
        const existingSection = targetJson[sectionName];
        const existingForDiff = pickByShape(existingSection, diffEnSection);

        // Chunk if needed
        const chunks = splitObjectByTopKeys(diffEnSection, CHUNK_CHAR_LIMIT);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const existingForChunk = pickByShape(existingSection, chunk);

          console.log(
            `  • Translating section "${sectionName}"${chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : ''}…`
          );

          const prompt = buildSectionPrompt({
            targetLangCode: langCode,
            targetLangName: langName,
            sectionName,
            diffEn: chunk,
            existingTargetForDiff: existingForChunk || {},
          });

          const raw = await xaiChatCompletionWithRetry({
            apiKey,
            prompt,
            model: XAI_MODEL,
            retries: 4,
          });

          const translatedChunk = parseJsonLoose(raw);

          // Merge into target JSON
          const currentSection = targetJson[sectionName] ?? {};
          targetJson[sectionName] = deepMerge(currentSection, translatedChunk);
        }
      }

      // Save language file
      saveJsonPretty(langFile, targetJson);
      console.log(`  ✓ Saved ${path.basename(langFile)}`);
    } catch (e) {
      console.error(`  ✗ Failed ${langCode}: ${e.message}`);
      perLanguageFailures.push({ langCode, langName, error: e.message });
      // continue to next language (do not overwrite EN.json if any fail)
    }
  }

  if (perLanguageFailures.length) {
    console.error(`\nSome languages failed. EN.json will NOT be overwritten.`);
    for (const f of perLanguageFailures) {
      console.error(`- ${f.langCode} (${f.langName}): ${f.error}`);
    }
    process.exit(2);
  }

  // All languages succeeded → overwrite EN.json with updated.json
  saveJsonPretty(enPath, updatedEn);
  console.log(`\n✓ All languages updated. Overwrote EN.json with ${path.basename(updatedPath)}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`Fatal: ${e?.message || e}`);
  process.exit(1);
});
