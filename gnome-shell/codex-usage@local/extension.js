import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 180;
const SCRIPT_PATH = `${GLib.get_home_dir()}/.local/bin/codex-usage-status`;
const USAGE_URL = 'https://chatgpt.com/codex/settings/usage';

function formatTimestamp(epochSeconds) {
    if (!epochSeconds)
        return _('unknown');

    try {
        return GLib.DateTime.new_from_unix_local(epochSeconds).format('%H:%M:%S');
    } catch (_e) {
        return _('unknown');
    }
}

function formatReset(epochSeconds, weekly = false) {
    if (!epochSeconds)
        return _('unknown');

    try {
        const dt = GLib.DateTime.new_from_unix_local(epochSeconds);
        return weekly ? dt.format('%H:%M on %d %b') : dt.format('%H:%M');
    } catch (_e) {
        return _('unknown');
    }
}

function percentText(limit) {
    if (!limit || limit.left_percent === undefined || limit.left_percent === null)
        return _('unknown');

    return `${limit.left_percent}% left`;
}

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Codex Usage'));

        this._extension = extension;
        this._refreshTimeoutId = 0;
        this._refreshing = false;
        this._lastData = null;

        this._label = new St.Label({
            text: _('Codex usage ?'),
            style_class: 'codex-usage-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._primaryItem = new PopupMenu.PopupMenuItem(_('5h limit: unknown'), {
            reactive: false,
            can_focus: false,
        });
        this._primaryResetItem = new PopupMenu.PopupMenuItem(_('Resets: unknown'), {
            reactive: false,
            can_focus: false,
        });
        this._secondaryItem = new PopupMenu.PopupMenuItem(_('Weekly limit: unknown'), {
            reactive: false,
            can_focus: false,
        });
        this._secondaryResetItem = new PopupMenu.PopupMenuItem(_('Resets: unknown'), {
            reactive: false,
            can_focus: false,
        });
        this._updatedItem = new PopupMenu.PopupMenuItem(_('Last updated: never'), {
            reactive: false,
            can_focus: false,
        });

        this.menu.addMenuItem(this._primaryItem);
        this.menu.addMenuItem(this._primaryResetItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._secondaryItem);
        this.menu.addMenuItem(this._secondaryResetItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._updatedItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        const openItem = new PopupMenu.PopupMenuItem(_('Open usage page'));
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(USAGE_URL, global.create_app_launch_context(0, -1));
        });
        this.menu.addMenuItem(openItem);

        this.refresh();
        this._scheduleRefresh();
    }

    destroy() {
        if (this._refreshTimeoutId) {
            GLib.Source.remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }

        super.destroy();
    }

    _scheduleRefresh() {
        if (this._refreshTimeoutId)
            GLib.Source.remove(this._refreshTimeoutId);

        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_SECONDS,
            () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    refresh() {
        if (this._refreshing)
            return;

        this._refreshing = true;

        const file = Gio.File.new_for_path(SCRIPT_PATH);
        if (!file.query_exists(null)) {
            this._applyError(`Missing ${SCRIPT_PATH}`);
            this._refreshing = false;
            return;
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        const process = launcher.spawnv([SCRIPT_PATH, '--json']);

        process.communicate_utf8_async(null, null, (_proc, result) => {
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(result);
                if (!process.get_successful()) {
                    this._applyError((stderr || stdout || _('usage script failed')).trim());
                    return;
                }

                this._applyData(JSON.parse(stdout));
            } catch (error) {
                this._applyError(error.message);
            } finally {
                this._refreshing = false;
            }
        });
    }

    _applyData(data) {
        this._lastData = data;

        this._label.text = data.text || _('Codex usage ?');
        this._label.remove_style_class_name('codex-usage-error');
        this._label.remove_style_class_name('codex-usage-stale');

        if (!data.ok)
            this._label.add_style_class_name('codex-usage-error');
        else if (data.stale)
            this._label.add_style_class_name('codex-usage-stale');

        const primary = data.primary || null;
        const secondary = data.secondary || null;

        this._primaryItem.label.text = `5h limit: ${percentText(primary)}`;
        this._primaryResetItem.label.text = `Resets: ${formatReset(primary?.resets_at)}`;
        this._secondaryItem.label.text = `Weekly limit: ${percentText(secondary)}`;
        this._secondaryResetItem.label.text = `Resets: ${formatReset(secondary?.resets_at, true)}`;

        const status = data.stale ? _('stale') : _('fresh');
        this._updatedItem.label.text = `Last updated: ${formatTimestamp(data.updated_at)} (${status})`;
    }

    _applyError(message) {
        if (this._lastData) {
            const data = {...this._lastData, stale: true, error: message};
            this._applyData(data);
            return;
        }

        this._label.text = _('Codex usage ?');
        this._label.remove_style_class_name('codex-usage-stale');
        this._label.add_style_class_name('codex-usage-error');
        this._updatedItem.label.text = `Last updated: failed (${message})`;
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._indicator = new CodexUsageIndicator(this);
        Main.panel.addToStatusArea('codex-usage', this._indicator, 1, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
