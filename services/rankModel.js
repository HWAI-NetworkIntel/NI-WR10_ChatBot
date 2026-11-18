"use strict";
/**
 * Rank-movement prediction.
 *
 * Rank is 1 plus the number of competitors with a strictly higher metric.
 * A change does not add or remove the entity's full reach. Marginal reach is
 *   entity reach × (1 − overlap) × (1 − focal share of geography reach).
 * Competitors stay fixed. The rank changes only when the new metric passes a
 * competitor, so the move is not proportional to the size of the system or group.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_OVERLAP = void 0;
exports.clamp01 = clamp01;
exports.marginalReach = marginalReach;
exports.coverageOf = coverageOf;
exports.rankOf = rankOf;
exports.neighbors = neighbors;
exports.standings = standings;
exports.predictChange = predictChange;
exports.planAdditions = planAdditions;
exports.safeRemovals = safeRemovals;
exports.movementPhrase = movementPhrase;

exports.DEFAULT_OVERLAP = { onFocal: 0.55, onCompetitor: 0.35, unaffiliated: 0.15 };

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

function marginalReach(reach, overlap, coverage) {
    const novelty = (1 - clamp01(overlap)) * (1 - clamp01(coverage));
    return Math.round(Number(reach) * novelty);
}

function coverageOf(focalValue, competitorValues) {
    const total = focalValue + competitorValues.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return 0;
    return focalValue / total;
}

function rankOf(value, competitorValues) {
    return 1 + competitorValues.filter((other) => other > value).length;
}

function neighbors(value, competitors) {
    const above = competitors
        .filter((row) => row.value > value)
        .sort((a, b) => a.value - b.value || a.payor.localeCompare(b.payor))[0] ?? null;
    const below = competitors
        .filter((row) => row.value < value)
        .sort((a, b) => b.value - a.value || a.payor.localeCompare(b.payor))[0] ?? null;
    return { above, below };
}

function standings(focal, competitors) {
    const rows = [{ payor: focal.payor, value: focal.value, focal: true }, ...competitors.map((row) => ({ payor: row.payor, value: row.value, focal: false }))];
    return rows
        .sort((a, b) => b.value - a.value || a.payor.localeCompare(b.payor))
        .map((row) => ({ ...row, rank: rankOf(row.value, rows.filter((other) => other.payor !== row.payor).map((other) => other.value)) }));
}

function applyChanges(focalValue, competitorValues, changes) {
    let value = focalValue;
    const applied = [];
    for (const change of changes) {
        const coverage = coverageOf(value, competitorValues);
        const magnitude = marginalReach(change.reach, change.overlap, coverage);
        const marginal = change.action === 'remove' ? -magnitude : magnitude;
        value += marginal;
        applied.push({
            action: change.action,
            name: change.name,
            entityType: change.entityType,
            reach: change.reach,
            overlap: change.overlap,
            overlapSource: change.overlapSource,
            coverage,
            marginalReach: marginal,
            valueAfter: value,
        });
    }
    return { value, applied };
}

function predictChange({ focal, competitors, changes }) {
    const competitorValues = competitors.map((row) => row.value);
    const today = focal.value;
    const { value, applied } = applyChanges(today, competitorValues, changes);
    const rankToday = rankOf(today, competitorValues);
    const rankAfter = rankOf(value, competitorValues);
    const todayNeighbors = neighbors(today, competitors);
    const afterNeighbors = neighbors(value, competitors);
    return {
        baseline: {
            rank: rankToday,
            value: today,
            of: competitors.length + 1,
            reachToNextBetterRank: todayNeighbors.above ? todayNeighbors.above.value - today : null,
            reachBeforeWorseRank: todayNeighbors.below ? today - todayNeighbors.below.value : null,
            nextBetter: todayNeighbors.above,
            nextWorse: todayNeighbors.below,
        },
        predicted: {
            rank: rankAfter,
            value,
            movement: rankToday - rankAfter,
        },
        margin: {
            above: afterNeighbors.above ? { payor: afterNeighbors.above.payor, reach: afterNeighbors.above.value - value } : null,
            below: afterNeighbors.below ? { payor: afterNeighbors.below.payor, reach: value - afterNeighbors.below.value } : null,
        },
        applied,
        standings: standings({ payor: focal.payor, value }, competitors),
    };
}

function planAdditions({ focalValue, competitors, candidates, targetRank }) {
    const competitorValues = competitors.map((row) => row.value);
    const pool = candidates.map((row) => ({ ...row, action: 'add' }));
    const picks = [];
    let value = focalValue;
    while (rankOf(value, competitorValues) > targetRank && pool.length) {
        const coverage = coverageOf(value, competitorValues);
        const scored = pool.map((row) => ({ row, marginal: marginalReach(row.reach, row.overlap, coverage) }));
        scored.sort((a, b) => b.marginal - a.marginal || a.row.name.localeCompare(b.row.name));
        const best = scored[0];
        if (!best || best.marginal <= 0) break;
        value += best.marginal;
        const index = pool.indexOf(best.row);
        pool.splice(index, 1);
        picks.push({
            action: 'add',
            name: best.row.name,
            entityType: best.row.entityType,
            reach: best.row.reach,
            overlap: best.row.overlap,
            marginalReach: best.marginal,
            predictedValue: value,
            predictedRank: rankOf(value, competitorValues),
        });
    }
    return {
        picks,
        reached: rankOf(value, competitorValues) <= targetRank,
        rank: rankOf(value, competitorValues),
        value,
    };
}

function safeRemovals({ focalValue, competitors, candidates }) {
    const competitorValues = competitors.map((row) => row.value);
    const below = neighbors(focalValue, competitors).below;
    const cushion = below ? focalValue - below.value : Number.POSITIVE_INFINITY;
    const coverage = coverageOf(focalValue, competitorValues);
    return candidates
        .map((row) => ({
            action: 'remove',
            name: row.name,
            entityType: row.entityType,
            reach: row.reach,
            overlap: row.overlap,
            reachAtRisk: marginalReach(row.reach, row.overlap, coverage),
        }))
        .filter((row) => row.reachAtRisk <= cushion)
        .sort((a, b) => b.reach - a.reach || a.name.localeCompare(b.name));
}

function movementPhrase(rankToday, rankAfter, action) {
    const delta = rankAfter - rankToday;
    if (delta === 0) return `Rank ${rankToday} today, rank ${rankToday} after this ${action}.`;
    if (delta < 0) return `Rank ${rankToday} today, rank ${rankToday}−${-delta} after this addition.`;
    return `Rank ${rankToday} today, rank ${rankToday}+${delta} after this termination.`;
}

/** Reach required to attain targetRank. Gap is 0 when the network is already there. */
function reachToRank(focalValue, competitors, targetRank) {
    const values = competitors.map((row) => row.value);
    const current = rankOf(focalValue, values);
    if (current <= targetRank) return { current, already: true, gap: 0 };
    const sorted = [...values].sort((a, b) => b - a);
    if (sorted.length < targetRank) return { current, already: false, gap: null };
    const threshold = sorted[targetRank - 1];
    const payor = competitors.find((row) => row.value === threshold)?.payor ?? null;
    return { current, already: false, gap: Math.max(0, threshold - focalValue), threshold, payor };
}
exports.reachToRank = reachToRank;
