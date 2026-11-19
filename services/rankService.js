"use strict";
/**
 * Multi-turn rank movement.
 * Confirm the health system or group before predicting. Competitors stay fixed.
 */
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const zod_1 = require("zod");
const countyNeighbors_1 = require("./countyNeighbors");
const entityResolve_1 = require("./entityResolve");
const rankModel_1 = require("./rankModel");
const rankingsStore_1 = require("./rankingsStore");
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerRank = answerRank;
exports.conversationCounty = conversationCounty;
exports.looksLikeRankQuestion = looksLikeRankQuestion;
exports.rankOptions = rankOptions;
exports.resetRankSessions = resetRankSessions;
exports.interpretRankMessage = interpretRankMessage;
exports.refusesWrite = refusesWrite;

const payorName = zod_1.z.string().trim().min(1, 'payor is required').max(200);
const planTypeName = zod_1.z.string().trim().min(1, 'planType is required').max(25);
const rankRequestSchema = zod_1.z.object({
    question: zod_1.z.string().max(500, 'question must be at most 500 characters').transform((value) => value.trim()).pipe(zod_1.z.string().min(1, 'question is required')),
    payors: zod_1.z.array(payorName, { error: 'payors is required' }).min(1, 'payors is required'),
    payorsCrossPlanTypes: zod_1.z.array(zod_1.z.object({
        payor: payorName,
        planType: planTypeName,
    }), { error: 'payors cross planTypes is required' }).min(1, 'payors cross planTypes is required'),
    context: zod_1.z.object({
        county: zod_1.z.string().trim().max(200).optional(),
        state: zod_1.z.string().trim().max(200).optional(),
        system: zod_1.z.string().trim().max(200).optional(),
    }).optional(),
}).superRefine((value, ctx) => {
    const listed = new Set(value.payors.map((payor) => payor.toLowerCase()));
    const covered = new Set();
    const seenPairs = new Set();
    const seenPayors = new Set();
    value.payors.forEach((payor, index) => {
        const key = payor.toLowerCase();
        if (seenPayors.has(key)) {
            ctx.addIssue({ code: 'custom', path: ['payors', index], message: `duplicate payor "${payor}"` });
        }
        seenPayors.add(key);
    });
    value.payorsCrossPlanTypes.forEach((pair, index) => {
        const payorKey = pair.payor.toLowerCase();
        if (!listed.has(payorKey)) {
            ctx.addIssue({
                code: 'custom',
                path: ['payorsCrossPlanTypes', index, 'payor'],
                message: `payor "${pair.payor}" must be listed in payors`,
            });
        }
        else covered.add(payorKey);
        const pairKey = `${payorKey}|${pair.planType.toLowerCase()}`;
        if (seenPairs.has(pairKey)) {
            ctx.addIssue({
                code: 'custom',
                path: ['payorsCrossPlanTypes', index],
                message: `duplicate payor and planType "${pair.payor}" / "${pair.planType}"`,
            });
        }
        seenPairs.add(pairKey);
    });
    value.payors.forEach((payor, index) => {
        if (!covered.has(payor.toLowerCase())) {
            ctx.addIssue({
                code: 'custom',
                path: ['payors', index],
                message: `payor "${payor}" needs at least one planType in payorsCrossPlanTypes`,
            });
        }
    });
    const state = value.context?.state;
    if (state && !/^(tx|texas)$/i.test(state)) {
        ctx.addIssue({ code: 'custom', path: ['context', 'state'], message: 'only Texas data is available' });
    }
});

function formatRankIssues(error) {
    return error.issues.map((issue) => {
        const field = issue.path.length ? issue.path.map(String).join('.') : 'body';
        return `${field}: ${issue.message}`;
    }).join('; ');
}

const sessions = new Map();
const METHOD = 'Rank is 1 plus the number of competitors with a strictly higher metric. Marginal reach = entity reach × (1 − overlap) × (1 − focal share of geography reach), rounded to the nearest beneficiary. Competitor metrics stay fixed. Rank changes only when the new metric passes a competitor, so the move is not proportional to the size of the change.';

function resetRankSessions() {
    sessions.clear();
}

function looksLikeRankQuestion(text) {
    return /\brank(?:s|ed|ing|ings)?\b|\btop\s+\d+\b|terminat|health system|physician group|where do we (?:land|rank)|if we (?:add|remove|drop|terminate)|adjacent count|surrounding count|best network|against payer|small groups/i.test(String(text || ''));
}

function refusesWrite(text) {
    return /\b(ignore (?:your|all|previous|the) rules|update\s+(?:the\s+)?[\w]+|delete\s+from|drop\s+table|insert\s+into|alter\s+table|truncate\s+table)\b/i.test(String(text || ''));
}

