/**
 * Simple in-memory TTL cache for API responses.
 * Each entry expires after its TTL (in milliseconds).
 */
const store = new Map();

function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
    }
    return entry.value;
}

function set(key, value, ttlMs) {
    store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
        cachedAt: new Date().toISOString()
    });
}

function del(key) {
    store.delete(key);
}

function clear() {
    store.clear();
}

module.exports = { get, set, del, clear };
