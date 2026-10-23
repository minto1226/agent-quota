import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {readAssignment, upsertAssignment} from './secret-config.js';
import {selectionAfterWorkspaceToggle} from './workspace-selection.js';
import {
    headerSpacingKeyForStyle,
    normalizeProviderOrder,
    paddingKeyForStyle,
    spacingKeyForStyle,
} from './meter-layout.js';

const PROVIDERS = [
    {id: 'claude', title: 'Claude', login: 'https://claude.ai/', browser: true},
    {id: 'codex', title: 'Codex', login: 'https://chatgpt.com/', browser: true},
    {id: 'copilot', title: 'GitHub Copilot', login: 'https://github.com/login', browser: true, secret: ['GITHUB_TOKEN', 'GitHub personal access token']},
    {id: 'zai', title: 'Z.ai', login: 'https://z.ai/', secret: ['ZAI_TOKEN', 'API token']},
    {id: 'gemini', title: 'Gemini (Antigravity)', command: 'agy'},
    {id: 'go', title: 'OpenCode Go', command: 'opencode auth login'},
    {id: 'zen', title: 'OpenCode Zen', login: 'https://opencode.ai/zen', browser: true},
    {id: 'openrouter', title: 'OpenRouter', login: 'https://openrouter.ai/keys', secret: ['OPENROUTER_API_KEY', 'Management key']},
    {id: 'deepseek', title: 'DeepSeek', login: 'https://platform.deepseek.com/api_keys', secret: ['DEEPSEEK_API_KEY', 'API key']},
    {id: 'moonshot', title: 'Kimi', login: 'https://platform.moonshot.ai/console/api-keys', secret: ['MOONSHOT_API_KEY', 'API key']},
    {id: 'colab', title: 'Google Colab', command: 'colab usage'},
];
const BROWSERS = ['', 'chrome', 'chromium', 'brave', 'edge', 'firefox', 'helium'];
const METER_STYLES = [
    {id: 'circle', title: 'Circular'},
    {id: 'bar', title: 'Bar'},
];
const CIRCLE_TEXT_POSITIONS = [
    {id: 'below', title: 'Below circle'},
    {id: 'right', title: 'Right of circle'},
];

function addSwitch(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addSpin(group, settings, key, title, subtitle, lower, upper) {
    const row = new Adw.ActionRow({title, subtitle});
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
        valign: Gtk.Align.CENTER,
        numeric: true,
    });
    spin.set_value(settings.get_int(key));
    spin.connect('value-changed', () => settings.set_int(key, spin.get_value_as_int()));
    settings.connect(`changed::${key}`, () => spin.set_value(settings.get_int(key)));
    row.add_suffix(spin);
    row.activatable_widget = spin;
    group.add(row);
}

function addStyleSpin(group, settings, keyForStyle, title, subtitle, lower, upper) {
    const row = new Adw.ActionRow({title, subtitle});
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
        valign: Gtk.Align.CENTER,
        numeric: true,
    });
    let updating = false;
    const activeKey = () => keyForStyle(settings.get_string('meter-style'));
    const syncFromSettings = () => {
        updating = true;
        spin.set_value(settings.get_int(activeKey()));
        updating = false;
    };
    syncFromSettings();
    spin.connect('value-changed', () => {
        if (updating)
            return;
        settings.set_int(activeKey(), spin.get_value_as_int());
    });
    for (const style of METER_STYLES)
        settings.connect(`changed::${keyForStyle(style.id)}`, syncFromSettings);
    settings.connect('changed::meter-style', syncFromSettings);
    row.add_suffix(spin);
    row.activatable_widget = spin;
    group.add(row);
}

function configFile(provider) {
    // The Python loaders always read $HOME/.config/agent-quota regardless of
    // XDG_CONFIG_HOME; write there so the backend sees what we save.
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_home_dir(), '.config', 'agent-quota', `${provider}.conf`,
    ]));
}

function readSecret(provider, key) {
    try {
        const [, bytes] = configFile(provider).load_contents(null);
        return readAssignment(new TextDecoder().decode(bytes), key);
    } catch (_error) {
        return '';
    }
}

