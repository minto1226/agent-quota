import {state, saveSetting, saveLayout, metricMap} from './store.js';
import {reorderProviders} from '../layout-model.js';
import {
    button,
    h,
    icon,
    numberControl,
    panel,
    row,
    switchControl,
} from './ui.js';
import {normalizeProviderOrder} from '../meter-layout.js';

export function renderGeneral(container) {
    const data = state.data;
    const settings = state.settings;
    const allIds = data.providers.map(provider => provider.id);
    const order = normalizeProviderOrder(settings['provider-order'] ?? [], allIds);
    const selected = new Set(settings.providers ?? []);
    const providerById = new Map(data.providers.map(provider => [provider.id, provider]));

    const dataPanel = panel(
        'Data',
        'Agent Quota normally reads its provider selection from config.toml. Turn this on to manage the list here.',
        row('Override configured providers',
            'Use the provider switches below instead of the agent-quota config file.',
            switchControl(Boolean(settings['override-providers']), async active => {
                await saveSetting('override-providers', active);
                renderGeneral(container);
            })),
        row('Refresh interval',
            'Seconds between quota fetches in the top-bar popup.',
            numberControl(settings['refresh-seconds'], {
                min: 10,
                max: 3600,
                onChange: value => saveSetting('refresh-seconds', value),
            })),
    );

    const syncLayoutOrder = async (fromIndex, toIndex) => {
        if (!state.layout)
            return;
        const currentIndex = state.layout.providers.findIndex(provider =>
            provider.id === order[fromIndex]);
        if (currentIndex < 0)
            return;
        const targetIndex = Math.max(0, Math.min(state.layout.providers.length - 1,
            currentIndex + (toIndex - fromIndex)));
        const nextLayout = reorderProviders(
            state.layout,
            currentIndex,
            targetIndex,
            metricMap(),
            {columns: state.layout.columns},
        );
        await saveLayout(nextLayout);
    };

    const providerRows = order.map((id, index) => {
        const provider = providerById.get(id);
        if (!provider)
            return null;
        const up = button('↑', {
            className: 'button icon',
            disabled: index === 0,
            onClick: async () => {
                const next = [...order];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                await saveSetting('provider-order', next);
                if (settings['override-providers']) {
                    const selectedIds = new Set(settings.providers ?? []);
                    await saveSetting('providers', next.filter(key => selectedIds.has(key)));
                }
                await syncLayoutOrder(index, index - 1);
                renderGeneral(container);
            },
        });
        const down = button('↓', {
            className: 'button icon',
            disabled: index === order.length - 1,
            onClick: async () => {
                const next = [...order];
                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                await saveSetting('provider-order', next);
                if (settings['override-providers']) {
                    const selectedIds = new Set(settings.providers ?? []);
                    await saveSetting('providers', next.filter(key => selectedIds.has(key)));
                }
                await syncLayoutOrder(index, index + 1);
                renderGeneral(container);
            },
        });
        const toggle = switchControl(selected.has(id), async active => {
            const next = new Set(settings.providers ?? []);
            active ? next.add(id) : next.delete(id);
            // Selecting a provider is only meaningful when the extension owns
            // the provider list; mirror the old Preferences behaviour.
            if (!settings['override-providers'])
                await saveSetting('override-providers', true);
            await saveSetting('providers', order.filter(key => next.has(key)));
            renderGeneral(container);
        });
        return h('div', {class: 'provider-order-row'},
            icon(id),
            h('span', {class: 'provider-name', text: provider.title}),
            toggle,
            h('div', {class: 'provider-actions'}, up, down));
    });

    const providersPanel = panel(
        'Displayed providers',
        settings['override-providers']
            ? 'Choose which providers appear in the popup and arrange their order.'
            : 'The popup currently follows config.toml. Changing a switch here enables the override.',
        h('div', {class: 'provider-list'}, providerRows),
    );

    container.replaceChildren(dataPanel, providersPanel);
}

