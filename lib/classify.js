/**
 * Work Classifier
 * Reads ~/.claude/usage-data/session-meta/*.json (one file per Claude Code session, filename = sessionId)
 * and classifies each session into a "work family" plus an assistant-vs-computer-work flag.
 *
 *   assistant work  = conversational / Q&A / research — no artifacts produced
 *   computer work   = transformative delegation — edits, commits, automation, agent runs
 *
 * Token volume is NOT in these files in a comparable way (session-meta input/output excludes cache),
 * so the caller joins these classifications to real per-session token totals from the transcript pass
 * (sessionId is the join key). This module only decides the *label* for each session.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cache = require('./cache');

const META_DIR = path.join(os.homedir(), '.claude', 'usage-data', 'session-meta');
const CACHE_KEY = 'work-classify';
const CACHE_TTL = 5 * 60 * 1000;

// Family display order / canonical keys
const FAMILIES = {
    coding: { label: 'Coding', kind: 'computer' },
    debugging: { label: 'Debugging', kind: 'computer' },
    automation: { label: 'Automation / n8n', kind: 'computer' },
    ops: { label: 'Ops / Deploy', kind: 'computer' },
    writing: { label: 'Writing', kind: 'computer' },
    research: { label: 'Research / Web', kind: 'assistant' },
    qa: { label: 'Q&A / Assistant', kind: 'assistant' },
    other: { label: 'Other', kind: 'assistant' }
};

function toolHas(tools, ...names) {
    if (!tools) return false;
    return names.some(n => (tools[n] || 0) > 0);
}

function toolCount(tools, ...names) {
    if (!tools) return 0;
    return names.reduce((s, n) => s + (tools[n] || 0), 0);
}

/**
 * Decide the family + kind for a single session-meta object.
 */
function classifyOne(meta) {
    const tools = meta.tool_counts || {};
    const prompt = (meta.first_prompt || '').toLowerCase();
    const project = (meta.project_path || '').toLowerCase();
    const edits = toolCount(tools, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit');
    const produced = edits > 0 || (meta.files_modified || 0) > 0 ||
        (meta.lines_added || 0) > 0 || (meta.git_commits || 0) > 0;
    const hasLangs = meta.languages && Object.keys(meta.languages).length > 0;

    const fixFlavored = /\b(debug|fix|error|broken|failing|bug|crash|why (is|does|isn|won))/.test(prompt);
    const deployFlavored = /\b(deploy|publish|ship|release|provision|rollback|hosting)\b/.test(prompt);
    const lightAuthoring = edits < 3 && (meta.lines_added || 0) < 50 && (meta.files_modified || 0) < 3;

    // Order matters: authored code should win over a stray push. Reserve "ops" for sessions that
    // are *about* deploying with little code authored.
    let family;
    if (meta.uses_mcp && (/n8n|workflow|automat/.test(prompt) || /n8n/.test(project))) {
        family = 'automation';
    } else if (produced || hasLangs || edits > 0) {
        if (fixFlavored) family = 'debugging';
        else if (deployFlavored && lightAuthoring) family = 'ops';
        else family = 'coding';
    } else if ((meta.git_pushes || 0) > 0 || deployFlavored) {
        family = 'ops';
    } else if (fixFlavored) {
        family = 'debugging';
    } else if (meta.uses_web_search || meta.uses_web_fetch ||
               toolHas(tools, 'WebSearch', 'WebFetch') ||
               /\b(research|find|look up|compare|what is|how (do|does|can)|explain)/.test(prompt)) {
        family = 'research';
    } else if (/\b(write|draft|story|copy|blog|post|email|summari[sz]e|rewrite)/.test(prompt)) {
        family = 'writing';
    } else if (Object.keys(tools).length === 0) {
        family = 'qa';
    } else {
        family = 'other';
    }

    return { family, kind: FAMILIES[family].kind };
}

function evidenceFor(meta) {
    const bits = [];
    const tools = meta.tool_counts || {};
    if ((meta.files_modified || 0) > 0) bits.push(`${meta.files_modified} files`);
    const net = (meta.lines_added || 0) + (meta.lines_removed || 0);
    if (net > 0) bits.push(`${meta.lines_added || 0}+/${meta.lines_removed || 0}- lines`);
    if ((meta.git_commits || 0) > 0) bits.push(`${meta.git_commits} commit${meta.git_commits > 1 ? 's' : ''}`);
    if ((meta.git_pushes || 0) > 0) bits.push(`${meta.git_pushes} push${meta.git_pushes > 1 ? 'es' : ''}`);
    const topTools = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k}×${v}`);
    if (topTools.length) bits.push(topTools.join(' '));
    const langs = meta.languages ? Object.keys(meta.languages) : [];
    if (langs.length) bits.push(`langs: ${langs.slice(0, 3).join(', ')}`);
    if (meta.uses_web_search || meta.uses_web_fetch) bits.push('web');
    if (meta.uses_mcp) bits.push('mcp');
    if (meta.uses_task_agent) bits.push('agents');
    return bits.join(' · ');
}

/**
 * Returns { generatedAt, available, sessions: { [sessionId]: {family, kind, project, firstPrompt, evidence} } }
 * or null when no session-meta directory exists.
 */
function classifySessions(forceRefresh = false) {
    if (!fs.existsSync(META_DIR)) return null;

    if (!forceRefresh) {
        const cached = cache.get(CACHE_KEY);
        if (cached) return cached;
    }

    let files;
    try { files = fs.readdirSync(META_DIR).filter(f => f.endsWith('.json')); } catch { return null; }
    if (files.length === 0) return null;

    const sessions = {};
    for (const f of files) {
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8')); } catch { continue; }
        const sessionId = f.replace(/\.json$/, '');
        const { family, kind } = classifyOne(meta);
        sessions[sessionId] = {
            family,
            kind,
            project: meta.project_path ? path.basename(meta.project_path) : null,
            firstPrompt: meta.first_prompt || null,
            evidence: evidenceFor(meta),
            startTime: meta.start_time || null
        };
    }

    const result = { generatedAt: new Date().toISOString(), available: true, sessions, families: FAMILIES };
    cache.set(CACHE_KEY, result, CACHE_TTL);
    return result;
}

module.exports = { classifySessions, FAMILIES };
