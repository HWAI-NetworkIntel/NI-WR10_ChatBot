"use strict";
/** Resolve a health system or group from a partial or informal name. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeName = normalizeName;
exports.cleanEntityPhrase = cleanEntityPhrase;
exports.scoreName = scoreName;
exports.resolveEntities = resolveEntities;

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\b(incorporated|inc|llc|llp)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanEntityPhrase(phrase) {
    return String(phrase || '')
        .replace(/\b(health systems?|physician groups?|medical groups?|group practices?)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreName(query, name) {
    const q = normalizeName(query);
    const n = normalizeName(name);
    if (!q || !n) return 0;
    if (q === n) return 1;
    if (n.startsWith(q) || q.startsWith(n)) return 0.92;
    if (n.includes(q) || q.includes(n)) return 0.8;
    const tokens = q.split(' ').filter((token) => token.length > 2);
    if (!tokens.length) return 0;
    const nameTokens = new Set(n.split(' '));
    const hits = tokens.filter((token) => nameTokens.has(token)).length;
    return (hits / tokens.length) * 0.7;
}

function resolveEntities(query, catalog) {
    const phrase = cleanEntityPhrase(query);
    const scored = catalog
        .map((item) => ({ ...item, score: scoreName(phrase, item.name) }))
        .filter((item) => item.score >= 0.55)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const unique = [];
    const seen = new Set();
    for (const item of scored) {
        const key = `${item.entityType}|${normalizeName(item.name)}|${normalizeName(item.county)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique.slice(0, 5);
}
