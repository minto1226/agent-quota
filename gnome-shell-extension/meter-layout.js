// Layout helpers for the popup quota meters, shared between extension.js, prefs.js, and tests.

export function normalizeMeterStyle(style) {
    return style === 'bar' ? 'bar' : 'circle';
}

export function normalizeCircleTextPosition(position) {
    return position === 'right' ? 'right' : 'below';
}

export function paddingKeyForStyle(style) {
    return normalizeMeterStyle(style) === 'circle' ? 'circle-provider-padding' : 'provider-padding';
}

export function headerSpacingKeyForStyle(style) {
    return normalizeMeterStyle(style) === 'circle' ? 'circle-header-spacing' : 'header-spacing';
}

export function spacingKeyForStyle(style) {
    return normalizeMeterStyle(style) === 'circle' ? 'circle-metric-spacing' : 'metric-spacing';
}

export function isPercentageMetric(metric) {
    return Boolean(metric && metric.pct !== null && metric.pct !== undefined);
}

export function circlePercentText(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    return `${Math.round(clamped)}%`;
}

export function chunkCircleMetrics(metrics, columns = 3) {
    const items = (metrics ?? []).filter(isPercentageMetric);
    if (!items.length)
        return [];

    const cols = Math.max(1, Math.trunc(Number(columns) || 3));
    const rowCount = Math.ceil(items.length / cols);
    const rows = Array.from({length: rowCount}, () => []);
    for (let r = 0; r < rowCount; r++) {
        for (let c = 0; c < cols; c++) {
            const index = c * rowCount + r;
            if (index < items.length)
                rows[r].push(items[index]);
        }
    }
    return rows;
}

export function chunkProviderColumns(statuses, columns = 1, breakBeforeKeys = []) {
    const items = statuses ?? [];
    if (!items.length)
        return [];

    const breakSet = new Set(breakBeforeKeys ?? []);
    const hasManualBreaks = items.some((status, index) => index > 0 && breakSet.has(status.key));
    const targetCols = Math.max(1, Math.trunc(Number(columns) || 1));

    if (hasManualBreaks) {
        const result = [[]];
        for (let i = 0; i < items.length; i++) {
            const status = items[i];
            if (i > 0 && breakSet.has(status.key))
                result.push([]);
            result[result.length - 1].push(status);
        }
        return result;
    }

    if (targetCols <= 1)
        return [items];

    const perCol = Math.ceil(items.length / targetCols);
    const result = [];
    for (let i = 0; i < items.length; i += perCol)
        result.push(items.slice(i, i + perCol));
    return result;
}

export function normalizeProviderOrder(order, allKeys = []) {
    const seen = new Set();
    const result = [];
    for (const key of order ?? []) {
        if (typeof key === 'string' && key && !seen.has(key) && (!allKeys.length || allKeys.includes(key))) {
            seen.add(key);
            result.push(key);
        }
    }
    for (const key of allKeys) {
        if (!seen.has(key)) {
            seen.add(key);
            result.push(key);
        }
    }
    return result;
}

export function orderProviderStatuses(statuses, providerOrder = []) {
    const items = statuses ?? [];
    const order = (providerOrder ?? []).filter(Boolean);
    if (!items.length || !order.length)
        return [...items];

    const rank = new Map(order.map((key, index) => [key, index]));
    return items
        .map((status, index) => ({
            status,
            rank: rank.has(status.key) ? rank.get(status.key) : order.length,
            index,
        }))
        .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
        .map(entry => entry.status);
}

export function circleArcAngles(pct, strokeWidth = 3, radius = 15) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (clamped <= 0)
        return null;
    if (clamped >= 99.95)
        return {full: true, startAngle: 0, endAngle: 2 * Math.PI};

    // Decrease clockwise from 12 o'clock: the consumed gap grows clockwise
    // from -PI/2, so the remaining arc runs clockwise from startAngle up to
    // 3*PI/2 (12 o'clock).
    const endAngle = 1.5 * Math.PI;
    const safeRadius = Math.max(1, radius);
    const maxSweep = Math.max(0.2, 2 * Math.PI - (strokeWidth / safeRadius) - 0.18);
    const sweep = Math.max(0.08, (clamped / 100) * maxSweep);
    return {
        full: false,
        startAngle: endAngle - sweep,
        endAngle,
    };
}

export function meterFillColor(state, isRemaining = true, muted = false) {
    if (muted)
        return [0x6f / 255, 0x8f / 255, 0x78 / 255, 1.0];
    if (!isRemaining)
        return [0xff / 255, 0x7b / 255, 0x72 / 255, 1.0];
    if (state === 'critical')
        return [0xff / 255, 0x7b / 255, 0x72 / 255, 1.0];
    if (state === 'warning')
        return [0xf8 / 255, 0xe4 / 255, 0x5c / 255, 1.0];
    return [0x8f / 255, 0xf0 / 255, 0xa4 / 255, 1.0];
}
