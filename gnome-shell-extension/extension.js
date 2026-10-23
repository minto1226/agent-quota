import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {filterCodexStatuses} from './workspace-selection.js';
import {resetText, shouldShowReset} from './reset-display.js';
import {providerHeader} from './provider-header.js';
import {
    chunkCircleMetrics,
    chunkProviderColumns,
    circleArcAngles,
    circlePercentText,
    headerSpacingKeyForStyle,
    isPercentageMetric,
    meterFillColor,
    normalizeCircleTextPosition,
    normalizeMeterStyle,
    orderProviderStatuses,
    paddingKeyForStyle,
    spacingKeyForStyle,
} from './meter-layout.js';

const DEFAULT_REFRESH_SECONDS = 60;
const COMMAND = 'agent-quota';
const UI_REVISION = 'provider-settings-v16';
const PROVIDER_KEYS = ['claude', 'codex', 'copilot', 'zai', 'gemini', 'go', 'zen', 'openrouter', 'deepseek', 'moonshot', 'colab'];
// Providers whose cookie-auth backend still honours --browser.  OpenCode Go
// migrated to the official API (opencode auth login) and ignores it.
const BROWSER_PROVIDER_KEYS = new Set(['claude', 'codex', 'copilot', 'zen']);

function commandArgs(extensionDir) {
    // The installed extension bundles the Python backend. This keeps the
    // top-bar feature usable without a separately installed agent-quota CLI.
    const backend = extensionDir.get_child('agent_quota.py');
    const localUv = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'uv']);
    const uv = GLib.find_program_in_path('uv') ??
        (GLib.file_test(localUv, GLib.FileTest.IS_EXECUTABLE) ? localUv : null);
    if (uv && backend.query_exists(null))
        return [uv, 'run', '--directory', extensionDir.get_path(), 'python', 'agent_quota.py', '--json'];
    return [GLib.find_program_in_path(COMMAND) ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', COMMAND]), '--json'];
}