function saveSecret(provider, key, value) {
    const file = configFile(provider);
    const directory = file.get_parent();
    if (!directory.query_exists(null))
        directory.make_directory_with_parents(null);
    let contents = '# Managed by Agent Quota GNOME extension\n';
    try {
        const [, bytes] = file.load_contents(null);
        contents = new TextDecoder().decode(bytes);
    } catch (_error) {
        // A missing config file is the normal first-run case.
    }
    // PRIVATE keeps the replacement owner-only (0600).  Without it a new
    // credential file can be created group/world readable, and replacing
    // an existing file would discard its restrictive permissions.
    file.replace_contents(
        upsertAssignment(contents, key, value),
        null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE,
        null,
    );
}

function addBrowser(group, settings, provider) {
    const row = new Adw.ComboRow({
        title: 'Cookie browser',
        subtitle: 'Choose the signed-in browser. “Automatic” tries the normal order.',
        model: Gtk.StringList.new(['Automatic', ...BROWSERS.slice(1)]),
    });
    const key = `browser-${provider.id}`;
    const setSelected = () => row.selected = Math.max(0, BROWSERS.indexOf(settings.get_string(key)));
    setSelected();
    row.connect('notify::selected', () => {
        settings.set_string(key, BROWSERS[row.selected]);
    });
    settings.connect(`changed::${key}`, setSelected);
    group.add(row);
}

function addMeterStyle(group, settings) {
    const row = new Adw.ComboRow({
        title: 'Progress style',
        subtitle: 'Compact circular gauges or full-width progress bars.',
        model: Gtk.StringList.new(METER_STYLES.map(style => style.title)),
    });
    const setSelected = () => {
        const index = METER_STYLES.findIndex(style => style.id === settings.get_string('meter-style'));
        row.selected = index >= 0 ? index : 0;
    };
    setSelected();
    row.connect('notify::selected', () => {
        const style = METER_STYLES[row.selected] ?? METER_STYLES[0];
        settings.set_string('meter-style', style.id);
    });
    settings.connect('changed::meter-style', setSelected);
    group.add(row);
}

function addCircleTextPosition(group, settings) {
    const row = new Adw.ComboRow({
        title: 'Circle label position',
        subtitle: 'Place window label and reset time below each circle or to its right.',
        model: Gtk.StringList.new(CIRCLE_TEXT_POSITIONS.map(pos => pos.title)),
    });
    const setSelected = () => {
        const index = CIRCLE_TEXT_POSITIONS.findIndex(pos => pos.id === settings.get_string('circle-text-position'));
        row.selected = index >= 0 ? index : 0;
    };
    setSelected();
    row.connect('notify::selected', () => {
        const pos = CIRCLE_TEXT_POSITIONS[row.selected] ?? CIRCLE_TEXT_POSITIONS[0];
        settings.set_string('circle-text-position', pos.id);
    });
    settings.connect('changed::circle-text-position', setSelected);
    group.add(row);
}

function codexWorkspaceOptions(settings) {
    const seen = new Set();
    const options = [];
    for (const value of settings.get_strv('codex-workspace-options')) {
        try {
            const option = JSON.parse(value);
            if (typeof option.id !== 'string' || !option.id || seen.has(option.id))
                continue;
            seen.add(option.id);
            options.push({
                id: option.id,
                label: typeof option.label === 'string' && option.label ? option.label : option.id,
            });
        } catch (_error) {
            // Ignore stale entries written by an interrupted or older extension.
        }
    }
    return options;
}

function addCodexWorkspacePicker(group, settings) {
    const summary = new Adw.ActionRow({title: 'Displayed workspaces'});
    const showAll = new Gtk.Button({label: 'Show all', valign: Gtk.Align.CENTER});
    showAll.connect('clicked', () => settings.set_strv('codex-workspaces', []));
    summary.add_suffix(showAll);
    group.add(summary);

    let workspaceRows = [];
    let updating = false;
    const rebuild = () => {
        updating = true;
        for (const row of workspaceRows)
            group.remove(row);
        workspaceRows = [];

        const options = codexWorkspaceOptions(settings);
        const configured = settings.get_strv('codex-workspaces');
        const selected = configured.length
            ? new Set(configured)
            : new Set(options.map(option => option.id));
        if (!options.length) {
            summary.subtitle = 'Open the Agent Quota popup once to detect available workspaces.';
            updating = false;
            return;
        }

        summary.subtitle = configured.length
            ? `${options.filter(option => selected.has(option.id)).length} of ${options.length} shown`
            : `All ${options.length} detected workspaces are shown`;
        const allIds = options.map(option => option.id);
        for (const option of options) {
            const row = new Adw.SwitchRow({
                title: option.label,
                subtitle: option.id,
                active: selected.has(option.id),
            });
            row.connect('notify::active', () => {
                if (updating)
                    return;
                const current = settings.get_strv('codex-workspaces');
                const next = selectionAfterWorkspaceToggle(
                    allIds,
                    current,
                    option.id,
                    row.active,
                );
                if (next === null) {
                    updating = true;
                    row.active = true;
                    updating = false;
                    return;
                }
                settings.set_strv('codex-workspaces', next);
            });
            workspaceRows.push(row);
            group.add(row);
        }
        updating = false;
    };

    rebuild();
    settings.connect('changed::codex-workspace-options', rebuild);
    settings.connect('changed::codex-workspaces', rebuild);
}