function countyKey(value) {
    return String(value || '').toLowerCase().replace(/\bcounty\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function samePlace(row, county) {
    if ((row.state || 'TX').toUpperCase() !== 'TX') return false;
    return countyKey(row.county) === countyKey(county);
}

function payorKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchPayor(name, rows) {
    const key = payorKey(name);
    const names = [...new Set(rows.map((row) => row.payor))];
    const exact = names.find((payor) => payorKey(payor) === key);
    if (exact) return exact;
    const partial = names.filter((payor) => payorKey(payor).includes(key) || key.includes(payorKey(payor)));
    return partial.length === 1 ? partial[0] : null;
}

function samePayor(left, right) {
    const a = payorKey(left);
    const b = payorKey(right);
    if (!a || !b || a.length < 3 || b.length < 3) return false;
    return a === b || a.includes(b) || b.includes(a);
}

function latestAsOf(rows) {
    const dates = rows.map((row) => row.asOf).filter(Boolean).sort();
    return dates.at(-1) || null;
}

function comma(value) {
    return Math.round(value).toLocaleString('en-US');
}

function baseAssumptions(metric, asOf, overlapNote) {
    return [
        'Competitor networks are held constant unless you name a competitor change.',
        METHOD,
        `The metric is ${metric}${asOf ? `, roster as of ${asOf}` : ''}.`,
        'The geography is Texas. The county name selects the slice.',
        'Values for the same payor, county, and plan type are summed.',
        overlapNote,
    ];
}

function overlapFor(entity, focalPayor, competitorPayors) {
    if (entity.overlap != null) return { overlap: entity.overlap, overlapSource: 'roster file' };
    const owner = payorKey(entity.payor);
    if (owner && owner === payorKey(focalPayor)) return { overlap: rankModel_1.DEFAULT_OVERLAP.onFocal, overlapSource: 'default for an entity already on the focal roster' };
    if (owner && competitorPayors.some((payor) => payorKey(payor) === owner)) return { overlap: rankModel_1.DEFAULT_OVERLAP.onCompetitor, overlapSource: 'default for an entity on a competitor roster' };
    return { overlap: rankModel_1.DEFAULT_OVERLAP.unaffiliated, overlapSource: 'default for an unaffiliated entity' };
}

function aggregate(rows, focalName) {
    const byPayor = new Map();
    for (const row of rows) {
        const current = byPayor.get(row.payor) ?? { payor: row.payor, value: 0, networks: [], publishedRank: null };
        current.value += row.value;
        if (row.network) current.networks.push(row.network);
        if (row.publishedRank != null) {
            current.publishedRank = current.publishedRank == null
                ? row.publishedRank
                : Math.min(current.publishedRank, row.publishedRank);
        }
        byPayor.set(row.payor, current);
    }
    const focal = byPayor.get(focalName);
    const competitors = [...byPayor.values()].filter((row) => row.payor !== focalName);
    return { focal, competitors };
}

function knownCounties(rankings) {
    const byKey = new Map();
    for (const row of rankings || []) {
        if ((row.state || 'TX').toUpperCase() !== 'TX') continue;
        const name = String(row.county || '').trim();
        const key = countyKey(name);
        if (key && !byKey.has(key)) byKey.set(key, name);
    }
    return byKey;
}

function exactCounty(text, counties) {
    if (!counties?.size) return '';
    const key = countyKey(text).replace(/\b(texas|tx|please|thanks)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return counties.get(key) || '';
}

function trailingCounty(text, counties) {
    if (!counties?.size) return '';
    const words = countyKey(text).replace(/\b(texas|tx|please|thanks)\b/g, ' ').split(' ').filter(Boolean);
    for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
        const key = words.slice(-size).join(' ');
        if (counties.has(key)) return counties.get(key);
    }
    return '';
}

/** County the user named. A bare reply such as "Harris" or "houston" is that county, not the example county. */
function resolveCounty(message, counties) {
    const text = String(message || '').trim();
    if (!text) return '';
    const exact = exactCounty(text, counties);
    if (exact) return exact;
    const explicit = [...text.matchAll(/\b(?:in|for|within)\s+([A-Za-z][A-Za-z .'-]*?)\s+county\b/gi)];
    if (!counties?.size) {
        if (explicit.length) return explicit[explicit.length - 1][1].trim();
        const bare = text.match(/^([A-Za-z][A-Za-z .'-]*?)\s+county\b/i);
        return bare ? bare[1].trim() : '';
    }
    const hits = [];
    for (const match of explicit) {
        const found = exactCounty(match[1], counties) || trailingCounty(match[1], counties);
        if (found) hits.push({ index: match.index, name: found });
    }
    for (const [key, name] of counties) {
        const phrase = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
        const re = new RegExp(`\\b${phrase}\\s+county\\b(?!\\s+(?:clinic|hospital|health|system|group|medical))`, 'gi');
        let match;
        while ((match = re.exec(text))) hits.push({ index: match.index, name });
    }
    const trail = trailingCounty(text, counties);
    if (trail) hits.push({ index: text.length, name: trail });
    if (!hits.length) return '';
    hits.sort((a, b) => a.index - b.index);
    return hits[hits.length - 1].name;
}

function countyLines(text, counties) {
    const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
        const found = resolveCounty(line, counties);
        if (found) return found;
    }
    return '';
}

function countyAttempt(message) {
    const text = String(message || '').trim();
    if (!text || text.length > 40 || looksLikeRankQuestion(text)) return '';
    if (/^(yes|yep|yeah|no|nope)$/i.test(text)) return '';
    return text;
}

function countyOnlyReply(message, county) {
    if (!county || looksLikeRankQuestion(message)) return false;
    const words = countyKey(message).split(' ').filter((word) => !/^(texas|tx|please|thanks)$/.test(word));
    return words.join(' ') === countyKey(county);
}

function countySample(counties) {
    const names = [...counties.values()].sort((a, b) => a.localeCompare(b));
    const preferred = ['Harris', 'Houston', 'Dallas', 'Bexar', 'Tarrant', 'Travis'];
    const picked = preferred.filter((name) => counties.has(countyKey(name)));
    for (const name of names) {
        if (picked.length >= 6) break;
        if (!picked.some((item) => countyKey(item) === countyKey(name))) picked.push(name);
    }
    return { picked, total: names.length, all: names };
}

function countyClarify(counties, attempt) {
    const { picked } = countySample(counties);
    const list = picked.join(', ');
    if (attempt) {
        return {
            answer: `"${attempt}" is not a loaded Texas county. Rank stays on the county you name and does not switch to a different county. You can use ${list}.`,
            suggestions: picked,
        };
    }
    return {
        answer: list
            ? `Name the Texas county. You can reply with the county name alone, such as ${picked[0]}. Rank is against competitor networks in that county.`
            : 'Name the Texas county. Rank is against competitor networks in that county.',
        suggestions: picked,
    };
}

function extractCounty(message) {
    return resolveCounty(message);
}

function countWord(value) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const key = String(value || '').toLowerCase();
    return words[key] || Number(key);
}

function extractSmallGroups(message) {
    const match = /\b(?:drop|remove|terminate)\s+(?:these\s+|the\s+)?(one|two|three|four|five|\d+)\s+small\s+groups\b/i.exec(message);
    return match ? countWord(match[1]) : null;
}

function extractSubjectTermination(message) {
    const match = /\b(?:if|what if)\s+(.+?)\s+(?:terminates|terminated|terminate|drops|leaves|exits)\b/i.exec(message);
    if (!match) return null;
    const phrase = (0, entityResolve_1.cleanEntityPhrase)(match[1].replace(/^(?:we|our network|our)\s+/i, ''));
    if (!phrase || /^(we|our)$/i.test(phrase)) return null;
    return { action: 'remove', phrase };
}

function extractChange(message) {
    if (extractSmallGroups(message)) return null;
    const subject = extractSubjectTermination(message);
    if (subject) return subject;
    const add = /\b(?:add|adding|admit|include|including|contract(?:ing)? with|bring in|affiliate with)\s+(.+?)(?=\s+(?:in|for|into|to rank|where|and where)\b|[?.!,]|$)/i.exec(message);
    if (add && !/^(to|toward|towards)\b/i.test(add[1].trim())) return { action: 'add', phrase: (0, entityResolve_1.cleanEntityPhrase)(add[1]) };
    const remove = /\b(?:termination of|terminating|terminate|removing|remove|dropping|drop|without|losing|lose|exit)\s+(.+?)(?=\s+(?:in|from|for|where|its\b)\b|[?.!,]|$)/i.exec(message);
    if (remove) return { action: 'remove', phrase: (0, entityResolve_1.cleanEntityPhrase)(remove[1]) };
    return null;
}

function extractTarget(message) {
    const match = /\b(?:reach|hit|get to)\s+rank\s+(\d+)\b|\bto\s+rank\s+(\d+)\b/i.exec(message);
    if (!match) return null;
    if (/\bhow close\b/i.test(message)) return null;
    if (!/\b(reach|hit|get to|adds?|additions?|smallest set|what should we add|which additions)\b/i.test(message)) return null;
    return Number(match[1] || match[2]);
}

function extractCloseRank(message) {
    const match = /\bhow close\b[\s\S]{0,60}\brank\s+(\d+)\b/i.exec(message);
    return match ? Number(match[1]) : null;
}

function extractAgainst(message) {
    const match = /\b(?:against|versus|vs\.?|compared? (?:with|to))\s+(?:payer\s+|payor\s+)?["']?([A-Za-z0-9][A-Za-z0-9 .&'-]*?)["']?(?=\s+in\b|[?.!]|$)/i.exec(message);
    return match ? match[1].trim() : '';
}

function countyOnlyMessage(text) {
    return /^(?:in\s+)?[a-z][a-z .'-]{1,40}(?:\s+county)?(?:\s*,?\s*(?:texas|tx))?$/i.test(String(text || '').trim());
}

/** A request for the ordered payor list, not one payor's position. */
function listRequest(message) {
    const text = String(message || '').trim();
    const listed = /\b(top\s+\d+|highest\s+rank|best\s+rank|ranked\s+pay(?:er|or)s?|all\s+ranked)\b/i.test(text);
    const countyOnly = countyOnlyMessage(text);
    if (!listed && !countyOnly) return null;
    const top = text.match(/\btop\s+(\d+)\b/i);
    return {
        limit: top ? Math.min(Math.max(Number(top[1]), 1), 50) : null,
        highest: /\b(highest|best)\s+rank\b/i.test(text) && !top,
        countyOnly: countyOnly && !listed,
    };
}

function orderedPayors(rows) {
    const byPayor = new Map();
    for (const row of rows) {
        const current = byPayor.get(row.payor) ?? { payor: row.payor, value: 0, publishedRank: null };
        current.value += row.value;
        if (row.publishedRank != null) {
            current.publishedRank = current.publishedRank == null
                ? row.publishedRank
                : Math.min(current.publishedRank, row.publishedRank);
        }
        byPayor.set(row.payor, current);
    }
    const list = [...byPayor.values()];
    const published = list.length > 0 && list.every((row) => row.publishedRank != null);
    if (published) list.sort((a, b) => a.publishedRank - b.publishedRank || a.payor.localeCompare(b.payor));
    else list.sort((a, b) => b.value - a.value || a.payor.localeCompare(b.payor));
    return list.map((row, index) => ({
        payor: row.payor,
        value: row.value,
        rank: published ? row.publishedRank : index + 1,
        focal: false,
    }));
}

function listSections(message, rows) {
    const types = uniqueSorted(rows.map((row) => row.planType));
    const named = types.filter((type) => new RegExp(`\\b${type}\\b`, 'i').test(message));
    return (named.length ? named : types).map((planType) => {
        const standings = orderedPayors(rows.filter((row) => row.planType.toLowerCase() === planType.toLowerCase()));
        return { planType, standings };
    }).filter((section) => section.standings.length);
}

function formatList(county, section, request) {
    const standings = request.limit ? section.standings.slice(0, request.limit) : section.standings;
    const lines = standings.map((row) => `${row.rank}. ${row.payor}`).join('; ');
    const place = `${section.planType} payors in ${county} County, Texas`;
    if (request.highest && standings[0]) {
        const top = section.standings[0];
        const of = Math.max(...section.standings.map((row) => row.rank));
        return `The highest ranked ${section.planType} payor in ${county} County, Texas is ${top.payor}, rank ${top.rank} of ${of}. Ranked ${section.planType} payors: ${section.standings.map((row) => `${row.rank}. ${row.payor}`).join('; ')}.`;
    }
    const label = request.limit
        ? `Top ${standings.length} of ${section.standings.length} ${place}`
        : `Ranked ${place} (${section.standings.length})`;
    return `${label}: ${lines}.`;
}

function interpretRankMessage(message, session) {
    const text = String(message || '').trim();
    const county = extractCounty(text) || session?.county || '';
    const smallGroups = extractSmallGroups(text);
    const change = extractChange(text);
    const targetRank = extractTarget(text);
    const closeRank = extractCloseRank(text);
    const against = extractAgainst(text);
    const safeRemoval = /\brank-safe\b|\bsafe to (?:remove|drop|terminate)\b|\bwhich removals\b/i.test(text);
    const sensitivity = /\bhow close\b|\bsensitivity\b|\bboundary\b|\bhow much .{0,40}reach\b/i.test(text);
    const spread = /\badjacent counties\b|\bsurrounding counties\b|\bhold across\b|\bacross the surrounding\b/i.test(text);
    const recap = /\bhow much rank did we lose\b|\brank did we lose\b/i.test(text);
    const best = /\bbest network\b/i.test(text);
    const list = listRequest(text);
    const affirm = /^(yes|yep|yeah|confirm|go ahead|use that|that one)\b/i.test(text) || /\brank after that\b|\bafter that\b/i.test(text);
    let intent = 'baseline';
    if (spread) intent = 'geography';
    else if (recap && !change) intent = 'recap';
    else if (smallGroups) intent = 'predict';
    else if (safeRemoval) intent = 'safe_removals';
    else if (list) intent = 'list';
    else if (best) intent = 'best';
    else if (against) intent = 'against';
    else if (sensitivity) intent = 'sensitivity';
    else if (targetRank && !change) intent = 'prescribe';
    else if (change) intent = 'predict';
    return { text, county, change, smallGroups, targetRank, closeRank, against, intent, affirm, list };
}

function sliceRows(rankings, county, planType) {
    return rankings.filter((row) => samePlace(row, county) && row.planType.toLowerCase() === planType.toLowerCase() && row.state === 'TX');
}

function catalogFor(roster, county, planType) {
    return roster
        .filter((row) => samePlace(row, county) && (!row.planType || row.planType.toLowerCase() === planType.toLowerCase()))
        .map((row) => ({ ...row, source: 'roster' }));
}

function keepOurPayor(focalChoice, previous, against) {
    let payor = focalChoice.payor || previous?.payor;
    let planType = focalChoice.planType || previous?.planType;
    if (against && payor && samePayor(payor, against) && previous?.payor && !samePayor(previous.payor, against)) {
        payor = previous.payor;
        planType = previous.planType || planType;
    }
    return { payor, planType };
}

function displayedRank(row, peers) {
    const published = peers.every((item) => item.publishedRank != null);
    if (published) return row.publishedRank;
    return (0, rankModel_1.rankOf)(row.value, peers.filter((item) => item.payor !== row.payor).map((item) => item.value));
}

function comparisonSentence(ours, other, peers) {
    const ourRank = displayedRank(ours, peers);
    const theirRank = displayedRank(other, peers);
    const gap = theirRank - ourRank;
    const places = Math.abs(gap) === 1 ? 'place' : 'places';
    const relation = gap === 0
        ? `${ours.payor} and ${other.payor} are tied at rank ${ourRank}`
        : gap > 0
            ? `${ours.payor} ranks ${gap} ${places} ahead of ${other.payor}`
            : `${ours.payor} ranks ${-gap} ${places} behind ${other.payor}`;
    return `${ours.payor} is rank ${ourRank} and ${other.payor} is rank ${theirRank}. ${relation}`;
}

function chooseFocal(message, scope, rankings) {
    const against = extractAgainst(message);
    const withoutTarget = against ? scope.payors.filter((payor) => !samePayor(payor, against)) : scope.payors;
    const payors = withoutTarget.length ? withoutTarget : scope.payors;
    const mentioned = payors.filter((payor) => message.toLowerCase().includes(payor.toLowerCase()));
    const payor = mentioned.length === 1 ? mentioned[0] : payors.length === 1 ? payors[0] : null;
    if (!payor) return { clarify: `Which payor is "we"? Choose one of ${payors.join(', ')}.` };
    const pairs = scope.payorsCrossPlanTypes.filter((pair) => pair.payor.toLowerCase() === payor.toLowerCase());
    const mentionedType = pairs.filter((pair) => message.toLowerCase().includes(pair.planType.toLowerCase()));
    const planType = mentionedType.length === 1 ? mentionedType[0].planType : pairs.length === 1 ? pairs[0].planType : null;
    if (!planType) return { clarify: `Which plan type for ${payor}? Choose one of ${pairs.map((pair) => pair.planType).join(', ')}.` };
    const known = matchPayor(payor, rankings);
    return { payor, planType, rankingsPayor: known };
}

function remember(previous, patch) {
    const id = previous?.id || (0, node_crypto_1.randomUUID)();
    const next = { ...previous, ...patch, id };
    sessions.set(id, next);
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
    return next;
}

function entityRecord(match, focalPayor, competitorPayors) {
    const overlap = overlapFor(match, focalPayor, competitorPayors);
    return {
        name: match.name,
        entityType: match.entityType,
        reach: match.reach,
        payor: match.payor || '',
        onFocal: payorKey(match.payor) === payorKey(focalPayor),
        ...overlap,
    };
}

function driversFor(result, metric) {
    return result.applied.map((change) => {
        const direction = change.marginalReach < 0 ? 'gives up' : 'adds';
        return `${change.action === 'remove' ? 'Removing' : 'Adding'} ${change.name} ${direction} ${comma(Math.abs(change.marginalReach))} ${metric}. The roster reach is ${comma(change.reach)}; overlap ${change.overlap} and current coverage leave only that marginal share.`;
    });
}

function answerFromPrediction(session, result, metric, asOf, assumptions, extra) {
    const actionWord = result.applied.every((change) => change.action === 'remove')
        ? 'termination'
        : result.applied.every((change) => change.action === 'add') ? 'addition' : 'change';
    const phrase = (0, rankModel_1.movementPhrase)(result.baseline.rank, result.predicted.rank, actionWord);
    const lost = result.applied.filter((change) => change.marginalReach < 0).reduce((sum, change) => sum + Math.abs(change.marginalReach), 0);
    const gained = result.applied.filter((change) => change.marginalReach > 0).reduce((sum, change) => sum + change.marginalReach, 0);
    const above = result.margin.above ? `${comma(result.margin.above.reach)} ${metric} behind ${result.margin.above.payor}` : 'no network above';
    const below = result.margin.below ? `${comma(result.margin.below.reach)} ${metric} ahead of ${result.margin.below.payor}` : 'no network below';
    const absorbed = result.predicted.movement === 0 && lost > 0
        ? `Beneficiary reach lost is ${comma(lost)}, and the margin absorbs it, so the rank does not move.`
        : '';
    const reachLine = lost > 0 ? `Beneficiary reach lost: ${comma(lost)}.` : gained > 0 ? `Beneficiary reach gained: ${comma(gained)}.` : '';
    const answer = [
        phrase,
        reachLine,
        `Margin after the change: ${above}; ${below}.`,
        absorbed,
        extra || '',
    ].filter(Boolean).join(' ');
    return answer;
}

function publishedPlacement(focal, competitors) {
    if (focal.publishedRank == null) return null;
    const rows = [focal, ...competitors].filter((row) => row.publishedRank != null);
    if (!rows.length) return null;
    const above = rows
        .filter((row) => row.payor !== focal.payor && row.publishedRank < focal.publishedRank)
        .sort((a, b) => b.publishedRank - a.publishedRank || a.payor.localeCompare(b.payor))[0] ?? null;
    const below = rows
        .filter((row) => row.payor !== focal.payor && row.publishedRank > focal.publishedRank)
        .sort((a, b) => a.publishedRank - b.publishedRank || a.payor.localeCompare(b.payor))[0] ?? null;
    return {
        rank: focal.publishedRank,
        of: Math.max(...rows.map((row) => row.publishedRank)),
        above,
        below,
        standings: rows
            .slice()
            .sort((a, b) => a.publishedRank - b.publishedRank || a.payor.localeCompare(b.payor))
            .map((row) => ({ payor: row.payor, value: row.value, focal: row.payor === focal.payor, rank: row.publishedRank })),
    };
}

function baselineBody(session, pack, assumptions) {
    const { focal, competitors, metric, asOf } = pack;
    const result = (0, rankModel_1.predictChange)({ focal, competitors, changes: [] });
    const published = publishedPlacement(focal, competitors);
    if (published) {
        result.baseline.rank = published.rank;
        result.baseline.of = published.of;
        result.baseline.nextBetter = published.above ? { payor: published.above.payor, value: published.above.value } : null;
        result.baseline.nextWorse = published.below ? { payor: published.below.payor, value: published.below.value } : null;
        result.baseline.reachToNextBetterRank = published.above ? published.rank - published.above.publishedRank : null;
        result.baseline.reachBeforeWorseRank = published.below ? published.below.publishedRank - published.rank : null;
    }
    const gap = result.baseline.reachToNextBetterRank;
    const cushion = result.baseline.reachBeforeWorseRank;
    const names = [focal, ...competitors].map((row) => row.payor).join(', ');
    const answer = published
        ? [
            `${focal.payor} ${session.planType} is rank ${published.rank} of ${published.of} in ${session.county} County, Texas, in terms of current Network.`,
            `The competitor set is ${names}.`,
            published.above ? `${published.above.payor} is the next better best network.` : 'There is no better network.',
        ].join(' ')
        : [
            `${focal.payor} ${session.planType} is rank ${result.baseline.rank} of ${result.baseline.of} in ${session.county} County, Texas, on ${metric}${asOf ? ` as of ${asOf}` : ''}.`,
            `The competitor set is ${names}.`,
            gap == null ? 'There is no network above.' : `${comma(gap)} ${metric} separates it from ${result.baseline.nextBetter.payor}.`,
            cushion == null ? 'There is no network below.' : `${comma(cushion)} ${metric} can be lost before it ties ${result.baseline.nextWorse.payor}.`,
        ].join(' ');
    return {
        kind: 'baseline',
        answer,
        geography: { county: session.county, state: 'TX' },
        focal: { payor: focal.payor, planType: session.planType },
        metric,
        asOf,
        competitorSet: competitors.map((row) => row.payor),
        baseline: result.baseline,
        sensitivity: {
            reachToNextBetterRank: result.baseline.reachToNextBetterRank,
            reachBeforeWorseRank: result.baseline.reachBeforeWorseRank,
        },
        standings: published ? published.standings : (0, rankModel_1.standings)(focal, competitors),
        assumptions: published
            ? [...assumptions, 'This rank is rank_payor_plantype from the provider dashboard file. A lower number is a better network.']
            : assumptions,
        method: METHOD,
    };
}

function scoreCounty(data, county, planType, payor, metric, scenario) {
    const slice = sliceRows(data.rankings, county, planType).filter((row) => row.metric === metric);
    if (!slice.length) return { county, status: 'missing_rankings' };
    const rankingsPayor = matchPayor(payor, slice);
    if (!rankingsPayor) return { county, status: 'missing_roster' };
    const { focal, competitors } = aggregate(slice, rankingsPayor);
    if (!focal) return { county, status: 'missing_roster' };
    const catalog = catalogFor(data.roster, county, planType).map((row) => entityRecord(row, rankingsPayor, competitors.map((item) => item.payor)));
    const changes = [];
    for (const item of scenario) {
        const match = catalog.find((row) => (0, entityResolve_1.normalizeName)(row.name) === (0, entityResolve_1.normalizeName)(item.name));
        if (!match) return { county, status: 'missing_roster' };
        changes.push({ action: item.action, name: match.name, entityType: match.entityType, reach: match.reach, overlap: match.overlap });
    }
    const result = (0, rankModel_1.predictChange)({ focal, competitors, changes });
    const reachLost = result.applied.filter((change) => change.marginalReach < 0).reduce((sum, change) => sum + Math.abs(change.marginalReach), 0);
    return {
        county,
        status: 'ok',
        rankToday: result.baseline.rank,
        rankAfter: result.predicted.rank,
        reachLost,
        holds: result.baseline.rank === result.predicted.rank,
        margin: result.margin,
    };
}

function finishPrediction(session, result, metric, asOf, assumptions, extra, geography) {
    const answer = answerFromPrediction(session, result, metric, asOf, assumptions, extra);
    const reachLost = result.applied.filter((change) => change.marginalReach < 0).reduce((sum, change) => sum + Math.abs(change.marginalReach), 0);
    const payload = {
        kind: 'prediction',
        answer,
        geography: geography || { county: session.county, state: 'TX' },
        focal: { payor: session.payor, planType: session.planType },
        metric,
        asOf,
        competitorSet: result.standings.filter((row) => !row.focal).map((row) => row.payor),
        baseline: result.baseline,
        predicted: result.predicted,
        margin: result.margin,
        reachLost,
        sensitivity: {
            reachToNextBetterRank: result.baseline.reachToNextBetterRank,
            reachBeforeWorseRank: result.baseline.reachBeforeWorseRank,
        },
        change: result.applied,
        drivers: driversFor(result, metric),
        standings: result.standings,
        assumptions,
        method: METHOD,
    };
    const saved = remember(session, {
        lastChange: result.applied.map((change) => ({ action: change.action, name: change.name })),
        lastPrediction: payload,
    });
    return { ...payload, sessionId: saved.id };
}

function loadDeps(deps) {
    if (deps) return deps;
    const directory = (0, node_path_1.join)(__dirname, '..', 'data');
    return (0, rankingsStore_1.loadRankData)(directory);
}

/** County named in this chat turn, using the same county list the rank answer uses. */
function conversationCounty(message, earlier, deps) {
    const counties = knownCounties(loadDeps(deps).rankings);
    return resolveCounty(message, counties) || countyLines(earlier, counties) || '';
}

function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Payors and plan types present in the rankings. Nothing here is preselected. */
function rankOptions(input = {}, deps) {
    const data = loadDeps(deps);
    const counties = knownCounties(data.rankings);
    const fromQuestion = resolveCounty(input.q || input.message || '', counties);
    const rawCounty = String(fromQuestion || input.county || '').trim();
    const county = counties.get(countyKey(rawCounty)) || rawCounty;
    const planType = String(input.planType || '').trim();
    let rows = (data.rankings || []).filter((row) => (row.state || 'TX').toUpperCase() === 'TX');
    if (county) rows = rows.filter((row) => samePlace(row, county));
    const planTypes = uniqueSorted(rows.map((row) => row.planType));
    const payorRows = planType
        ? rows.filter((row) => String(row.planType).toLowerCase() === planType.toLowerCase())
        : rows;
    return {
        county: county || null,
        planTypes,
        payors: uniqueSorted(payorRows.map((row) => row.payor)),
    };
}

function countiesWithRoster(data, planType, payor, metric) {
    const names = [...knownCounties(data.rankings).values()].sort((a, b) => a.localeCompare(b));
    return names.filter((county) => {
        const slice = sliceRows(data.rankings, county, planType).filter((row) => row.metric === metric);
        return Boolean(matchPayor(payor, slice));
    });
}

function countyPack(data, county, planType, payor, metric) {
    const slice = sliceRows(data.rankings, county, planType).filter((row) => row.metric === metric);
    const rankingsPayor = matchPayor(payor, slice);
    if (!rankingsPayor) return null;
    const { focal, competitors } = aggregate(slice, rankingsPayor);
    if (!focal) return null;
    const catalog = catalogFor(data.roster, county, planType).map((row) => entityRecord(row, rankingsPayor, competitors.map((item) => item.payor)));
    return { county, focal, competitors, catalog };
}

/** A rank question with no county is answered for every loaded county. The caller is not asked to pick one. */
function answerStatewide({ message, earlier, previous, scope, data, interpreted }) {
    if (!data.rankings.length) {
        return {
            kind: 'needs_data',
            answer: 'Rankings are not loaded. Add data/rankings.csv for the current roster position and data/roster.csv for each health system or group reach.',
            expectedFiles: rankingsStore_1.RANK_FILE_HELP,
            assumptions: ['Competitor networks are held constant unless you name a competitor change.'],
        };
    }
    const focalChoice = chooseFocal(`${message} ${earlier} ${previous?.question || ''} ${previous?.payor || ''} ${previous?.planType || ''}`, scope.data, data.rankings);
    if (focalChoice.clarify && !(previous?.payor && previous?.planType)) {
        const saved = remember(previous, { question: message });
        return { kind: 'clarify', sessionId: saved.id, answer: focalChoice.clarify };
    }
    const selected = keepOurPayor(focalChoice, previous, interpreted.against);
    const payor = selected.payor;
    const planType = selected.planType;
    const typed = data.rankings.filter((row) => row.planType.toLowerCase() === planType.toLowerCase() && (row.state || 'TX').toUpperCase() === 'TX');
    const metrics = [...new Set(typed.map((row) => row.metric))];
    const metricSource = `${message} ${earlier} ${previous?.question || ''}`.toLowerCase();
    const metric = metrics.find((item) => metricSource.includes(item.toLowerCase())) || (metrics.length === 1 ? metrics[0] : null);
    if (!metric) {
        const saved = remember(previous, { payor, planType, question: message });
        return { kind: 'clarify', sessionId: saved.id, answer: `Which metric should set the rank? Loaded metrics: ${metrics.join(', ')}.` };
    }
    const packs = countiesWithRoster(data, planType, payor, metric).map((county) => countyPack(data, county, planType, payor, metric)).filter(Boolean);
    if (!packs.length) {
        return { kind: 'needs_data', answer: `No Texas rankings are loaded for ${payor} ${planType}.`, expectedFiles: rankingsStore_1.RANK_FILE_HELP };
    }
    const target = interpreted.targetRank || interpreted.closeRank || 2;
    let kind = 'baseline';
    let lines = [];
    if (interpreted.intent === 'prescribe' || interpreted.intent === 'safe_removals') {
        kind = 'prescription';
        lines = packs.map((pack) => {
            if (interpreted.intent === 'safe_removals') {
                const removals = (0, rankModel_1.safeRemovals)({ focalValue: pack.focal.value, competitors: pack.competitors, candidates: pack.catalog.filter((row) => row.onFocal) });
                return `${pack.county}: ${removals.length ? removals.map((row) => row.name).join(', ') : 'no rank-safe removal'}`;
            }
            const additions = (0, rankModel_1.planAdditions)({
                focalValue: pack.focal.value,
                competitors: pack.competitors,
                candidates: pack.catalog.filter((row) => !row.onFocal),
                targetRank: interpreted.targetRank || 1,
            });
            const detail = additions.picks.length
                ? additions.picks.map((row) => `${row.name} gains ${comma(row.marginalReach)} and lands at rank ${row.predictedRank}`).join('; ')
                : 'none with a positive marginal reach';
            return `${pack.county}: ${detail}`;
        });
    } else if (interpreted.intent === 'sensitivity' || interpreted.closeRank) {
        kind = 'sensitivity';
        lines = packs.map((pack) => {
            const gap = (0, rankModel_1.reachToRank)(pack.focal.value, pack.competitors, target);
            if (gap.already) return `${pack.county}: already rank ${gap.current}`;
            if (gap.gap == null) return `${pack.county}: rank ${target} is not defined`;
            return `${pack.county}: ${comma(gap.gap)} beneficiary reach from rank ${target} (now rank ${gap.current})`;
        });
    } else if (interpreted.intent === 'against' && interpreted.against) {
        kind = 'comparison';
        lines = packs.map((pack) => {
            const peers = [pack.focal, ...pack.competitors];
            const other = peers.find((row) => row.payor !== pack.focal.payor && samePayor(row.payor, interpreted.against));
            if (!other) return `${pack.county}: No roster is loaded for ${interpreted.against}`;
            return `${pack.county}: ${comparisonSentence(pack.focal, other, peers)}`;
        });
        if (lines.every((line) => line.includes('No roster is loaded'))) {
            const saved = remember(previous, { payor, planType, metric, question: message });
            return {
                kind: 'unavailable',
                sessionId: saved.id,
                answer: `No roster is loaded for ${interpreted.against}, so I can't rank against them.`,
            };
        }
    } else if (interpreted.intent === 'predict' && interpreted.change?.phrase) {
        kind = 'prediction';
        const action = interpreted.change.action || 'add';
        lines = packs.map((pack) => {
            const matches = (0, entityResolve_1.resolveEntities)(interpreted.change.phrase, pack.catalog);
            const recommended = matches[0] && (matches.length === 1 || matches[0].score - (matches[1]?.score || 0) >= 0.15) ? matches[0] : null;
            if (!recommended || recommended.reach == null) return `${pack.county}: ${interpreted.change.phrase} is not on the loaded roster`;
            const change = { action, name: recommended.name, entityType: recommended.entityType, reach: recommended.reach, overlap: recommended.overlap };
            const result = (0, rankModel_1.predictChange)({ focal: pack.focal, competitors: pack.competitors, changes: [change] });
            const verb = action === 'remove' ? 'removing' : 'adding';
            return `${pack.county}: rank ${result.baseline.rank} to rank ${result.predicted.rank} after ${verb} ${recommended.name}`;
        });
    } else {
        lines = packs.map((pack) => {
            const result = (0, rankModel_1.predictChange)({ focal: pack.focal, competitors: pack.competitors, changes: [] });
            return `${pack.county}: rank ${result.baseline.rank} of ${result.baseline.of}`;
        });
    }
    const saved = remember(previous, { payor, planType, metric, question: message });
    return {
        kind,
        sessionId: saved.id,
        answer: `${payor} ${planType} across ${packs.length} Texas counties. A county was not required. ${lines.join('. ')}.`,
        counties: packs.map((pack) => pack.county),
        focal: { payor, planType },
        metric,
        geography: { state: 'TX' },
    };
}

async function answerRank(input, deps) {
    const message = String(input.message || input.question || '').trim();
    if (refusesWrite(message)) {
        return { kind: 'refused', answer: "I can't change the network tables. Ask a read-only rank question." };
    }
    const scope = rankRequestSchema.safeParse({
        question: (message || 'rank').slice(0, 500),
        payors: input.payors,
        payorsCrossPlanTypes: input.payorsCrossPlanTypes,
        context: input.geography || input.context,
    });
    if (!scope.success) {
        return { status: 400, kind: 'error', answer: formatRankIssues(scope.error) };
    }
    const data = loadDeps(deps);
    const previous = input.sessionId ? sessions.get(input.sessionId) : null;
    const counties = knownCounties(data.rankings);
    const earlier = String(input.earlier || '');
    const interpreted = interpretRankMessage(message, previous);
    if (interpreted.affirm && previous?.pending && interpreted.intent !== 'geography') {
        if (previous.pending.names) interpreted.namedGroups = previous.pending.names;
        else interpreted.change = previous.pending;
        interpreted.intent = 'predict';
    }
    if (input.change?.name) {
        interpreted.change = { action: input.change.action || 'add', phrase: input.change.name };
        interpreted.intent = 'predict';
    }
    const state = input.geography?.state || input.context?.state || '';
    if (state && !/^(tx|texas)$/i.test(state)) {
        return { kind: 'clarify', answer: 'Only Texas geographies are in scope. Name a Texas county.' };
    }
    if (/\b(california|florida|new york|oklahoma|louisiana)\b/i.test(message)) {
        return { kind: 'clarify', answer: 'Only Texas geographies are in scope. Name a Texas county.' };
    }
    const fromLatest = resolveCounty(message, counties);
    const freshQuestion = looksLikeRankQuestion(message) && !fromLatest;
    const fromEarlier = !fromLatest && !freshQuestion ? countyLines(earlier, counties) : '';
    if (countyOnlyReply(message, fromLatest)) {
        const priorText = previous?.question || earlier;
        if (priorText) {
            const prior = interpretRankMessage(priorText, previous);
            if (prior.intent !== 'baseline') interpreted.intent = prior.intent;
            if (!interpreted.change && prior.change) interpreted.change = prior.change;
            if (!interpreted.smallGroups && prior.smallGroups) interpreted.smallGroups = prior.smallGroups;
            if (!interpreted.targetRank && prior.targetRank) interpreted.targetRank = prior.targetRank;
            if (!interpreted.closeRank && prior.closeRank) interpreted.closeRank = prior.closeRank;
            if (!interpreted.against && prior.against) interpreted.against = prior.against;
        }
    }
    const requested = String(input.county || '').trim();
    const requestedCounty = requested ? (counties.get(countyKey(requested)) || requested) : '';
    const county = counties.get(countyKey(fromLatest || requestedCounty || fromEarlier || interpreted.county || input.geography?.county || input.context?.county || ''))
        || fromLatest || requestedCounty || fromEarlier || interpreted.county || input.geography?.county || input.context?.county || '';
    if (!county) {
        const attempt = countyAttempt(message);
        if (!attempt) return answerStatewide({ message, earlier, previous, scope, data, interpreted });
        const prompt = countyClarify(counties, attempt);
        const saved = remember(previous, {
            question: looksLikeRankQuestion(message) ? message : (previous?.question || earlier || message),
            awaitingCounty: true,
        });
        return { kind: 'clarify', sessionId: saved.id, answer: prompt.answer, suggestions: prompt.suggestions, suggestionField: 'county' };
    }
    if (!data.rankings.length) {
        return {
            kind: 'needs_data',
            answer: 'Rankings are not loaded. Add data/rankings.csv for the current roster position and data/roster.csv for each health system or group reach.',
            expectedFiles: rankingsStore_1.RANK_FILE_HELP,
            assumptions: ['Competitor networks are held constant unless you name a competitor change.'],
        };
    }
    const listing = listRequest(message);
    if (listing && (!listing.countyOnly || fromLatest)) {
        const countyRows = data.rankings.filter((row) => samePlace(row, county));
        const sections = listSections(message, countyRows);
        if (!sections.length) {
            return { kind: 'needs_data', answer: `No Texas rankings are loaded for ${county} County.`, expectedFiles: rankingsStore_1.RANK_FILE_HELP };
        }
        const answer = sections.map((section) => formatList(county, section, listing)).join(' ');
        const standings = sections.flatMap((section) => {
            const rows = listing.highest || !listing.limit ? section.standings : section.standings.slice(0, listing.limit);
            return sections.length > 1
                ? rows.map((row) => ({ ...row, payor: `${row.payor} (${section.planType})` }))
                : rows;
        });
        const saved = remember(previous, { county, planType: sections.length === 1 ? sections[0].planType : previous?.planType });
        return {
            kind: 'baseline',
            sessionId: saved.id,
            answer,
            geography: { county, state: 'TX' },
            standings,
            competitorSet: standings.map((row) => row.payor),
        };
    }
    const focalChoice = chooseFocal(`${message} ${earlier} ${previous?.question || ''} ${previous?.payor || ''} ${previous?.planType || ''}`, scope.data, data.rankings);
    if (focalChoice.clarify && !(previous?.payor && previous?.planType)) {
        const saved = remember(previous, {
            county,
            question: previous?.question || (looksLikeRankQuestion(message) ? message : earlier) || message,
        });
        return { kind: 'clarify', sessionId: saved.id, answer: `${focalChoice.clarify} The county is ${county} County.` };
    }
    const selected = keepOurPayor(focalChoice, previous, interpreted.against);
    const payor = selected.payor;
    const planType = selected.planType;
    const slice = sliceRows(data.rankings, county, planType);
    if (!slice.length) {
        return { kind: 'needs_data', answer: `No Texas rankings are loaded for ${county} County and ${planType}.`, expectedFiles: rankingsStore_1.RANK_FILE_HELP };
    }
    const metrics = [...new Set(slice.map((row) => row.metric))];
    const metricSource = `${message} ${earlier} ${previous?.question || ''}`.toLowerCase();
    const metric = metrics.find((item) => metricSource.includes(item.toLowerCase())) || (metrics.length === 1 ? metrics[0] : null);
    if (!metric) {
        const saved = remember(previous, { county, payor, planType });
        const lead = interpreted.intent === 'best'
            ? `Best depends on the metric. I will not pick one for you. Loaded metrics: ${metrics.join(', ')}.`
            : `Which metric should set the rank? Loaded metrics: ${metrics.join(', ')}.`;
        return { kind: 'clarify', sessionId: saved.id, answer: lead, metrics };
    }
    const metricRows = slice.filter((row) => row.metric === metric);
    const rankingsPayor = matchPayor(payor, metricRows);
    if (!rankingsPayor) {
        const known = uniqueSorted(metricRows.map((row) => row.payor));
        return {
            kind: 'clarify',
            answer: `${payor} is not in the ${county} County ${planType} rankings. Choose a payor that is loaded for this county.`,
            suggestions: known,
            suggestionField: 'payor',
        };
    }
    const { focal, competitors } = aggregate(metricRows, rankingsPayor);
    if (!focal) return { kind: 'clarify', answer: `${payor} has no ${metric} value in ${county} County.` };
    const asOf = latestAsOf(metricRows);
    const competitorPayors = competitors.map((row) => row.payor);
    const assumptions = baseAssumptions(metric, asOf, 'Overlap comes from the roster file when present, otherwise from a stated default.');
    const session = remember(previous, { county, payor: rankingsPayor, planType, metric });
    const pack = { focal, competitors, metric, asOf };
    const catalog = catalogFor(data.roster, county, planType).map((row) => entityRecord(row, rankingsPayor, competitorPayors));

    if (interpreted.intent === 'against') {
        const found = matchPayor(interpreted.against, metricRows);
        if (!found) {
            return {
                kind: 'unavailable',
                sessionId: session.id,
                answer: `No roster is loaded for ${interpreted.against} in ${county} County, so I can't rank against them.`,
                competitorSet: [rankingsPayor, ...competitorPayors],
            };
        }
        if (samePayor(found, rankingsPayor)) {
            return {
                kind: 'clarify',
                sessionId: session.id,
                answer: `${found} is the selected payor, so name the other payer to compare.`,
            };
        }
        const peers = [focal, ...competitors];
        const other = peers.find((row) => row.payor === found);
        const body = baselineBody(session, pack, assumptions);
        body.kind = 'comparison';
        body.sessionId = session.id;
        body.answer = `${focal.payor} ${planType} and ${other.payor} ${planType} in ${county} County, Texas: ${comparisonSentence(focal, other, peers)}.`;
        body.comparedWith = other.payor;
        return body;
    }

    if (interpreted.intent === 'best') {
        const body = baselineBody(session, pack, assumptions);
        const best = body.baseline.rank === 1;
        body.kind = 'baseline';
        body.sessionId = session.id;
        body.answer = `On ${metric}${asOf ? ` as of ${asOf}` : ''}, ${focal.payor} is rank ${body.baseline.rank} of ${body.baseline.of} in ${county} County. ${best ? `It is the best network on ${metric}.` : `It is not the best network on ${metric}.`}`;
        return body;
    }

    if (interpreted.intent === 'sensitivity') {
        const body = baselineBody(session, pack, assumptions);
        body.sessionId = session.id;
        if (interpreted.closeRank) {
            const gap = (0, rankModel_1.reachToRank)(focal.value, competitors, interpreted.closeRank);
            body.sensitivity.targetRank = interpreted.closeRank;
            body.sensitivity.reachToRank = gap.gap;
            body.answer = gap.already
                ? `On ${metric}, ${focal.payor} is already rank ${gap.current} in ${county} County. The gap to rank ${interpreted.closeRank} is 0 beneficiary reach.`
                : gap.gap == null
                    ? `Rank ${interpreted.closeRank} is not defined for this competitor set on ${metric}.`
                    : `On ${metric}, ${comma(gap.gap)} beneficiary reach separates ${focal.payor} from rank ${interpreted.closeRank}.`;
        }
        return body;
    }

    if (interpreted.intent === 'recap') {
        if (!previous?.lastPrediction) {
            return { kind: 'clarify', sessionId: session.id, answer: 'There is no confirmed change to measure yet.' };
        }
        return { kind: 'prediction', sessionId: session.id, ...previous.lastPrediction, answer: previous.lastPrediction.answer };
    }

    if (interpreted.intent === 'geography') {
        const scenario = previous?.lastChange;
        if (!scenario?.length) {
            return { kind: 'clarify', sessionId: session.id, answer: 'Confirm the network change first. I will then keep that scenario and compare the adjacent counties.' };
        }
        const counties = [county, ...(0, countyNeighbors_1.adjacentCounties)(county)];
        const breakdown = counties.map((name) => scoreCounty(data, name, planType, rankingsPayor, metric, scenario));
        const slipped = breakdown.filter((row) => row.holds === false).map((row) => row.county);
        const held = breakdown.filter((row) => row.holds === true).map((row) => row.county);
        const home = breakdown[0];
        const answer = [
            home?.rankToday != null ? `In ${county} County the change moves rank ${home.rankToday} to rank ${home.rankAfter}. Beneficiary reach lost: ${comma(home.reachLost || 0)}.` : '',
            held.length ? `The position holds in ${held.join(', ')}.` : '',
            slipped.length ? `The position slips in ${slipped.join(', ')}.` : '',
            breakdown.filter((row) => row.status && row.status !== 'ok').map((row) => `${row.county} County: ${row.status === 'missing_roster' ? 'roster is missing' : 'rankings are missing'}.`).join(' '),
        ].filter(Boolean).join(' ');
        return {
            kind: 'geography',
            sessionId: session.id,
            answer,
            scenario,
            counties: breakdown,
            metric,
            assumptions,
            method: METHOD,
        };
    }

    if (interpreted.intent === 'baseline' || interpreted.intent === 'sensitivity') {
        const body = baselineBody(session, pack, assumptions);
        body.sessionId = session.id;
        return body;
    }

    if (interpreted.intent === 'prescribe' || interpreted.intent === 'safe_removals') {
        const additions = (0, rankModel_1.planAdditions)({
            focalValue: focal.value,
            competitors,
            candidates: catalog.filter((row) => !row.onFocal),
            targetRank: interpreted.targetRank || 1,
        });
        const removals = (0, rankModel_1.safeRemovals)({ focalValue: focal.value, competitors, candidates: catalog.filter((row) => row.onFocal) });
        const baseline = baselineBody(session, pack, assumptions);
        const answer = interpreted.intent === 'safe_removals'
            ? `${baseline.answer} Rank-safe removals, largest first: ${removals.length ? removals.map((row) => `${row.name} (${comma(row.reachAtRisk)} ${metric} at risk)`).join('; ') : 'none'}.`
            : `${baseline.answer} Smallest set of additions toward rank ${interpreted.targetRank || 1}: ${additions.picks.length ? additions.picks.map((row) => `${row.name} gains ${comma(row.marginalReach)} ${metric} and lands at rank ${row.predictedRank}`).join('; ') : 'none with a positive marginal reach'}.`;
        return {
            kind: 'prescription',
            sessionId: session.id,
            answer,
            geography: baseline.geography,
            focal: baseline.focal,
            metric,
            asOf,
            competitorSet: baseline.competitorSet,
            baseline: baseline.baseline,
            sensitivity: baseline.sensitivity,
            targetRank: interpreted.targetRank || (interpreted.intent === 'prescribe' ? 1 : null),
            additions: additions.picks,
            additionsReachTarget: additions.reached,
            rankSafeRemovals: removals,
            assumptions,
            method: METHOD,
        };
    }

    const namedGroups = interpreted.namedGroups;
    const confirmed = Boolean(input.confirmed) || interpreted.affirm;
    if (interpreted.smallGroups || namedGroups) {
        const picked = namedGroups
            ? namedGroups.map((name) => catalog.find((row) => (0, entityResolve_1.normalizeName)(row.name) === (0, entityResolve_1.normalizeName)(name))).filter(Boolean)
            : catalog.filter((row) => row.onFocal && row.entityType === 'group').sort((a, b) => a.reach - b.reach).slice(0, interpreted.smallGroups);
        if (!namedGroups && picked.length < interpreted.smallGroups) {
            return { kind: 'clarify', sessionId: session.id, answer: `The ${rankingsPayor} roster in ${county} County has ${picked.length} groups, not ${interpreted.smallGroups}.` };
        }
        if (!confirmed) {
            remember(session, { pending: { action: 'remove', names: picked.map((row) => row.name) } });
            return {
                kind: 'confirm',
                sessionId: session.id,
                answer: `Confirm the termination of ${picked.map((row) => row.name).join(', ')} before I predict rank.`,
                candidates: picked.map((row) => ({ name: row.name, entityType: row.entityType, reach: row.reach })),
                geography: { county, state: 'TX' },
                focal: { payor: rankingsPayor, planType },
                assumptions: ['The groups are confirmed before any post-change rank is computed.', ...assumptions],
            };
        }
        const changes = picked.map((row) => ({ action: 'remove', name: row.name, entityType: row.entityType, reach: row.reach, overlap: row.overlap }));
        const result = (0, rankModel_1.predictChange)({ focal, competitors, changes });
        return finishPrediction(session, result, metric, asOf, assumptions, driversFor(result, metric).join(' '));
    }

    const pending = interpreted.change;
    if (!pending?.phrase && !input.change?.name) {
        const body = baselineBody(session, pack, assumptions);
        body.sessionId = session.id;
        return body;
    }
    const phrase = input.change?.name || pending.phrase;
    const action = input.change?.action || pending.action;
    const matches = (0, entityResolve_1.resolveEntities)(phrase, catalog);
    const recommended = matches[0] && (matches.length === 1 || matches[0].score - (matches[1]?.score || 0) >= 0.15) ? matches[0] : null;
    if (!confirmed || !recommended) {
        remember(session, { pending: { action, phrase: recommended?.name || phrase } });
        return {
            kind: 'confirm',
            sessionId: session.id,
            answer: matches.length
                ? `Confirm the ${action === 'remove' ? 'termination' : 'addition'} before I predict rank. I matched "${phrase}" to ${matches.map((row) => row.name).join(', ')}.`
                : `I could not match "${phrase}" to a health system or group in the ${county} County roster. No rank was computed.`,
            candidates: matches.map((row) => ({ name: row.name, entityType: row.entityType, score: row.score, reach: row.reach, onFocal: row.onFocal })),
            recommended: recommended ? { name: recommended.name, entityType: recommended.entityType, action } : null,
            geography: { county, state: 'TX' },
            focal: { payor: rankingsPayor, planType },
            assumptions: ['The entity is confirmed before any post-change rank is computed.', ...assumptions],
        };
    }
    if (recommended.reach == null) {
        return { kind: 'confirm', sessionId: session.id, answer: `${recommended.name} is recognized, but the roster has no beneficiary reach for it, so there is no prediction.`, candidates: [recommended] };
    }
    const change = { action, name: recommended.name, entityType: recommended.entityType, reach: recommended.reach, overlap: recommended.overlap, overlapSource: recommended.overlapSource };
    const result = (0, rankModel_1.predictChange)({ focal, competitors, changes: [change] });
    return finishPrediction(session, result, metric, asOf, assumptions, driversFor(result, metric).join(' '));
}