const AgentQuotaIndicator = GObject.registerClass({},
class AgentQuotaIndicator extends PanelMenu.Button {
    _init(extensionDir, settings, openPreferences) {
        super._init(0.0, 'Agent Quota');
        this._extensionDir = extensionDir;
        this._settings = settings;
        this._openPreferences = openPreferences;

        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(this._extensionDir.get_child('gauge-symbolic.svg')),
            style_class: 'agent-quota-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'agent-quota-icon-box',
        });
        this._iconBox.add_child(this._icon);
        this.add_child(this._iconBox);
        this._refreshId = 0;
        this._requestInFlight = false;
        this._refreshPending = false;
        this._subprocesses = new Set();
        this._destroyed = false;
        this._lastPayload = null;
        // Bridge for reset-display.js: hides schema membership so a provider
        // unknown to the schema cannot crash get_boolean during rendering.
        this._prefs = {
            has: key => this._settings.settings_schema.has_key(key),
            getBoolean: key => this._settings.get_boolean(key),
        };
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'codex-workspace-options')
                return;
            if (key === 'refresh-seconds') {
                this._scheduleRefresh();
                return;
            }
            if (key === 'use-cli-config' || key === 'override-providers' || key === 'providers' || key.startsWith('browser-')) {
                this._refresh();
                return;
            }
            this._renderCurrent();
        });

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._scheduleRefresh();
    }

    _scheduleRefresh() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refresh();
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.max(10, this._settings.get_int('refresh-seconds') || DEFAULT_REFRESH_SECONDS),
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _refresh() {
        // Provider selection can change while a fetch is still running.  Do
        // not lose that change: complete the current request, then fetch the
        // newly selected set straight away.
        if (this._requestInFlight) {
            this._refreshPending = true;
            return;
        }

        this._requestInFlight = true;
        this._refreshPending = false;
        const overrideProviders = this._settings.get_boolean('override-providers') || !this._settings.get_boolean('use-cli-config');
        if (overrideProviders) {
            const providers = this._settings.get_strv('providers');
            Promise.all(providers.map(provider => this._runAgentQuota(provider)))
                .then(results => {
                    if (this._destroyed)
                        return;
                    const statuses = results.flatMap(result => result.payload.statuses ?? []);
                    this._render({statuses}, results.map(result => result.stderr).filter(Boolean).join('\n'));
                    this._finishRefresh();
                })
                .catch(error => {
                    if (this._destroyed)
                        return;
                    this._setIconState('ok');
                    this._replaceMenu('Cannot run agent-quota', error.message);
                    this._finishRefresh();
                });
            return;
        }

        this._runAgentQuota(null)
            .then(({payload, stderr}) => {
                if (this._destroyed)
                    return;
                this._render(payload, stderr);
                this._finishRefresh();
            })
            .catch(error => {
                if (this._destroyed)
                    return;
                this._setIconState('ok');
                this._replaceMenu('Cannot run agent-quota', error.message);
                this._finishRefresh();
            });
    }

    _finishRefresh() {
        this._requestInFlight = false;
        if (this._refreshPending && !this._destroyed)
            this._refresh();
    }

    _runAgentQuota(provider) {
        const args = commandArgs(this._extensionDir);
        if (provider)
            args.push('--only', provider);
        // Per-provider browser preferences apply with or without the provider
        // override, so choosing a browser never replaces config.toml's set.
        for (const key of BROWSER_PROVIDER_KEYS) {
            if (provider && key !== provider)
                continue;
            const browser = this._settings.get_string(`browser-${key}`);
            if (browser)
                args.push('--provider-browser', `${key}=${browser}`);
        }
        return new Promise((resolve, reject) => {
            // Gio.Subprocess.new throws synchronously when the executable is
            // missing or not executable.  Constructing it inside the executor
            // turns that into a rejection so the refresh error path (and the
            // in-flight flag release) still runs instead of escaping.
            let process;
            try {
                process = Gio.Subprocess.new(
                    args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (error) {
                reject(error);
                return;
            }
            this._subprocesses.add(process);
            process.communicate_utf8_async(null, null, (_proc, result) => {
                this._subprocesses.delete(process);
                try {
                    const [, stdout, stderr] = process.communicate_utf8_finish(result);
                    resolve({payload: JSON.parse(stdout), stderr});
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _render(payload, stderr) {
        this._lastPayload = payload;
        this._renderPayload(payload, stderr);
    }

    _renderCurrent() {
        if (this._lastPayload)
            this._renderPayload(this._lastPayload, '');
    }

    _renderPayload(payload, stderr) {
        let statuses = payload.statuses ?? [];
        this._rememberCodexWorkspaces(statuses);
        const overrideProviders = this._settings.get_boolean('override-providers') || !this._settings.get_boolean('use-cli-config');
        if (overrideProviders) {
            const selected = new Set(this._settings.get_strv('providers'));
            statuses = statuses.filter(status => selected.has(status.key));
        }
        const configuredOrder = this._settings.get_strv('provider-order');
        statuses = orderProviderStatuses(
            statuses,
            configuredOrder.length ? configuredOrder : (overrideProviders ? this._settings.get_strv('providers') : []),
        );
        statuses = filterCodexStatuses(
            statuses,
            this._settings.get_strv('codex-workspaces'),
        );
        const failed = statuses.filter(status => status.state !== 'ok');
        const metrics = statuses.flatMap(status => status.metrics ?? [])
            .filter(metric => metric.pct !== null && metric.pct !== undefined && !metric.muted);
        const average = metrics.length
            ? Math.round(metrics.reduce((sum, metric) => sum + metric.pct, 0) / metrics.length)
            : null;

        // A red gauge means quota is exhausted.  Keep that meaning even when
        // a provider request failed, and add a small badge for the failure.
        this._setIconState(this._meterState(average));
        this._setErrorBadge(failed.length > 0);

        this.menu.removeAll();
        if (!statuses.length) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No providers enabled'));
            this._appendSettingsAction();
            return;
        }

        const showUserInfo = this._settings.get_boolean('show-user-info');
        const meterStyle = normalizeMeterStyle(this._settings.get_string('meter-style'));
        const padding = this._settings.get_int(paddingKeyForStyle(meterStyle));
        const headerSpacing = this._settings.get_int(headerSpacingKeyForStyle(meterStyle));
        const spacing = this._settings.get_int(spacingKeyForStyle(meterStyle));
        const circleRadius = this._settings.get_int('circle-radius');
        const circleColumns = this._settings.get_int('circle-columns');
        const circleTextPosition = normalizeCircleTextPosition(this._settings.get_string('circle-text-position'));
        const providerColumns = this._settings.get_int('provider-columns');
        const providerColumnSpacing = this._settings.get_int('provider-column-spacing');
        const providerColumnBreaks = this._settings.get_strv('provider-column-breaks');
        const popupWidth = this._settings.get_int('popup-width');
        const columns = chunkProviderColumns(statuses, providerColumns, providerColumnBreaks);
        if (columns.length <= 1) {
            for (const status of statuses) {
                const item = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                    style_class: 'agent-quota-provider-block',
                });
                item.style = `width: ${popupWidth}px; padding-top: ${padding}px; padding-bottom: ${padding}px;`;
                item.add_child(this._buildProviderBox(
                    status,
                    showUserInfo,
                    meterStyle,
                    headerSpacing,
                    spacing,
                    circleRadius,
                    circleColumns,
                    circleTextPosition,
                ));
                this.menu.addMenuItem(item);
            }
        } else {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'agent-quota-provider-block',
            });
            item.style = 'padding-top: 0; padding-bottom: 0;';
            const columnsRow = new St.BoxLayout({
                x_expand: true,
                style_class: 'agent-quota-provider-columns',
            });
            columns.forEach((colStatuses, colIndex) => {
                const colBox = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.START,
                    style_class: 'agent-quota-provider-column',
                });
                colBox.style = `width: ${popupWidth}px;${colIndex > 0 ? ` margin-left: ${providerColumnSpacing}px;` : ''}`;
                for (const status of colStatuses) {
                    const providerBox = this._buildProviderBox(
                        status,
                        showUserInfo,
                        meterStyle,
                        headerSpacing,
                        spacing,
                        circleRadius,
                        circleColumns,
                        circleTextPosition,
                    );
                    providerBox.style = `padding-top: ${padding}px; padding-bottom: ${padding}px;`;
                    colBox.add_child(providerBox);
                }
                columnsRow.add_child(colBox);
            });
            item.add_child(columnsRow);
            this.menu.addMenuItem(item);
        }

        this._appendSettingsAction();

        if (stderr)
            log(`agent-quota: ${stderr.trim()}`);
    }

    _buildProviderBox(status, showUserInfo, meterStyle, headerSpacing, spacing, circleRadius, circleColumns, circleTextPosition) {
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const titleRow = new St.BoxLayout({x_expand: true});
        const providerIcon = this._providerIcon(status.key);
        if (providerIcon)
            titleRow.add_child(providerIcon);
        const providerLabel = new St.Label({
            text: status.name,
            style_class: status.state === 'ok' ? 'agent-quota-provider' : 'agent-quota-error',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        providerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        providerLabel.clutter_text.single_line_mode = true;
        titleRow.add_child(providerLabel);
        // Presentation only: hiding the user keeps the plan and never
        // falls back to the source (which can name an account too).
        const planOrSource = providerHeader(status, showUserInfo);
        if (planOrSource) {
            const sourceLabel = new St.Label({
                text: planOrSource,
                style_class: 'agent-quota-source',
                y_align: Clutter.ActorAlign.CENTER,
            });
            sourceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            sourceLabel.clutter_text.single_line_mode = true;
            titleRow.add_child(sourceLabel);
        }
        box.add_child(titleRow);

        if (status.state === 'ok') {
            box.add_child(this._renderMetrics(status, meterStyle, headerSpacing, spacing, circleRadius, circleColumns, circleTextPosition));
        } else if (status.error) {
            const errorLabel = new St.Label({
                text: this._shortError(status.error),
                style_class: 'agent-quota-secondary',
                x_expand: true,
            });
            errorLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            errorLabel.clutter_text.single_line_mode = true;
            box.add_child(errorLabel);
        }
        return box;
    }

    _appendSettingsAction() {
        if (!this._settings.get_boolean('show-settings-action'))
            return;
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupImageMenuItem('Settings', 'emblem-system-symbolic');
        settingsItem.connect('activate', () => this._openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _rememberCodexWorkspaces(statuses) {
        const options = statuses
            .filter(status => status.key === 'codex' && status.state === 'ok' && status.workspace_id)
            .map(status => JSON.stringify({
                id: status.workspace_id,
                label: [status.plan, status.user].filter(Boolean).join(' · ') || status.workspace_id,
            }));
        if (!options.length)
            return;
        const current = this._settings.get_strv('codex-workspace-options');
        if (current.length !== options.length || current.some((value, index) => value !== options[index]))
            this._settings.set_strv('codex-workspace-options', options);
    }

    _replaceMenu(title, detail) {
        this._setErrorBadge(true);
        this.menu.removeAll();
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(title));
        if (detail)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(detail));
        // Errors and empty provider lists are exactly when configuration
        // needs correcting; keep the Settings action reachable.
        this._appendSettingsAction();
    }

    _shortError(error) {
        const line = String(error || 'Unknown provider error').replace(/\s+/g, ' ').trim();
        return line.length > 160 ? `${line.slice(0, 157)}…` : line;
    }

    _setErrorBadge(show) {
        if (show && !this._errorBadge) {
            this._errorBadge = new St.Label({
                text: '!',
                style_class: 'agent-quota-error-badge',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
            });
            this._iconBox.add_child(this._errorBadge);
        } else if (!show && this._errorBadge) {
            this._errorBadge.destroy();
            this._errorBadge = null;
        }
    }

    _providerIcon(provider) {
        const file = this._extensionDir.get_child('icons')
            .get_child(`provider-${provider}-symbolic.svg`);
        if (!file.query_exists(null))
            return null;
        return new St.Icon({
            gicon: Gio.FileIcon.new(file),
            style_class: 'agent-quota-provider-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _renderMetrics(status, meterStyle, headerSpacing, spacing, circleRadius, circleColumns, circleTextPosition) {
        const metricsBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'agent-quota-metrics',
        });
        metricsBox.style = `margin-top: ${headerSpacing}px;`;

        if (meterStyle === 'circle') {
            const cols = Math.max(1, circleColumns || 3);
            const rows = chunkCircleMetrics(status.metrics, cols);
            rows.forEach((row, index) => {
                const rowBox = new St.BoxLayout({
                    x_expand: true,
                    style_class: 'agent-quota-circle-row',
                });
                rowBox.layout_manager.homogeneous = true;
                rowBox.style = `margin-top: ${index === 0 ? 0 : spacing}px;`;
                for (let i = 0; i < cols; i++) {
                    if (row[i])
                        rowBox.add_child(this._circleMetricCell(row[i], status.key, circleRadius, circleTextPosition));
                    else if (cols > 1)
                        rowBox.add_child(new St.Widget({x_expand: true}));
                }
                metricsBox.add_child(rowBox);
            });
            const nonPct = (status.metrics ?? []).filter(item => !isPercentageMetric(item));
            nonPct.forEach((metric, index) => {
                metricsBox.add_child(this._barMetricBlock(metric, status.key, rows.length === 0 && index === 0 ? 0 : spacing));
            });
            return metricsBox;
        }

        (status.metrics ?? []).forEach((metric, index) => {
            metricsBox.add_child(this._barMetricBlock(metric, status.key, index === 0 ? 0 : spacing));
        });
        return metricsBox;
    }

    _barMetricBlock(metric, providerKey, spacing) {
        const metricBlock = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'agent-quota-metric-block',
        });
        metricBlock.style = `margin-top: ${spacing}px;`;
        if (metric.pct !== null && metric.pct !== undefined)
            metricBlock.add_child(this._meter(metric.pct, metric.is_remaining, metric.muted));
        const metricRow = new St.BoxLayout({x_expand: true});
        metricRow.add_child(new St.Label({
            text: `${metric.label}: ${metric.value}`,
            style_class: 'agent-quota-metric',
            x_expand: true,
        }));
        if (shouldShowReset(this._prefs, metric, providerKey))
            metricRow.add_child(new St.Label({
                text: resetText(this._prefs, metric, providerKey),
                style_class: 'agent-quota-reset',
            }));
        metricBlock.add_child(metricRow);
        return metricBlock;
    }

    _circleMetricCell(metric, providerKey, circleRadius, circleTextPosition = 'below') {
        const below = circleTextPosition !== 'right';
        const cell = new St.BoxLayout({
            vertical: below,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            style_class: below ? 'agent-quota-circle-cell below' : 'agent-quota-circle-cell',
        });
        const ring = this._circleMeter(metric.pct, metric.is_remaining, metric.muted, circleRadius);
        if (below)
            ring.x_align = Clutter.ActorAlign.CENTER;
        cell.add_child(ring);

        const textCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
            style_class: below ? 'agent-quota-circle-text below' : 'agent-quota-circle-text',
        });
        const label = new St.Label({
            text: metric.label,
            style_class: below
                ? 'agent-quota-metric agent-quota-circle-label below'
                : 'agent-quota-metric agent-quota-circle-label',
            x_expand: true,
            x_align: below ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.single_line_mode = true;
        textCol.add_child(label);

        if (shouldShowReset(this._prefs, metric, providerKey)) {
            const resetLabel = new St.Label({
                text: resetText(this._prefs, metric, providerKey),
                style_class: below
                    ? 'agent-quota-reset agent-quota-circle-reset below'
                    : 'agent-quota-reset agent-quota-circle-reset',
                x_expand: true,
                x_align: below ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            });
            resetLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            resetLabel.clutter_text.single_line_mode = true;
            textCol.add_child(resetLabel);
        }

        cell.add_child(textCol);
        return cell;
    }

    _meter(pct, isRemaining, muted = false) {
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        const meter = new St.Widget({style_class: 'agent-quota-meter', x_expand: true});
        const fill = new St.Widget({
            style_class: `agent-quota-meter-fill ${isRemaining ? 'remaining' : 'used'} ${muted ? 'muted' : this._meterState(clamped)}`,
        });
        meter.add_child(fill);
        const updateFill = () => {
            if (meter.width > 0)
                fill.width = Math.round(meter.width * clamped / 100);
        };
        meter.connect('notify::allocation', updateFill);
        return meter;
    }

    _circleMeter(pct, isRemaining, muted = false, circleRadius = 16) {
        const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
        const state = this._meterState(clamped);
        const [r, g, b, a] = meterFillColor(state, isRemaining, muted);
        const radiusSetting = Math.max(10, Math.min(32, Number(circleRadius) || 16));
        const size = radiusSetting * 2;
        const strokeWidth = Math.max(2.2, Number((radiusSetting * 0.19).toFixed(1)));
        const fontSize = Math.max(7, Number((radiusSetting * 0.53).toFixed(1)));
        const container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'agent-quota-circle-meter',
            width: size,
            height: size,
            style: `width: ${size}px; height: ${size}px;`,
            y_align: Clutter.ActorAlign.START,
        });
        const area = new St.DrawingArea({
            width: size,
            height: size,
            x_expand: true,
            y_expand: true,
        });
        area.connect('repaint', () => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const cx = w / 2;
            const cy = h / 2;
            const radius = Math.max(1, (Math.min(w, h) - strokeWidth) / 2 - 0.5);

            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            cr.setLineWidth(strokeWidth);

            cr.setSourceRGBA(1, 1, 1, 0.16);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            const arc = circleArcAngles(clamped, strokeWidth, radius);
            if (arc) {
                cr.setSourceRGBA(r, g, b, a);
                if (!arc.full)
                    cr.setLineCap(Cairo.LineCap.ROUND);
                cr.arc(cx, cy, radius, arc.startAngle, arc.endAngle);
                cr.stroke();
            }

            cr.$dispose();
        });
        const pctLabel = new St.Label({
            text: circlePercentText(clamped),
            style_class: 'agent-quota-circle-pct',
            style: `font-size: ${fontSize}px;`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        container.add_child(area);
        container.add_child(pctLabel);
        return container;
    }

    _setIconState(state) {
        for (const name of ['ok', 'warning', 'critical', 'error'])
            this._icon.remove_style_class_name(`agent-quota-${name}`);
        this._icon.add_style_class_name(`agent-quota-${state}`);
    }

    _meterState(pct) {
        if (pct === null || pct === undefined)
            return 'ok';
        if (pct <= this._settings.get_int('critical-threshold'))
            return 'critical';
        if (pct <= this._settings.get_int('warning-threshold'))
            return 'warning';
        return 'ok';
    }

    destroy() {
        this._destroyed = true;
        if (this._settingsSignal)
            this._settings.disconnect(this._settingsSignal);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        for (const subprocess of this._subprocesses) {
            try {
                subprocess.force_exit();
            } catch (_error) {
                // The process may have exited between the check and cleanup.
            }
        }
        this._subprocesses.clear();
        this._setErrorBadge(false);
        super.destroy();
    }
});

export default class AgentQuotaExtension extends Extension {
    enable() {
        log(`agent-quota: loaded ${UI_REVISION}`);
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheetFile = this.dir.get_child('stylesheet.css');
        this._theme.load_stylesheet(this._stylesheetFile);

        this._settings = this.getSettings();
        // v5 exposed this as one global switch. Preserve an explicit old
        // choice when upgrading, then let each provider be configured alone.
        if (this._settings.get_user_value('show-reset-when-full')?.deepUnpack()) {
            for (const provider of PROVIDER_KEYS) {
                const key = `show-reset-when-full-${provider}`;
                if (this._settings.get_user_value(key) === null)
                    this._settings.set_boolean(key, true);
            }
        }
        this._indicator = new AgentQuotaIndicator(
            this.dir,
            this._settings,
            () => this.openPreferences(),
        );
        Main.panel.addToStatusArea('agent-quota', this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.menu?.close({animate: false});
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        if (this._stylesheetFile) {
            this._theme.unload_stylesheet(this._stylesheetFile);
            this._stylesheetFile = null;
        }
    }
}
