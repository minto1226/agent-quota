import {state, saveSecret, saveSetting, showToast} from './store.js';
import {
    button,
    h,
    icon,
    panel,
    providerPill,
    row,
    selectControl,
    statusPill,
    switchControl,
} from './ui.js';

function workspaceSelection(availableIds, configuredIds, workspaceId, active) {
    const available = [...new Set(availableIds)];
    const known = new Set(available);
    const next = configuredIds.length
        ? new Set(configuredIds)
        : new Set(available);
    active ? next.add(workspaceId) : next.delete(workspaceId);

    const visible = available.filter(id => next.has(id));
    if (!visible.length)
        return null;

    const unavailable = [...new Set(configuredIds)].filter(id => !known.has(id));
    if (visible.length === available.length && !unavailable.length)
        return [];
    return [...visible, ...unavailable];
}

function orderedHiddenMetrics(hidden, metricOptions) {
    const ordered = [];
    for (const [provider, labels] of Object.entries(metricOptions ?? {})) {
        for (const label of labels) {
            const entry = `${provider}:${label}`;
            if (hidden.has(entry))
                ordered.push(entry);
        }
    }
    return ordered;
}

function secretEditor(provider, rerender) {
    const secret = provider.secret;
    const configured = Boolean(state.data.secrets[provider.id]);
    const input = h('input', {
        type: 'password',
        placeholder: secret.label,
        autocomplete: 'new-password',
        spellcheck: false,
    });
    const status = statusPill(configured ? 'Configured' : 'Not configured', configured ? '' : 'muted');
    const save = button('Save', {
        className: 'button primary',
        onClick: async () => {
            if (!input.value) {
                showToast('Enter a value first.', true);
                return;
            }
            try {
                const next = await saveSecret(provider.id, secret.key, input.value);
                input.value = '';
                status.textContent = next ? 'Configured' : 'Not configured';
                status.className = `pill ${next ? '' : 'muted'}`;
                clear.disabled = !next;
                showToast(`${provider.title} credential saved.`);
            } catch (_error) {
                // saveSecret already surfaced the error.
            }
        },
    });
    const clear = button('Clear', {
        className: 'button danger',
        disabled: !configured,
        onClick: async () => {
            try {
                await saveSecret(provider.id, secret.key, '');
                status.textContent = 'Not configured';
                status.className = 'pill muted';
                clear.disabled = true;
                showToast(`${provider.title} credential cleared.`);
            } catch (_error) {
                // saveSecret already surfaced the error.
            }
        },
    });

    return h('div', {class: 'row secret-row'},
        h('div', {class: 'row-copy'},
            h('div', {class: 'row-title'}, secret.label, ' ', status),
            h('div', {class: 'row-desc',
                text: `Stored in ~/.config/agent-quota/${provider.id}.conf with 0600 permissions. The existing value is never sent to this page.`})),
        h('div', {class: 'secret-controls'}, input, save, clear));
}

function workspaceEditor(provider, rerender) {
    const options = state.data.workspaces ?? [];
    if (!options.length) {
        return row('Displayed workspaces',
            'Open the Agent Quota popup once to detect the Codex workspaces available to this account.',
            statusPill('Not detected', 'muted'));
    }
    const allIds = options.map(option => option.id);
    const configured = state.settings['codex-workspaces'] ?? [];
    const selected = configured.length ? new Set(configured) : new Set(allIds);
    const rows = options.map(option => {
        const toggle = switchControl(selected.has(option.id), async active => {
            const next = workspaceSelection(allIds, configured, option.id, active);
            if (next === null) {
                showToast('At least one Codex workspace must remain visible.', true);
                renderProviders(document.getElementById('content'));
                return;
            }
            await saveSetting('codex-workspaces', next);
            renderProviders(document.getElementById('content'));
        });
        return h('div', {class: 'row'},
            h('div', {class: 'row-copy'},
                h('div', {class: 'row-title', text: option.label}),
                h('div', {class: 'row-desc', text: option.id})),
            h('div', {class: 'row-control'}, toggle));
    });
    const label = configured.length
        ? `${options.filter(option => selected.has(option.id)).length} of ${options.length} shown`
        : `All ${options.length} detected workspaces are shown`;
    return h('div', {},
        row('Displayed workspaces', label,
            button('Show all', {
                className: 'button ghost',
                onClick: async () => {
                    await saveSetting('codex-workspaces', []);
                    renderProviders(document.getElementById('content'));
                },
            })),
        rows);
}