function addLoginAction(group, provider) {
    const row = new Adw.ActionRow({
        title: 'Sign in or refresh session',
        subtitle: 'Opens the provider in your browser. Return here after signing in.',
        activatable: true,
    });
    row.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
    row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(provider.login, null));
    group.add(row);
}

function addCommandHint(group, command) {
    // OpenCode Go authenticates through the opencode CLI, not a browser; the
    // official usage API reads the key written by `opencode auth login`.
    const row = new Adw.ActionRow({
        title: 'Sign in',
        subtitle: `Run ${command} in a terminal to authenticate, then reopen the popup.`,
    });
    const copy = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Copy command',
    });
    copy.connect('clicked', () => row.get_display().get_clipboard().set_text(command));
    row.add_suffix(copy);
    group.add(row);
}

function addSecretEditor(group, provider) {
    const [key, label] = provider.secret;
    const row = new Adw.ActionRow({
        title: label,
        subtitle: 'Stored in ~/.config/agent-quota/ for this provider only. Enable it under General → Displayed providers to show its balance.',
    });
    const entry = new Gtk.PasswordEntry({
        text: readSecret(provider.id, key),
        placeholder_text: label,
        width_chars: 24,
        valign: Gtk.Align.CENTER,
        show_peek_icon: true,
    });
    const save = new Gtk.Button({label: 'Save', valign: Gtk.Align.CENTER});
    save.connect('clicked', () => {
        try {
            saveSecret(provider.id, key, entry.text);
            save.label = 'Saved';
        } catch (error) {
            save.label = 'Save failed';
            logError(error, `Could not save ${provider.id} credentials`);
        }
    });
    row.add_suffix(entry);
    row.add_suffix(save);
    group.add(row);
}

function addProviderColumnBreakSwitch(group, settings, provider) {
    const row = new Adw.SwitchRow({
        title: 'Start a new column',
        subtitle: 'Place this provider at the top of the next column in the popup.',
        active: settings.get_strv('provider-column-breaks').includes(provider.id),
    });
    row.connect('notify::active', () => {
        const selected = new Set(settings.get_strv('provider-column-breaks'));
        row.active ? selected.add(provider.id) : selected.delete(provider.id);
        settings.set_strv(
            'provider-column-breaks',
            PROVIDERS.map(p => p.id).filter(id => selected.has(id)),
        );
    });
    settings.connect('changed::provider-column-breaks', () => {
        row.active = settings.get_strv('provider-column-breaks').includes(provider.id);
    });
    group.add(row);
}

function addDisplayedProvidersGroup(page, settings) {
    const providers = new Adw.PreferencesGroup({
        title: 'Displayed providers',
        description: 'Choose which providers appear in the popup and use the arrows to reorder them.',
    });
    const allIds = PROVIDERS.map(p => p.id);
    const providerById = new Map(PROVIDERS.map(p => [p.id, p]));
    let rows = [];
    let updating = false;

    const currentOrder = () => normalizeProviderOrder(settings.get_strv('provider-order'), allIds);

    const rebuild = () => {
        if (updating)
            return;
        updating = true;
        for (const row of rows)
            providers.remove(row);
        rows = [];

        const orderedIds = currentOrder();
        const selected = new Set(settings.get_strv('providers'));

        orderedIds.forEach((id, index) => {
            const provider = providerById.get(id);
            if (!provider)
                return;
            const row = new Adw.SwitchRow({
                title: provider.title,
                active: selected.has(id),
            });
            const upButton = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Move up',
                sensitive: index > 0,
                css_classes: ['flat'],
            });
            const downButton = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Move down',
                sensitive: index < orderedIds.length - 1,
                css_classes: ['flat'],
            });
            upButton.connect('clicked', () => {
                const next = [...orderedIds];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                settings.set_strv('provider-order', next);
            });
            downButton.connect('clicked', () => {
                const next = [...orderedIds];
                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                settings.set_strv('provider-order', next);
            });
            row.add_suffix(upButton);
            row.add_suffix(downButton);
            row.connect('notify::active', () => {
                if (updating)
                    return;
                const nextSelected = new Set(settings.get_strv('providers'));
                row.active ? nextSelected.add(id) : nextSelected.delete(id);
                settings.set_strv('providers', currentOrder().filter(key => nextSelected.has(key)));
                settings.set_boolean('override-providers', true);
            });
            rows.push(row);
            providers.add(row);
        });
        updating = false;
    };

    rebuild();
    settings.connect('changed::providers', rebuild);
    settings.connect('changed::provider-order', rebuild);
    page.add(providers);
}

