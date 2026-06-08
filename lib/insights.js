/**
 * Session insights — reads Claude Code's /insights output (~/.claude/usage-data/facets/*.json,
 * one per session) and joins it to per-session token totals + project/date. Powers the
 * Outcomes/Helpfulness, Session-types, Recent-sessions, and Friction cards.
 *
 * Local-only (like Claude Code transcripts) → live locally, static snapshot on the cloud.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cache = require('./cache');
const { dayBucket } = require('./daybucket');

const FACETS_DIR = path.join(os.homedir(), '.claude', 'usage-data', 'facets');
const CACHE_KEY = 'insights';
const CACHE_TTL = 5 * 60 * 1000;

const ORDER = {
    outcome: ['fully_achieved', 'mostly_achieved', 'partially_achieved', 'unclear_from_transcript', 'not_achieved'],
    helpfulness: ['essential', 'very_helpful', 'moderately_helpful', 'unhelpful'],
    sessionType: ['multi_task', 'iterative_refinement', 'single_task', 'quick_question', 'exploration'],
    success: ['good_debugging', 'multi_file_changes', 'correct_code_edits', 'good_explanations', 'fast_accurate_search', 'none']
};

/**
 * @param claude  result of generateTokenUsage (has sessionTotals keyed by sessionId)
 * @param classified result of classifySessions (sessions keyed by sessionId → {project, startTime})
 */
function generateInsights(claude, classified, forceRefresh = false) {
    if (!fs.existsSync(FACETS_DIR)) return null;
    if (!forceRefresh) { const c = cache.get(CACHE_KEY); if (c) return c; }

    let files;
    try { files = fs.readdirSync(FACETS_DIR).filter(f => f.endsWith('.json')); } catch { return null; }
    if (!files.length) return null;

    const sessionTotals = (claude && claude.sessionTotals) || {};
    const meta = (classified && classified.sessions) || {};

    const counts = { outcome: {}, helpfulness: {}, sessionType: {}, satisfaction: {}, success: {} };
    const tokensByOutcome = {}, tokensByType = {};
    const friction = [], recent = [];
    let total = 0;

    for (const file of files) {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(FACETS_DIR, file), 'utf8')); } catch { continue; }
        const sid = d.session_id || file.replace(/\.json$/, '');
        const tokens = (sessionTotals[sid] && sessionTotals[sid].tokens) || 0;
        const m = meta[sid] || {};
        const date = m.startTime ? dayBucket(m.startTime)
            : (sessionTotals[sid] && sessionTotals[sid].firstDate) || '';
        const project = m.project || '';
        total++;

        const bump = (k, key) => { if (d[key]) counts[k][d[key]] = (counts[k][d[key]] || 0) + 1; };
        bump('outcome', 'outcome'); bump('helpfulness', 'claude_helpfulness');
        bump('sessionType', 'session_type'); bump('success', 'primary_success');
        if (d.outcome) tokensByOutcome[d.outcome] = (tokensByOutcome[d.outcome] || 0) + tokens;
        if (d.session_type) tokensByType[d.session_type] = (tokensByType[d.session_type] || 0) + tokens;
        for (const [k, v] of Object.entries(d.user_satisfaction_counts || {})) counts.satisfaction[k] = (counts.satisfaction[k] || 0) + v;

        if (d.friction_detail && d.friction_detail.trim()) {
            friction.push({ date, project, detail: d.friction_detail.trim(), tokens, sessionType: d.session_type || '' });
        }
        recent.push({
            date, project, tokens,
            summary: d.brief_summary || d.underlying_goal || '',
            outcome: d.outcome || '', helpfulness: d.claude_helpfulness || '', sessionType: d.session_type || ''
        });
    }

    friction.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    recent.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const landed = (counts.outcome.fully_achieved || 0) + (counts.outcome.mostly_achieved || 0);
    const helpful = (counts.helpfulness.very_helpful || 0) + (counts.helpfulness.essential || 0);

    const result = {
        generatedAt: new Date().toISOString(), available: true, total,
        counts, tokensByOutcome, tokensByType, order: ORDER,
        landedPct: +(100 * landed / Math.max(total, 1)).toFixed(0),
        helpfulPct: +(100 * helpful / Math.max(total, 1)).toFixed(0),
        frictionCount: friction.length,
        friction: friction.slice(0, 12),
        recent: recent.slice(0, 24)
    };
    cache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
}

module.exports = { generateInsights };
