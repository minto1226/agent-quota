import {
    defaultLayout,
    layoutGrid,
    moveGauge,
    moveProvider,
    packLayout,
    parseLayout,
    reorderProviders,
    setProviderGaugeColumns,
} from '../layout-model.js';
import {
    circlePercentText,
    gaugeArcAngles,
    GAUGE_END_ANGLE,
    GAUGE_START_ANGLE,
} from '../meter-layout.js';
import {
    metricMap,
    providerTitle,
    saveLayout,
    saveSetting,
    showToast,
    state,
} from './store.js';
import {
    button,
    h,
    icon,
    numberControl,
    panel,
    row,
    selectControl,
    statusPill,
    switchControl,
} from './ui.js';

const SAMPLE_PERCENT = 72;
const history = [];
const redo = [];

function gridOptions(settings) {
    const radius = Math.max(10, Math.min(32, Number(settings['circle-radius']) || 16));
    const padding = Math.max(0, Number(settings['layout-padding']) || 0);
    const gaugeSpacing = Math.max(0, Number(settings['layout-gauge-spacing']) || 0);
    const metricSpacing = Math.max(0, Number(settings['circle-metric-spacing']) || 0);
    const labelFont = Number(settings['gauge-label-font-size']) || 11;
    const resetFont = Number(settings['gauge-reset-font-size']) || 10;
    const configuredFont = Number(settings['gauge-percent-font-size']) || 0;
    const percentFont = configuredFont > 0 ? configuredFont : Math.max(7, Number((radius * 0.53).toFixed(1)));
    const offset = radius * (Number(settings['gauge-percent-offset']) || 0) / 100;
    const stroke = Math.max(2.2, Number((radius * 0.19).toFixed(1)));
    const centerY = radius + stroke / 2;
    // The preview needs room for the whole ring, not only the lower arc
    // intersection. The real popup's fixed cell can overflow its text if this
    // is too tight; matching the ring diameter here keeps labels readable.
    const gaugeHeight = Math.ceil(2 * radius + stroke + 2);
    const hasReset = true;
    const cellHeight = Math.ceil(gaugeHeight + metricSpacing + labelFont * 1.4
        + (hasReset ? resetFont * 1.4 + 2 : 0) + 8) + 2 * padding;
    return {
        radius,
        padding,
        gaugeSpacing,
        metricSpacing,
        labelFont,
        resetFont,
        percentFont,
        offset,
        stroke,
        gaugeHeight,
        cellWidth: Math.max(56, Math.ceil(2 * radius + 24)) + 2 * padding,
        headerHeight: 24 + 2 * padding,
        cellHeight,
    };
}

function rowOffsets(rowHeights, gap) {
    const offsets = [];
    let cursor = 0;
    for (let index = 0; index < rowHeights.length; index++) {
        offsets[index] = cursor;
        cursor += rowHeights[index] + (index < rowHeights.length - 1 ? gap : 0);
    }
    return offsets;
}

function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(upper, value));
}

