// Regressions for the GNOME extension helpers introduced after the PR #4
// review: credential-file parsing must match the Python loaders (F7), reset
// display must tolerate providers missing from the schema (F1), and the
// provider lists in extension.js/prefs.js must stay consistent with the
// schema (F1).

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

function loadModule(name) {
    const source = readFileSync(
        new URL(`../gnome-shell-extension/${name}`, import.meta.url),
        'utf8',
    );
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const {resetText, shouldShowReset} = await loadModule('reset-display.js');
const {providerHeader} = await loadModule('provider-header.js');
const {
    chunkCircleMetrics,
    chunkProviderColumns,
    circleArcAngles,
    circlePercentText,
    headerSpacingKeyForStyle,
    isPercentageMetric,
    meterFillColor,
    normalizeCircleTextPosition,
    normalizeMeterStyle,
    normalizeProviderOrder,
    orderProviderStatuses,
    paddingKeyForStyle,
    spacingKeyForStyle,
} = await loadModule('meter-layout.js');

// --- F1: reset display tolerates providers missing from the schema ---

function prefsFor(knownKeys, values = {}) {
    return {
        has: key => knownKeys.includes(key),
        getBoolean: key => values[key] ?? false,
    };
}

test('schema-unknown provider renders text metrics without touching gsettings', () => {
    const prefs = prefsFor(['show-reset-when-full-claude']);
    const moonshotMetric = {label: 'Balance', value: '$4.20', pct: null, reset: '—'};
    assert.equal(shouldShowReset(prefs, moonshotMetric, 'moonshot'), false);
    assert.equal(resetText(prefs, moonshotMetric, 'moonshot'), '—');
});

test('schema-unknown provider with a full percentage falls back to no reset', () => {
    const prefs = prefsFor([], {'show-reset-when-full-moonshot': true});
    const metric = {label: 'Credits', value: '100%', pct: 100, reset: '—'};
    // The key exists in neither the schema (has() is false) nor gsettings.
    assert.equal(shouldShowReset(prefs, metric, 'moonshot'), false);
    assert.equal(resetText(prefs, metric, 'moonshot'), '—');
});

test('known provider honours the show-reset-when-full preference', () => {
    const key = 'show-reset-when-full-claude';
    const full = {label: '7d', value: '100%', pct: 99.96, reset: '—'};
    assert.equal(shouldShowReset(prefsFor([key], {[key]: true}), full, 'claude'), true);
    assert.equal(resetText(prefsFor([key], {[key]: true}), full, 'claude'), 'No reset scheduled');
    assert.equal(shouldShowReset(prefsFor([key], {[key]: false}), full, 'claude'), false);
    assert.equal(resetText(prefsFor([key], {[key]: false}), full, 'claude'), '—');
});

test('metrics with a scheduled reset always show it', () => {
    const prefs = prefsFor([]);
    const metric = {label: '5h', value: '20%', pct: 20, reset: 'in 3h'};
    assert.equal(shouldShowReset(prefs, metric, 'codex'), true);
    assert.equal(resetText(prefs, metric, 'codex'), 'in 3h');
});

// --- popup header user-information switch ---

const accountStatus = {
    key: 'claude',
    name: 'Claude',
    plan: 'Max 5x',
    user: 'person@example.com',
    source: 'browser cookies',
};

test('user information on keeps the original plan and user header', () => {
    assert.equal(providerHeader(accountStatus, true), 'Max 5x · person@example.com');
    // The default argument preserves the header for callers that omit it.
    assert.equal(providerHeader(accountStatus), 'Max 5x · person@example.com');
});

test('user information off leaves only the plan', () => {
    assert.equal(providerHeader(accountStatus, false), 'Max 5x');
    assert.equal(providerHeader({plan: 'Pro', user: 'a@b.c', source: 'account'}, false), 'Pro');
});

test('user information off never leaks the source fallback', () => {
    const colab = {plan: 'Google AI Plans', user: '', source: 'colab-cli oauth'};
    assert.equal(providerHeader(colab, true), 'Google AI Plans');
    assert.equal(providerHeader(colab, false), 'Google AI Plans');
    const anonymous = {...colab, plan: ''};
    assert.equal(providerHeader(anonymous, true), 'colab-cli oauth');
    assert.equal(providerHeader(anonymous, false), '');
});

test('user information off tolerates missing fields without separators', () => {
    assert.equal(providerHeader({}, false), '');
    assert.equal(providerHeader({plan: null, user: null, source: null}, false), '');
    assert.equal(providerHeader({plan: '', user: 'person@example.com', source: 'account'}, false), '');
    assert.equal(providerHeader({plan: null, user: null, source: null}, true), '');
});

test('header rendering never mutates the provider payload', () => {
    const status = {
        key: 'codex',
        name: 'Codex',
        plan: 'Plus',
        user: 'a@b.c',
        source: 'browser cookies',
        metrics: [{label: '7d', value: '80%'}],
    };
    const snapshot = JSON.stringify(status);
    providerHeader(status, true);
    providerHeader(status, false);
    assert.equal(JSON.stringify(status), snapshot);
});

// --- F1: provider lists stay consistent with the schema ---

const extensionDir = new URL('../gnome-shell-extension/', import.meta.url);
const extensionSource = readFileSync(new URL('extension.js', extensionDir), 'utf8');
const prefsSource = readFileSync(new URL('prefs.js', extensionDir), 'utf8');
const schema = readFileSync(
    new URL('schemas/org.gnome.shell.extensions.agent-quota.gschema.xml', extensionDir),
    'utf8',
);

function listLiteral(source, name) {
    const match = source.match(String.raw`const ${name} = (?:new Set\()?\[([^\]]*)\]`);
    assert.ok(match, `${name} not found`);
    return match[1].split(',').map(item => item.trim().replaceAll("'", ''));
}

function providerIds(source) {
    const match = source.match(/const PROVIDERS = \[([\s\S]*?)\];/);
    assert.ok(match, 'PROVIDERS not found');
    return [...match[1].matchAll(/id: '([^']+)'/g)].map(match => match[1]);
}

const providerKeys = listLiteral(extensionSource, 'PROVIDER_KEYS');
const prefsIds = providerIds(prefsSource);
const defaultProviders = schema.match(/<key name="providers"[\s\S]*?<default>([^<]*)<\/default>/)[1];

test('every extension provider has a reset schema key and default entry', () => {
    assert.ok(providerKeys.includes('moonshot'));
    for (const key of providerKeys) {
        assert.ok(
            schema.includes(`name="show-reset-when-full-${key}"`),
            `schema lacks show-reset-when-full-${key}`,
        );
        assert.ok(defaultProviders.includes(`'${key}'`), `providers default lacks ${key}`);
    }
});

test('preferences cover every extension provider', () => {
    for (const key of providerKeys)
        assert.ok(prefsIds.includes(key), `prefs PROVIDERS lacks ${key}`);
});

test('cookie-browser keys only exist for providers that honour --browser', () => {
    const browserKeys = listLiteral(extensionSource, 'BROWSER_PROVIDER_KEYS');
    assert.ok(!browserKeys.includes('go'), 'Go no longer uses cookie auth');
    for (const key of browserKeys)
        assert.ok(schema.includes(`name="browser-${key}"`), `schema lacks browser-${key}`);
    assert.ok(!schema.includes('name="browser-go"'));
    assert.ok(!schema.includes('name="compact-go-user"'));
});

// --- show-user-info: default-on schema key, preferences switch, and wiring ---

test('show-user-info schema key defaults to true', () => {
    const match = schema.match(/<key name="show-user-info" type="b">([\s\S]*?)<\/key>/);
    assert.ok(match, 'schema lacks show-user-info');
    assert.match(match[1], /<default>true<\/default>/);
    assert.match(match[1], /<summary>[^<]+<\/summary>/);
});

test('preferences expose Show user information under Appearance → Popup', () => {
    assert.match(
        prefsSource,
        /const popup = new Adw\.PreferencesGroup\(\{title: 'Popup'\}\);/,
    );
    assert.match(
        prefsSource,
        /addSwitch\(popup, settings, 'show-user-info', 'Show user information'/,
    );
});

test('extension renders headers through provider-header.js and the setting', () => {
    assert.match(extensionSource, /import \{providerHeader\} from '\.\/provider-header\.js';/);
    assert.match(extensionSource, /get_boolean\('show-user-info'\)/);
    assert.match(extensionSource, /providerHeader\(status, showUserInfo\)/);
    assert.ok(!/function displayUser\(/.test(extensionSource), 'displayUser must live in provider-header.js');
    // The generic `changed` fallback rerenders from the cached payload; the
    // switch must not trigger a provider refetch.
    assert.ok(!extensionSource.includes("key === 'show-user-info'"));
});

// --- meter-style: circular progress layout helpers, schema, and preferences ---

test('normalizeMeterStyle defaults to circle and accepts bar', () => {
    assert.equal(normalizeMeterStyle('circle'), 'circle');
    assert.equal(normalizeMeterStyle('bar'), 'bar');
    assert.equal(normalizeMeterStyle(''), 'circle');
    assert.equal(normalizeMeterStyle(null), 'circle');
    assert.equal(normalizeMeterStyle(undefined), 'circle');
    assert.equal(normalizeMeterStyle('unknown'), 'circle');
});

test('normalizeCircleTextPosition defaults to below and accepts right', () => {
    assert.equal(normalizeCircleTextPosition('below'), 'below');
    assert.equal(normalizeCircleTextPosition('right'), 'right');
    assert.equal(normalizeCircleTextPosition(''), 'below');
    assert.equal(normalizeCircleTextPosition(null), 'below');
    assert.equal(normalizeCircleTextPosition(undefined), 'below');
});

test('isPercentageMetric distinguishes numeric percentages from text-only balances', () => {
    assert.equal(isPercentageMetric({label: '5h', value: '0%', pct: 0}), true);
    assert.equal(isPercentageMetric({label: '7d', value: '100%', pct: 100}), true);
    assert.equal(isPercentageMetric({label: 'Balance', value: '$4.20', pct: null}), false);
    assert.equal(isPercentageMetric({label: 'Balance', value: '$4.20'}), false);
    assert.equal(isPercentageMetric(null), false);
});

test('chunkCircleMetrics packs compact 3-window providers into a single 3-column row', () => {
    const claudeMetrics = [
        {label: '5h', value: '100%', pct: 100},
        {label: '7d', value: '89%', pct: 89},
        {label: 'Fable 7d', value: '89%', pct: 89},
    ];
    const rows = chunkCircleMetrics(claudeMetrics);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].map(m => m.label), ['5h', '7d', 'Fable 7d']);
});

test('chunkCircleMetrics arranges metrics in column-major order across configured columns', () => {
    const geminiMetrics = [
        {label: 'Gemini 5h', value: '99%', pct: 99},
        {label: 'C/C 5h', value: '100%', pct: 100},
        {label: 'Gemini 7d', value: '99%', pct: 99},
        {label: 'C/C 7d', value: '100%', pct: 100},
        {label: 'Argon 7d', value: '90%', pct: 90},
    ];
    assert.deepEqual(
        chunkCircleMetrics(geminiMetrics, 3).map(row => row.map(m => m.label)),
        [
            ['Gemini 5h', 'Gemini 7d', 'Argon 7d'],
            ['C/C 5h', 'C/C 7d'],
        ],
    );
    assert.deepEqual(
        chunkCircleMetrics(geminiMetrics, 2).map(row => row.map(m => m.label)),
        [
            ['Gemini 5h', 'C/C 7d'],
            ['C/C 5h', 'Argon 7d'],
            ['Gemini 7d'],
        ],
    );
    assert.deepEqual(
        chunkCircleMetrics(geminiMetrics, 1).map(row => row.length),
        [1, 1, 1, 1, 1],
    );
});

test('chunkCircleMetrics skips non-percentage metrics', () => {
    const mixed = [
        {label: 'Balance', value: '$10.00', pct: null},
    ];
    assert.deepEqual(chunkCircleMetrics(mixed), []);
});

test('chunkProviderColumns splits providers by column count or explicit break keys', () => {
    const statuses = [
        {key: 'claude'},
        {key: 'codex'},
        {key: 'zai'},
        {key: 'gemini'},
        {key: 'go'},
    ];
    assert.deepEqual(
        chunkProviderColumns(statuses, 1, []).map(col => col.map(s => s.key)),
        [['claude', 'codex', 'zai', 'gemini', 'go']],
    );
    assert.deepEqual(
        chunkProviderColumns(statuses, 2, []).map(col => col.map(s => s.key)),
        [
            ['claude', 'codex', 'zai'],
            ['gemini', 'go'],
        ],
    );
    assert.deepEqual(
        chunkProviderColumns(statuses, 1, ['zai', 'go']).map(col => col.map(s => s.key)),
        [
            ['claude', 'codex'],
            ['zai', 'gemini'],
            ['go'],
        ],
    );
});

test('normalizeProviderOrder and orderProviderStatuses sort providers while preserving multi-workspace order', () => {
    assert.deepEqual(
        normalizeProviderOrder(['gemini', 'claude'], ['claude', 'codex', 'gemini', 'go']),
        ['gemini', 'claude', 'codex', 'go'],
    );
    const statuses = [
        {key: 'claude', workspace_id: ''},
        {key: 'codex', workspace_id: 'ws-1'},
        {key: 'codex', workspace_id: 'ws-2'},
        {key: 'gemini', workspace_id: ''},
    ];
    assert.deepEqual(
        orderProviderStatuses(statuses, ['gemini', 'codex', 'claude']).map(s => `${s.key}:${s.workspace_id}`),
        ['gemini:', 'codex:ws-1', 'codex:ws-2', 'claude:'],
    );
    assert.deepEqual(
        orderProviderStatuses(statuses, []).map(s => `${s.key}:${s.workspace_id}`),
        ['claude:', 'codex:ws-1', 'codex:ws-2', 'gemini:'],
    );
});

test('meterFillColor returns palette RGBA tuples for ok, warning, critical, and muted states', () => {
    assert.equal(meterFillColor('ok', true, false).length, 4);
    assert.notDeepEqual(meterFillColor('ok', true, false), meterFillColor('warning', true, false));
    assert.notDeepEqual(meterFillColor('warning', true, false), meterFillColor('critical', true, false));
    assert.deepEqual(meterFillColor('ok', false, false), meterFillColor('critical', true, false));
    assert.notDeepEqual(meterFillColor('ok', true, true), meterFillColor('ok', true, false));
});

test('circlePercentText clamps and rounds percentages for inside-ring display', () => {
    assert.equal(circlePercentText(100), '100%');
    assert.equal(circlePercentText(89.4), '89%');
    assert.equal(circlePercentText(27.68), '28%');
    assert.equal(circlePercentText(-5), '0%');
    assert.equal(circlePercentText(120), '100%');
});

test('circleArcAngles decreases clockwise from 12 oclock as quota is consumed', () => {
    assert.equal(circleArcAngles(0), null);
    assert.deepEqual(circleArcAngles(100), {full: true, startAngle: 0, endAngle: 2 * Math.PI});

    const arc90 = circleArcAngles(90);
    const arc50 = circleArcAngles(50);
    const arc28 = circleArcAngles(28);
    assert.equal(arc90.full, false);
    assert.equal(arc90.endAngle, 1.5 * Math.PI);
    assert.equal(arc50.endAngle, 1.5 * Math.PI);
    assert.equal(arc28.endAngle, 1.5 * Math.PI);
    // As remaining quota drops from 90% -> 50% -> 28%, startAngle advances
    // clockwise (increasing angle) toward 12 o'clock (1.5 * PI).
    assert.ok(arc90.startAngle < arc50.startAngle);
    assert.ok(arc50.startAngle < arc28.startAngle);
    assert.ok(arc28.startAngle < arc28.endAngle);
});

test('paddingKeyForStyle, headerSpacingKeyForStyle, and spacingKeyForStyle keep separate keys for circle and bar', () => {
    assert.equal(paddingKeyForStyle('circle'), 'circle-provider-padding');
    assert.equal(paddingKeyForStyle('bar'), 'provider-padding');
    assert.equal(headerSpacingKeyForStyle('circle'), 'circle-header-spacing');
    assert.equal(headerSpacingKeyForStyle('bar'), 'header-spacing');
    assert.equal(spacingKeyForStyle('circle'), 'circle-metric-spacing');
    assert.equal(spacingKeyForStyle('bar'), 'metric-spacing');
    assert.ok(schema.includes('name="circle-provider-padding"'));
    assert.ok(schema.includes('name="header-spacing"'));
    assert.ok(schema.includes('name="circle-header-spacing"'));
    assert.ok(schema.includes('name="circle-metric-spacing"'));
    assert.ok(schema.includes('name="circle-radius"'));
    assert.ok(schema.includes('name="circle-columns"'));
    assert.ok(schema.includes('name="provider-order"'));
    assert.ok(schema.includes('name="provider-columns"'));
    assert.ok(schema.includes('name="provider-column-spacing"'));
    assert.ok(schema.includes('name="provider-column-breaks"'));
    assert.ok(schema.includes('name="circle-text-position"'));
});

test('meter-style schema key defaults to circle and is wired into prefs and extension', () => {
    const match = schema.match(/<key name="meter-style" type="s">([\s\S]*?)<\/key>/);
    assert.ok(match, 'schema lacks meter-style');
    assert.match(match[1], /<default>'circle'<\/default>/);
    assert.match(prefsSource, /addMeterStyle\(popup, settings\)/);
    assert.match(extensionSource, /get_string\('meter-style'\)/);
    assert.ok(!extensionSource.includes("key === 'meter-style'"));
});
