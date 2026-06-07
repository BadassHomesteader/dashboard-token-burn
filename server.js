#!/usr/bin/env node
/**
 * Token Burn — tiny zero-dependency Node server.
 * Serves the static dashboard (public/) and exposes GET /api/token-burn, which reads your
 * LOCAL Claude Code (~/.claude) and Codex (~/.codex) usage and returns the aggregated payload.
 *
 *   node server.js            → http://localhost:4321
 *   PORT=8080 node server.js  → custom port
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateTokenBurn } = require('./lib/aggregate');

const PORT = process.env.PORT || 4321;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/token-burn') {
        try {
            const data = await generateTokenBurn(url.searchParams.get('refresh') === 'true');
            if (!data) {
                res.writeHead(404, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'No local Claude data found (~/.claude/projects).' }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: String(e && e.message || e) }));
        }
    }

    // static files (path-traversal guarded)
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
    });
});

server.listen(PORT, () => {
    console.log(`\n  🔥 Token Burn → http://localhost:${PORT}\n  Reading ~/.claude and ~/.codex. Ctrl+C to stop.\n`);
});
