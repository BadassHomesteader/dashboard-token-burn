/**
 * Claude Code Token Usage Service
 * Scans ~/.claude/projects/ JSONL session files and returns aggregated token usage.
 * Works locally only — on Azure, returns null (frontend falls back to static file).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const cache = require('./cache');
const { dayBucket } = require('./daybucket');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CACHE_KEY = 'token-usage';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const MODEL_MAP = {
    'claude-opus-4-6': 'opus',
    'claude-opus-4-5-20251101': 'opus-4.5',
    'claude-sonnet-4-6-20250828': 'sonnet',
    'claude-sonnet-4-5-20250929': 'sonnet',
    'claude-sonnet-4-5-20241022': 'sonnet',
    'claude-haiku-4-5-20251001': 'haiku',
};

function normalizeModel(model) {
    if (!model) return 'unknown';
    if (MODEL_MAP[model]) return MODEL_MAP[model];
    const match = model.match(/claude-(\w+)/);
    return match ? match[1] : 'unknown';
}

function findJsonlFiles(dir) {
    const files = [];
    function walk(d) {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.jsonl')) files.push(full);
        }
    }
    walk(dir);
    return files;
}

async function processFile(filePath, dailyMap, sessionsByDate, modelTotals, sessionTotals) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', (line) => {
            if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) return;

            let obj;
            try { obj = JSON.parse(line); } catch { return; }
            if (obj.type !== 'assistant') return;

            const usage = obj.message?.usage;
            if (!usage) return;

            const timestamp = obj.timestamp;
            if (!timestamp) return;

            const date = dayBucket(timestamp); // local-timezone day
            const model = normalizeModel(obj.message?.model);
            const sessionId = obj.sessionId;

            const input = usage.input_tokens || 0;
            const output = usage.output_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;
            const cacheCreation = usage.cache_creation_input_tokens || 0;

            if (!dailyMap[date]) {
                dailyMap[date] = {
                    date, inputTokens: 0, outputTokens: 0,
                    cacheReadTokens: 0, cacheCreationTokens: 0,
                    messages: 0, models: {}
                };
            }
            const day = dailyMap[date];
            day.inputTokens += input;
            day.outputTokens += output;
            day.cacheReadTokens += cacheRead;
            day.cacheCreationTokens += cacheCreation;
            day.messages += 1;

            if (!day.models[model]) {
                day.models[model] = { inputTokens: 0, outputTokens: 0, messages: 0 };
            }
            day.models[model].inputTokens += input + cacheRead + cacheCreation;
            day.models[model].outputTokens += output;
            day.models[model].messages += 1;

            if (!sessionsByDate[date]) sessionsByDate[date] = new Set();
            if (sessionId) sessionsByDate[date].add(sessionId);

            if (!modelTotals[model]) {
                modelTotals[model] = { inputTokens: 0, outputTokens: 0, messages: 0 };
            }
            modelTotals[model].inputTokens += input + cacheRead + cacheCreation;
            modelTotals[model].outputTokens += output;
            modelTotals[model].messages += 1;

            // Per-session totals (used by the Token Burn driver join; harmless extra field otherwise)
            if (sessionTotals && sessionId) {
                if (!sessionTotals[sessionId]) {
                    sessionTotals[sessionId] = { tokens: 0, outputTokens: 0, messages: 0, firstDate: date, model };
                }
                const st = sessionTotals[sessionId];
                st.tokens += input + output + cacheRead + cacheCreation;
                st.outputTokens += output;
                st.messages += 1;
                if (date < st.firstDate) st.firstDate = date;
            }
        });

        rl.on('close', resolve);
        rl.on('error', resolve);
    });
}

function getISOWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const yearStart = new Date(d.getFullYear(), 0, 4);
    yearStart.setDate(yearStart.getDate() + 3 - ((yearStart.getDay() + 6) % 7));
    const weekNum = Math.round((d - yearStart) / (7 * 86400000)) + 1;
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function aggregateDays(days) {
    const result = {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        messages: 0, sessions: 0
    };
    for (const d of days) {
        result.inputTokens += d.inputTokens;
        result.outputTokens += d.outputTokens;
        result.cacheReadTokens += d.cacheReadTokens;
        result.cacheCreationTokens += d.cacheCreationTokens;
        result.messages += d.messages;
        result.sessions += d.sessions || 0;
    }
    return result;
}

function buildPeriods(dailyArray) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);
    const thisMonth = todayStr.slice(0, 7);
    const thisYear = todayStr.slice(0, 4);
    const currentWeek = getISOWeek(todayStr);

    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonth = prevMonthDate.toISOString().slice(0, 7);
    const prevYear = String(parseInt(thisYear) - 1);
    const prevWeekDate = new Date(now - 7 * 86400000);
    const prevWeek = getISOWeek(prevWeekDate.toISOString().slice(0, 10));

    const byDate = {};
    for (const d of dailyArray) byDate[d.date] = d;

    const today = byDate[todayStr] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0, sessions: 0 };
    const yesterday = byDate[yesterdayStr] || null;

    const thisWeekDays = dailyArray.filter(d => getISOWeek(d.date) === currentWeek);
    const prevWeekDays = dailyArray.filter(d => getISOWeek(d.date) === prevWeek);
    const thisMonthDays = dailyArray.filter(d => d.date.startsWith(thisMonth));
    const prevMonthDays = dailyArray.filter(d => d.date.startsWith(prevMonth));
    const thisYearDays = dailyArray.filter(d => d.date.startsWith(thisYear));
    const prevYearDays = dailyArray.filter(d => d.date.startsWith(prevYear));

    return {
        today: { ...today, prev: yesterday },
        thisWeek: { ...aggregateDays(thisWeekDays), prev: aggregateDays(prevWeekDays) },
        thisMonth: { ...aggregateDays(thisMonthDays), prev: aggregateDays(prevMonthDays) },
        thisYear: { ...aggregateDays(thisYearDays), prev: prevYearDays.length ? aggregateDays(prevYearDays) : null }
    };
}

function computeAverages(dailyArray) {
    const now = new Date();
    const cutoff30 = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
    const last30 = dailyArray.filter(d => d.date >= cutoff30 && d.messages > 0);
    if (last30.length === 0) return null;

    const agg = aggregateDays(last30);
    const days = last30.length;
    const msgs = agg.messages;

    return {
        days,
        perDay: {
            messages: Math.round(msgs / days),
            inputTokens: Math.round(agg.inputTokens / days),
            outputTokens: Math.round(agg.outputTokens / days),
            cacheReadTokens: Math.round(agg.cacheReadTokens / days),
            sessions: Math.round(agg.sessions / days)
        },
        perMessage: {
            inputTokens: Math.round(agg.inputTokens / msgs),
            outputTokens: Math.round(agg.outputTokens / msgs),
            cacheReadTokens: Math.round(agg.cacheReadTokens / msgs)
        }
    };
}

async function generateTokenUsage(forceRefresh = false) {
    if (!fs.existsSync(CLAUDE_DIR)) return null;

    if (!forceRefresh) {
        const cached = cache.get(CACHE_KEY);
        if (cached) return cached;
    }

    const files = findJsonlFiles(CLAUDE_DIR);
    const dailyMap = {};
    const sessionsByDate = {};
    const modelTotals = {};
    const sessionTotals = {};

    for (const file of files) {
        await processFile(file, dailyMap, sessionsByDate, modelTotals, sessionTotals);
    }

    for (const [date, sessions] of Object.entries(sessionsByDate)) {
        if (dailyMap[date]) dailyMap[date].sessions = sessions.size;
    }

    const dailyArray = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    const totals = aggregateDays(dailyArray);
    const periods = buildPeriods(dailyArray);

    const averages = computeAverages(dailyArray);

    const result = {
        generatedAt: new Date().toISOString(),
        totals,
        modelTotals,
        periods,
        averages,
        daily: dailyArray,
        sessionTotals
    };

    cache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
}

module.exports = { generateTokenUsage };