function gaugeEditor(provider, rerender) {
    const labels = state.data.metricOptions[provider.id] ?? [];
    if (!labels.length) {
        return row('Displayed bars',
            'Open the Agent Quota popup once so detected gauges can be listed here.',
            statusPill('Not detected', 'muted'));
    }
    const hidden = new Set(state.settings['hidden-metrics'] ?? []);
    const toggles = labels.map(label => {
        const entry = `${provider.id}:${label}`;
        const input = h('input', {type: 'checkbox', checked: !hidden.has(entry)});
        input.addEventListener('change', async () => {
            const current = new Set(state.settings['hidden-metrics'] ?? []);
            input.checked ? current.delete(entry) : current.add(entry);
            const next = orderedHiddenMetrics(current, state.data.metricOptions);
            await saveSetting('hidden-metrics', next);
        });
        return h('label', {class: 'gauge-toggle'}, input, h('span', {text: label}));
    });
    const hiddenHere = labels.filter(label => hidden.has(`${provider.id}:${label}`)).length;
    return h('div', {},
        row('Displayed bars',
            'Choose which gauges appear for this provider.',
            hiddenHere
                ? h('button', {
                    class: 'button ghost',
                    type: 'button',
                    text: 'Show all',
                    onClick: async () => {
                        const next = new Set(state.settings['hidden-metrics'] ?? []);
                        for (const label of labels)
                            next.delete(`${provider.id}:${label}`);
                        await saveSetting('hidden-metrics', [...next]);
                        renderProviders(document.getElementById('content'));
                    },
                })
                : statusPill('All shown', 'muted')),
        h('div', {class: 'gauge-toggle-list'}, toggles));
}

function browserEditor(provider) {
    if (!provider.browser)
        return null;
    const key = `browser-${provider.id}`;
    const browsers = state.data.browsers ?? [''];
    const options = [
        {value: '', label: 'Automatic'},
        ...browsers.filter(browser => browser).map(browser => ({
            value: browser,
            label: browser[0].toUpperCase() + browser.slice(1),
        })),
    ];
    return row('Cookie browser',
        'Choose the signed-in browser. Automatic tries the normal browser order.',
        selectControl(options, state.settings[key] ?? '', value => {
            state.settings[key] = value;
            saveSetting(key, value);
        }));
}

function providerBody(provider) {
    const parts = [];
    if (provider.login) {
        parts.push(row('Sign in or refresh session',
            'Opens the provider in your browser. Return here after signing in.',
            button('Open', {
                className: 'button ghost',
                onClick: () => window.open(provider.login, '_blank', 'noopener,noreferrer'),
            })));
    }
    if (provider.command) {
        parts.push(row('Sign in',
            `Run ${provider.command} in a terminal to authenticate, then reopen the popup.`,
            button('Copy command', {
                className: 'button ghost',
                onClick: async () => {
                    try {
                        await navigator.clipboard.writeText(provider.command);
                        showToast('Command copied.');
                    } catch (_error) {
                        showToast('Could not copy the command.', true);
                    }
                },
            })));
    }
    const browser = browserEditor(provider);
    if (browser)
        parts.push(browser);
    if (provider.id === 'codex')
        parts.push(workspaceEditor(provider));
    if (provider.secret)
        parts.push(secretEditor(provider));
    parts.push(gaugeEditor(provider));
    return h('div', {class: 'provider-body'}, parts);
}

export function renderProviders(container) {
    const cards = state.data.providers.map(provider => {
        const details = h('details', {class: 'panel provider-card', open: false});
        const summary = h('summary', {class: 'provider-summary'},
            icon(provider.id),
            h('span', {class: 'provider-name', text: provider.title}),
            providerPill(provider),
            h('span', {class: 'nav-glyph', text: '⌄'}));
        details.append(summary, providerBody(provider));
        return details;
    });
    container.replaceChildren(
        panel('Providers',
            'Authentication and per-provider display options. Credentials are write-only.',
            h('div', {class: 'hint',
                text: 'Browser cookies are read by the backend, never by this page. API keys are written directly to provider config files.'})),
        ...cards,
    );
}