function drawGauge(canvas, options) {
    const {radius, stroke, percentFont, offset} = options;
    const width = Math.ceil(radius * 2 + stroke + 2);
    const height = Math.ceil(radius * 2 + stroke + 2);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.scale(dpr, dpr);
    const cx = width / 2;
    const cy = radius + stroke / 2;
    context.lineWidth = stroke;
    context.lineCap = 'butt';
    context.strokeStyle = 'rgba(127,127,127,0.28)';
    context.beginPath();
    context.arc(cx, cy, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    context.stroke();
    const arc = gaugeArcAngles(SAMPLE_PERCENT, stroke, radius);
    if (arc) {
        context.strokeStyle = '#57e389';
        context.beginPath();
        context.arc(cx, cy, radius, arc.startAngle, arc.endAngle);
        context.stroke();
    }
    const text = circlePercentText(SAMPLE_PERCENT, state.settings['gauge-percent']);
    if (text) {
        context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('color') || '#eeeeef';
        context.font = `600 ${percentFont}px Cantarell, system-ui, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, cx, cy + offset);
    }
    return {width, height};
}

function makeGauge(provider, gauge, options, handlers) {
    const element = h('div', {
        class: 'layout-gauge',
        dataset: {provider: provider.id, label: gauge.label},
        tabIndex: 0,
    });
    element.style.left = `${gauge.x - provider.card.x}px`;
    element.style.top = `${gauge.y - provider.card.y}px`;
    element.style.width = `${gauge.width}px`;
    element.style.height = `${gauge.height}px`;
    element.title = `Drag ${gauge.label} to reorder`;
    const canvas = h('canvas');
    drawGauge(canvas, options);
    element.append(canvas);
    element.append(h('div', {class: 'layout-gauge-label', text: gauge.label}));
    element.append(h('div', {class: 'layout-gauge-reset', text: '2h'}));
    element.addEventListener('pointerdown', event => {
        if (event.button !== 0)
            return;
        handlers.startGaugeDrag(event, element, provider, gauge);
    });
    return element;
}

function startProviderDrag(event, card, header, provider, grid, options, layout, commit) {
    if (event.target.closest('button, input, select'))
        return;
    event.preventDefault();
    const canvas = card.parentElement;
    const rect = canvas.getBoundingClientRect();
    const scale = Number(canvas.dataset.scale) || 1;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = moveEvent => {
        const dx = (moveEvent.clientX - startX) / scale;
        const dy = (moveEvent.clientY - startY) / scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
            moved = true;
        card.style.transform = `translate(${dx}px, ${dy}px)`;
        card.classList.add('dragging');
    };
    const onUp = upEvent => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        card.classList.remove('dragging');
        card.style.transform = '';
        if (!moved)
            return;
        const localX = (upEvent.clientX - rect.left) / scale;
        const localY = (upEvent.clientY - rect.top) / scale;
        const pitch = options.cellWidth + options.gaugeSpacing;
        const col = clamp(Math.floor(localX / pitch), 0, Math.max(0, layout.columns - provider.w));
        const offsets = rowOffsets(grid.rowHeights, options.gaugeSpacing);
        let row = 0;
        for (let index = 0; index < offsets.length; index++) {
            if (localY >= offsets[index])
                row = index;
        }
        const next = moveProvider(layout, provider.id, col, row, metricMap(), {columns: layout.columns});
        commit(next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, {once: true});
}

function startGaugeDrag(event, element, provider, gauge, grid, layout, commit) {
    event.preventDefault();
    event.stopPropagation();
    const canvas = element.closest('.layout-canvas');
    const rect = canvas.getBoundingClientRect();
    const scale = Number(canvas.dataset.scale) || 1;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = moveEvent => {
        const dx = (moveEvent.clientX - startX) / scale;
        const dy = (moveEvent.clientY - startY) / scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
            moved = true;
        element.style.transform = `translate(${dx}px, ${dy}px)`;
        element.classList.add('dragging');
    };
    const onUp = upEvent => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        element.classList.remove('dragging');
        element.style.transform = '';
        if (!moved)
            return;
        const localX = (upEvent.clientX - rect.left) / scale;
        const localY = (upEvent.clientY - rect.top) / scale;
        const current = grid.providers.find(item => item.id === provider.id);
        if (!current)
            return;
        let targetIndex = current.gauges.length - 1;
        let best = Number.POSITIVE_INFINITY;
        current.gauges.forEach((candidate, index) => {
            const cx = candidate.x + candidate.width / 2;
            const cy = candidate.y + candidate.height / 2;
            const distance = (localX - cx) ** 2 + (localY - cy) ** 2;
            if (distance < best) {
                best = distance;
                targetIndex = index;
            }
        });
        const sourceIndex = (current.order ?? []).indexOf(gauge.label);
        if (sourceIndex < 0)
            return;
        const next = moveGauge(layout, provider.id, sourceIndex, targetIndex);
        commit(next);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, {once: true});
}

function providerHeader(provider, gridProvider) {
    const header = h('div', {class: 'layout-header'});
    header.style.left = `${gridProvider.header.x - gridProvider.card.x}px`;
    header.style.top = `${gridProvider.header.y - gridProvider.card.y}px`;
    header.style.width = `${gridProvider.header.width}px`;
    header.style.height = `${gridProvider.header.height}px`;
    header.append(icon(provider.id));
    const text = h('div', {style: 'min-width:0;flex:1;'});
    text.append(h('div', {class: 'layout-provider-title', text: provider.title}));
    text.append(h('div', {
        class: 'layout-provider-sub',
        text: `${gridProvider.gaugeColumns} gauge${gridProvider.gaugeColumns === 1 ? '' : 's'}`,
    }));
    header.append(text);
    return header;
}

export function renderLayout(container) {
    const data = state.data;
    const settings = state.settings;
    const metrics = metricMap();
    let layout = state.layout;

    const options = gridOptions(settings);
    const grid = layoutGrid(layout, metrics, {
        cellWidth: options.cellWidth,
        columnGap: options.gaugeSpacing,
        rowGap: options.gaugeSpacing,
        headerHeight: options.headerHeight,
        cellHeight: options.cellHeight,
        padding: options.padding,
        cardGap: Number(settings['layout-gap']) || 0,
    });

    const commit = next => {
        if (!next)
            return;
        history.push(JSON.stringify(layout));
        if (history.length > 60)
            history.shift();
        redo.length = 0;
        layout = packLayout(next, metrics, {columns: next.columns});
        state.layout = layout;
        saveLayout(layout).catch(() => {});
        renderLayout(container);
    };
    const applyWithoutHistory = next => {
        layout = next;
        state.layout = layout;
        renderLayout(container);
    };

    const resetLayout = () => {
        const next = defaultLayout(
            state.layout?.providers.map(provider => provider.id) ??
                state.data.providers.map(provider => provider.id),
            metrics,
            {
                columns: settings['layout-columns'],
                gaugeColumns: settings['layout-columns'],
            },
        );
        history.push(JSON.stringify(layout));
        redo.length = 0;
        layout = next;
        state.layout = next;
        saveLayout(next).catch(() => {});
        renderLayout(container);
    };

    const undo = () => {
        if (!history.length)
            return;
        redo.push(JSON.stringify(layout));
        const previous = JSON.parse(history.pop());
        applyWithoutHistory(previous);
        saveLayout(previous).catch(() => {});
    };
    const redoAction = () => {
        if (!redo.length)
            return;
        history.push(JSON.stringify(layout));
        const next = JSON.parse(redo.pop());
        applyWithoutHistory(next);
        saveLayout(next).catch(() => {});
    };

    const setColumns = (providerId, columns) => {
        const normalized = clamp(Number.isInteger(columns) ? columns : 1, 1, grid.columns);
        const next = packLayout(
            setProviderGaugeColumns(layout, providerId, normalized, layout.columns),
            metrics,
            {columns: layout.columns},
        );
        commit(next);
    };
    const moveCard = (providerId, delta) => {
        const index = layout.providers.findIndex(provider => provider.id === providerId);
        if (index < 0)
            return;
        let next = reorderProviders(layout, index, index + delta, metrics, {columns: layout.columns});
        next = packLayout(next, metrics, {columns: layout.columns});
        commit(next);
    };

    const setGridColumnCount = value => {
        const columns = Number.parseInt(value, 10);
        const next = packLayout({...layout, columns}, metrics, {columns});
        state.settings['layout-columns'] = columns;
        saveLayout(next, {'layout-columns': columns}).catch(() => {});
        renderLayout(container);
    };

    const controls = h('div', {class: 'layout-toolbar'},
        h('div', {class: 'field'},
            h('label', {text: 'Grid columns'}),
            selectControl([1, 2, 3, 4, 5].map(value => ({value, label: String(value)})),
                settings['layout-columns'], setGridColumnCount)),
        h('div', {class: 'field'},
            h('label', {text: 'Gauge spacing'}),
            numberControl(settings['layout-gauge-spacing'], {
                min: 0, max: 32,
                onChange: value => saveSetting('layout-gauge-spacing', value).then(() => renderLayout(container)),
            })),
        h('div', {class: 'field'},
            h('label', {text: 'Card gap'}),
            numberControl(settings['layout-gap'], {
                min: 0, max: 32,
                onChange: value => saveSetting('layout-gap', value).then(() => renderLayout(container)),
            })),
        h('div', {class: 'field'},
            h('label', {text: 'Card padding'}),
            numberControl(settings['layout-padding'], {
                min: 0, max: 24,
                onChange: value => saveSetting('layout-padding', value).then(() => renderLayout(container)),
            })),
        h('div', {class: 'field'},
            h('label', {text: 'Reset when full'}),
            switchControl(Boolean(settings['show-reset-when-full-global']), value => {
                state.settings['show-reset-when-full-global'] = value;
                saveSetting('show-reset-when-full-global', value);
            })),
        h('div', {class: 'spacer'}),
        h('div', {class: 'layout-actions'},
            button('Undo', {onClick: undo, disabled: !history.length}),
            button('Redo', {onClick: redoAction, disabled: !redo.length}),
            button('Reset layout', {className: 'button ghost', onClick: resetLayout}),
            button('Export', {className: 'button ghost', onClick: exportLayout}),
            button('Import', {className: 'button ghost', onClick: importLayout})),
    );

    const summary = h('div', {class: 'layout-summary'},
        statusPill(`${grid.providers.length} cards`, 'muted'),
        statusPill(`${grid.columns} columns`, 'muted'),
        statusPill(`${grid.rows} rows`, 'muted'),
        statusPill(`${[...metrics.values()].filter(labels => labels.length).length} providers with gauges`, 'muted'),
    );

    const workspace = h('div', {class: 'layout-workspace'});
    const canvas = h('div', {class: 'layout-canvas'});
    canvas.style.width = `${Math.max(1, grid.width)}px`;
    canvas.style.height = `${Math.max(1, grid.height)}px`;
    workspace.append(canvas);
    const fitScale = 1;
    canvas.dataset.scale = String(fitScale);
    canvas.style.transform = `scale(${fitScale})`;
    workspace.style.height = `${Math.max(150, grid.height + 36)}px`;

    for (const gridProvider of grid.providers) {
        const provider = data.providers.find(item => item.id === gridProvider.id);
        if (!provider)
            continue;
        const card = h('div', {
            class: 'layout-card',
            dataset: {provider: provider.id},
        });
        card.style.left = `${gridProvider.card.x}px`;
        card.style.top = `${gridProvider.card.y}px`;
        card.style.width = `${gridProvider.card.width}px`;
        card.style.height = `${gridProvider.card.height}px`;
        canvas.append(card);

        const header = providerHeader(provider, gridProvider);
        header.addEventListener('pointerdown', event => {
            if (event.target.closest('button, input, select'))
                return;
            startProviderDrag(event, card, header, gridProvider, grid, options, layout, commit);
        });
        card.append(header);

        for (const gauge of gridProvider.gauges) {
            card.append(makeGauge(gridProvider, gauge, options, {
                startGaugeDrag: (event, element, owner, metric) =>
                    startGaugeDrag(event, element, owner, metric, grid, layout, commit),
            }));
        }
    }

    if (!grid.providers.length) {
        workspace.replaceChildren(h('div', {class: 'layout-empty',
            text: 'No providers are enabled. Add providers in General, or open the popup once so gauges can be detected.'}));
    }

    const canvasPanel = panel('Canvas',
        'Drag a card header to move it on the shared grid. Drag a gauge to reorder it inside its card.',
        workspace,
        h('div', {class: 'layout-legend'},
            h('span', {}, h('span', {class: 'legend-swatch'}), 'Gauge'),
            h('span', {}, h('span', {class: 'legend-swatch card'}), 'Card background')),
    );

    const cardControls = h('div', {class: 'provider-list'},
        grid.providers.map((gridProvider, index) => {
            const provider = data.providers.find(item => item.id === gridProvider.id);
            if (!provider)
                return null;
            const columns = h('input', {
                class: 'layout-gauge-columns',
                type: 'number',
                min: '1',
                max: String(layout.columns),
                value: String(gridProvider.gaugeColumns),
                title: 'Gauge columns in this card',
            });
            columns.addEventListener('change', () => {
                setColumns(provider.id, Number.parseInt(columns.value, 10));
            });
            return h('div', {class: 'provider-order-row'},
                icon(provider.id),
                h('span', {class: 'provider-name', text: provider.title}),
                h('span', {class: 'row-desc', text: 'Gauge columns'}),
                columns,
                button('↑', {
                    className: 'button icon',
                    disabled: index === 0,
                    onClick: () => moveCard(provider.id, -1),
                }),
                button('↓', {
                    className: 'button icon',
                    disabled: index === grid.providers.length - 1,
                    onClick: () => moveCard(provider.id, 1),
                }));
        }),
    );

    const controlsPanel = panel('Cards',
        'Change a card\'s gauge columns or move it earlier/later without dragging.',
        cardControls,
    );

    const header = h('div', {class: 'panel-head'},
        h('div', {},
            h('h2', {class: 'panel-title', text: 'Widget layout'}),
            h('p', {class: 'panel-sub',
                text: 'Every provider shares one gauge grid. Card height follows its gauge rows; short cards leave the remaining grid cells empty.'})),
        summary);

    container.replaceChildren(
        h('section', {class: 'panel'},
            header,
            controls,
            h('div', {class: 'hint', style: 'margin-top:14px;',
                text: 'The preview uses sample values. The real popup fills in live quota data and respects the displayed-bar switches in Providers.'})),
        canvasPanel,
        controlsPanel,
    );

    // The container is detached while renderLayout builds the canvas, so its
    // width is not reliable until after the replacement. Fit the preview once
    // it is actually in the document.
    requestAnimationFrame(() => {
        if (!canvas.isConnected)
            return;
        const scale = Math.min(1, Math.max(0.35, (workspace.clientWidth - 36) / Math.max(1, grid.width)));
        canvas.dataset.scale = String(scale);
        canvas.style.transform = `scale(${scale})`;
        workspace.style.height = `${Math.max(150, grid.height * scale + 36)}px`;
    });

    function exportLayout() {
        const blob = new Blob([JSON.stringify(layout, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const anchor = h('a', {href: url, download: 'agent-quota-layout.json'});
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function importLayout() {
        const input = h('input', {type: 'file', accept: 'application/json,.json'});
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file)
                return;
            const text = await file.text();
            try {
                JSON.parse(text);
                const next = parseLayout(text, state.data.providers.map(provider => provider.id)
                    .filter(id => enabledIds().has(id)), metrics, {
                    columns: settings['layout-columns'],
                    gaugeColumns: settings['layout-columns'],
                });
                commit(next);
                showToast('Layout imported.');
            } catch (error) {
                showToast(`Could not import layout: ${error.message}`, true);
            }
        });
        input.click();
    }
}

function enabledIds() {
    return new Set(state.layout?.providers.map(provider => provider.id) ?? []);
}
