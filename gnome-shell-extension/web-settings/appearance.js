import {state, saveSetting} from './store.js';
import {
    h,
    numberControl,
    panel,
    row,
    selectControl,
    switchControl,
} from './ui.js';

function numberRow(title, description, key, min, max, onChange = null) {
    return row(title, description, numberControl(state.settings[key], {
        min,
        max,
        onChange: value => {
            state.settings[key] = value;
            if (onChange)
                onChange(value);
            saveSetting(key, value);
        },
    }));
}

export function renderAppearance(container) {
    const settings = state.settings;
    const colors = panel(
        'Quota colours',
        'Thresholds apply to remaining quota, in percent.',
        numberRow('Warning threshold', 'Turn gauges yellow at or below this value.',
            'warning-threshold', 1, 99),
        numberRow('Critical threshold', 'Turn gauges red at or below this value.',
            'critical-threshold', 0, 98),
    );

    const gauge = panel(
        'Gauge',
        'The popup uses the 240° gauge with a fixed opening at the bottom.',
        row('Gauge percentage',
            'Show the value in the gauge opening as 99%, 99, or not at all.',
            selectControl([
                {value: 'percent', label: '99%'},
                {value: 'number', label: '99'},
                {value: 'hidden', label: 'Hidden'},
            ], settings['gauge-percent'], value => {
                state.settings['gauge-percent'] = value;
                saveSetting('gauge-percent', value);
            })),
        numberRow('Percentage offset',
            'Distance below the gauge centre as a percentage of the radius. 0 is centred.',
            'gauge-percent-offset', -50, 100),
        numberRow('Percentage font size',
            'Pixels for the value inside the gauge. 0 derives it from the radius.',
            'gauge-percent-font-size', 0, 32),
        numberRow('Label font size',
            'Pixels for the window label below each gauge.',
            'gauge-label-font-size', 6, 24),
        numberRow('Reset font size',
            'Pixels for the reset countdown below each gauge.',
            'gauge-reset-font-size', 6, 24),
        numberRow('Gauge radius',
            'Radius of the gauges in pixels.',
            'circle-radius', 10, 32),
    );

    const popup = panel(
        'Popup',
        'Controls shared by both the widget layout and the emergency classic fallback.',
        row('Show Settings action',
            'Add a Settings entry at the bottom of the popup.',
            switchControl(settings['show-settings-action'], value => {
                state.settings['show-settings-action'] = value;
                saveSetting('show-settings-action', value);
            })),
        row('Show user information',
            'Show the account name next to each provider plan.',
            switchControl(settings['show-user-info'], value => {
                state.settings['show-user-info'] = value;
                saveSetting('show-user-info', value);
            })),
        row('Show organization name',
            'Append the Claude or Codex workspace name to Team/Business plan labels.',
            switchControl(settings['show-org-name'], value => {
                state.settings['show-org-name'] = value;
                saveSetting('show-org-name', value);
            })),
    );

    container.replaceChildren(colors, gauge, popup);
}
