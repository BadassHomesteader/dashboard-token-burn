/**
 * Codex CLI Token Usage Service
 * Scans ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files and returns daily token usage.
 * Works locally only — on Azure, returns null (frontend falls back to the static token-burn file).
 *
 * Each rollout file is an event stream. Token usage arrives as event_msg / token_count events:
 *   payload.info.total_token_usage  -> cumulative running total for the session
 *   payload.info.last_token_usage   -> delta for that single turn
 * We sum the per-turn deltas bucketed by the event's own date, so a session that crosses
 * midnight is attributed to the correct days. (total_tokens = input_tokens + output_tokens;
 * input_tokens already includes cached_input_tokens.)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const cache = require('./cache');

const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CACHE_KEY = 'codex-usage';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function findRolloutFiles(dir) {
    const files = [];
    function walk(d) {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(full);
        }
    }
    walk(dir);
    return files;
}

async function processFile(filePath, dailyMap, sessionIds, sessionId) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let sawTokens = false;

        rl.on('line', (line) => {
            if (!line.includes('token_count')) return;

            let obj;
            try { obj = JSON.parse(line); } catch { return; }
            const payload = obj.payload;
            if (!payload || payload.type !== 'token_count') return;

            const last = payload.info && payload.info.last_token_usage;
            if (!last) return;

            const timestamp = obj.timestamp;
            if (!timestamp) return;
            const date = timestamp.slice(0, 10);

            const input = last.input_tokens || 0;        // includes cached_input_tokens
            const output = last.output_tokens || 0;       // includes reasoning_output_tokens
            const cached = last.cached_input_tokens || 0;
            const total = (typeof last.total_tokens === 'number') ? last.total_tokens : (input + output);

            if (!dailyMap[date]) {
                dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, total: 0, messages: 0, sessions: 0 };
            }
            const day = dailyMap[date];
            day.inputTokens += input;
            day.outputTokens += output;
            day.cachedInputTokens += cached;
            day.total += total;
            day.messages += 1;

            if (!sessionIds[date]) sessionIds[date] = new Set();
            sessionIds[date].add(sessionId);
            sawTokens = true;
        });

        rl.on('close', () => resolve(sawTokens));
        rl.on('error', () => resolve(sawTokens));
    });
}

/**
 * Returns { generatedAt, available, totals, daily[], sessions } or null when no Codex data exists.
 */
async function generateCodexUsage(forceRefresh = false) {
    if (!fs.existsSync(CODEX_DIR)) return null;

    if (!forceRefresh) {
        const cached = cache.get(CACHE_KEY);
        if (cached) return cached;
    }

    const files = findRolloutFiles(CODEX_DIR);
    if (files.length === 0) return null;

    const dailyMap = {};
    const sessionIds = {};

    for (const file of files) {
        // session id = the uuid embedded in the rollout filename
        const m = file.match(/rollout-[\dT-]+-([0-9a-f-]+)\.jsonl$/i);
        const sessionId = m ? m[1] : path.basename(file);
        await processFile(file, dailyMap, sessionIds, sessionId);
    }

    for (const [date, set] of Object.entries(sessionIds)) {
        if (dailyMap[date]) dailyMap[date].sessions = set.size;
    }

    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    const totals = daily.reduce((acc, d) => {
        acc.inputTokens += d.inputTokens;
        acc.outputTokens += d.outputTokens;
        acc.cachedInputTokens += d.cachedInputTokens;
        acc.total += d.total;
        acc.messages += d.messages;
        return acc;
    }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, total: 0, messages: 0 });

    const allSessions = new Set();
    for (const set of Object.values(sessionIds)) for (const s of set) allSessions.add(s);

    const result = {
        generatedAt: new Date().toISOString(),
        available: true,
        totals,
        sessions: allSessions.size,
        daily
    };

    cache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
}

module.exports = { generateCodexUsage };