export default class AgentQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 720);
        Gtk.IconTheme.get_for_display(window.get_display())
            .add_search_path(this.dir.get_child('icons').get_path());

        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const data = new Adw.PreferencesGroup({title: 'Data'});
        addSwitch(data, settings, 'override-providers', 'Override configured providers', 'Use the provider switches below instead of config.toml.');
        addSpin(data, settings, 'refresh-seconds', 'Refresh interval', 'Seconds between quota fetches.', 10, 3600);
        general.add(data);

        addDisplayedProvidersGroup(general, settings);
        window.add(general);

        const appearance = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});
        const colors = new Adw.PreferencesGroup({title: 'Quota colours'});
        addSpin(colors, settings, 'warning-threshold', 'Warning threshold', 'Remaining percentage at or below which meters turn yellow.', 1, 99);
        addSpin(colors, settings, 'critical-threshold', 'Critical threshold', 'Remaining percentage at or below which meters turn red.', 0, 98);
        appearance.add(colors);
        const popup = new Adw.PreferencesGroup({title: 'Popup'});
        addMeterStyle(popup, settings);
        addCircleTextPosition(popup, settings);
        addSwitch(popup, settings, 'show-settings-action', 'Show Settings action at the bottom of the popup');
        addSwitch(popup, settings, 'show-user-info', 'Show user information', 'Show the account name next to each provider plan. Turn off to show only the plan.');
        addStyleSpin(popup, settings, paddingKeyForStyle, 'Provider group padding', 'Vertical padding around each provider (saved separately for Circular and Bar).', 0, 24);
        addStyleSpin(popup, settings, headerSpacingKeyForStyle, 'Header to meter spacing', 'Vertical distance from the provider title to its quota meters (saved separately for Circular and Bar).', 0, 24);
        addStyleSpin(popup, settings, spacingKeyForStyle, 'Metric spacing', 'Vertical spacing between quota rows (saved separately for Circular and Bar).', 0, 20);
        addSpin(popup, settings, 'circle-radius', 'Circle radius', 'Radius of circular progress gauges in pixels.', 10, 32);
        addSpin(popup, settings, 'circle-columns', 'Circles per row', 'Number of circular gauges shown in each row.', 1, 6);
        addSpin(popup, settings, 'provider-columns', 'Provider columns', 'Number of provider columns shown side-by-side in the popup.', 1, 4);
        addSpin(popup, settings, 'provider-column-spacing', 'Provider column spacing', 'Horizontal spacing between side-by-side provider columns in pixels.', 0, 64);
        addSpin(popup, settings, 'popup-width', 'Popup width', 'Width of each provider column in pixels.', 50, 720);
        appearance.add(popup);
        window.add(appearance);

        const providerSettings = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'network-server-symbolic',
        });
        for (const provider of PROVIDERS) {
            const group = new Adw.PreferencesGroup({
                title: provider.title,
                description: 'Account, authentication, and popup layout.',
            });
            if (provider.command) {
                addCommandHint(group, provider.command);
            } else if (provider.browser) {
                addLoginAction(group, provider);
                addBrowser(group, settings, provider);
            }
            if (provider.id === 'codex')
                addCodexWorkspacePicker(group, settings);
            if (provider.secret)
                addSecretEditor(group, provider);
            addSwitch(group, settings, `show-reset-when-full-${provider.id}`, 'Show reset time when full');
            addProviderColumnBreakSwitch(group, settings, provider);
            providerSettings.add(group);
        }
        window.add(providerSettings);
    }
}
