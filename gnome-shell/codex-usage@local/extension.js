import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 1;
const TICK_SECONDS = 1;
const SCRIPT_PATH = `${GLib.get_home_dir()}/.local/bin/codex-usage-status`;
const USAGE_URL = 'https://chatgpt.com/codex/settings/usage';
const CONFIG_DIR = `${GLib.get_user_config_dir()}/codex-usage`;
const CONFIG_PATH = `${CONFIG_DIR}/preferences.json`;

const STRINGS = {
    zh: {
        title: 'Codex 用量',
        usageUnknown: 'Codex 用量 ?',
        unknown: '未知',
        primaryLimit: '5小时额度',
        weeklyLimit: '每周额度',
        resets: '重置',
        lastUpdated: '最后更新',
        fresh: '实时',
        stale: '缓存',
        failed: '失败',
        refreshNow: '立即刷新',
        openUsagePage: '打开用量页面',
        switchLanguage: '切换到 English',
        language: '语言',
        refreshEvery: '刷新间隔',
        seconds: '秒',
        left: '剩余',
        weekShort: '周',
        resetting: '正在重置',
        inPrefix: '还有',
        days: '天',
        hours: '小时',
        minutes: '分',
        lessThanMinute: '不到1分钟',
        lastEvent: '最后事件',
        usageScriptFailed: '用量脚本失败',
        missing: '缺少',
    },
    en: {
        title: 'Codex Usage',
        usageUnknown: 'Codex usage ?',
        unknown: 'unknown',
        primaryLimit: '5h limit',
        weeklyLimit: 'Weekly limit',
        resets: 'Resets',
        lastUpdated: 'Last updated',
        fresh: 'live',
        stale: 'cached',
        failed: 'failed',
        refreshNow: 'Refresh now',
        openUsagePage: 'Open usage page',
        switchLanguage: '切换到中文',
        language: 'Language',
        refreshEvery: 'Refresh every',
        seconds: 'seconds',
        left: 'left',
        weekShort: 'W',
        resetting: 'resetting',
        inPrefix: 'in',
        days: 'd',
        hours: 'h',
        minutes: 'm',
        lessThanMinute: '<1m',
        lastEvent: 'Last event',
        usageScriptFailed: 'usage script failed',
        missing: 'Missing',
    },
};

function loadLanguage() {
    try {
        const [ok, contents] = GLib.file_get_contents(CONFIG_PATH);
        if (!ok)
            return 'zh';

        const prefs = JSON.parse(new TextDecoder().decode(contents));
        return prefs.language === 'en' ? 'en' : 'zh';
    } catch (_e) {
        return 'zh';
    }
}

function saveLanguage(language) {
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
        GLib.file_set_contents(CONFIG_PATH, JSON.stringify({language}, null, 2));
    } catch (_e) {
        // The selected language still applies for this Shell session.
    }
}

function formatTimestamp(epochSeconds, strings) {
    if (!epochSeconds)
        return strings.unknown;

    try {
        return GLib.DateTime.new_from_unix_local(epochSeconds).format('%H:%M:%S');
    } catch (_e) {
        return strings.unknown;
    }
}

function formatReset(epochSeconds, weekly, language, strings) {
    if (!epochSeconds)
        return strings.unknown;

    try {
        const dt = GLib.DateTime.new_from_unix_local(epochSeconds);
        if (language === 'zh')
            return weekly ? dt.format('%m月%d日 %H:%M') : dt.format('%H:%M');

        return weekly ? dt.format('%H:%M on %d %b') : dt.format('%H:%M');
    } catch (_e) {
        return strings.unknown;
    }
}

function formatCountdown(epochSeconds, strings) {
    if (!epochSeconds)
        return strings.unknown;

    const remaining = Math.max(0, epochSeconds - Math.floor(Date.now() / 1000));
    if (remaining <= 0)
        return strings.resetting;

    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);

    if (days > 0)
        return `${strings.inPrefix} ${days}${strings.days} ${hours}${strings.hours}`;
    if (hours > 0)
        return `${strings.inPrefix} ${hours}${strings.hours} ${minutes}${strings.minutes}`;
    if (minutes > 0)
        return `${strings.inPrefix} ${minutes}${strings.minutes}`;

    return `${strings.inPrefix} ${strings.lessThanMinute}`;
}

function percentText(limit, strings) {
    if (!limit || limit.left_percent === undefined || limit.left_percent === null)
        return strings.unknown;

    return `${limit.left_percent}% ${strings.left}`;
}

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Codex Usage'));

        this._extension = extension;
        this._language = loadLanguage();
        this._refreshTimeoutId = 0;
        this._tickTimeoutId = 0;
        this._refreshing = false;
        this._lastData = null;
        this._signalConnections = [];

        this._label = new St.Label({
            text: this._t('usageUnknown'),
            style_class: 'codex-usage-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._primaryItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._primaryResetItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._secondaryItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._secondaryResetItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._updatedItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._eventItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._refreshIntervalItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._languageStatusItem = new PopupMenu.PopupMenuItem('', {
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
        this.menu.addMenuItem(this._eventItem);
        this.menu.addMenuItem(this._refreshIntervalItem);
        this.menu.addMenuItem(this._languageStatusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupMenuItem('');
        this._refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(this._refreshItem);

        this._languageItem = new PopupMenu.PopupMenuItem('');
        this._languageItem.connect('activate', () => this._toggleLanguage());
        this.menu.addMenuItem(this._languageItem);

        this._openItem = new PopupMenu.PopupMenuItem('');
        this._openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(USAGE_URL, global.create_app_launch_context(0, -1));
        });
        this.menu.addMenuItem(this._openItem);

        this._hoverLabel = new St.Label({
            style_class: 'codex-usage-tooltip',
            text: '',
            visible: false,
        });
        Main.uiGroup.add_child(this._hoverLabel);

        this._signalConnections.push([this, this.connect('enter-event', () => {
            this._showHoverDetails();
            return Clutter.EVENT_PROPAGATE;
        })]);
        this._signalConnections.push([this, this.connect('leave-event', () => {
            this._hideHoverDetails();
            return Clutter.EVENT_PROPAGATE;
        })]);
        this._signalConnections.push([this.menu, this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._hideHoverDetails();
        })]);

        this._updateMenuLabels();
        this.refresh();
        this._scheduleRefresh();
        this._scheduleTick();
    }

    destroy() {
        if (this._refreshTimeoutId) {
            GLib.Source.remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }
        if (this._tickTimeoutId) {
            GLib.Source.remove(this._tickTimeoutId);
            this._tickTimeoutId = 0;
        }
        for (const [target, id] of this._signalConnections)
            target.disconnect(id);
        this._signalConnections = [];
        this._hoverLabel?.destroy();
        this._hoverLabel = null;

        super.destroy();
    }

    _t(key) {
        return STRINGS[this._language][key];
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

    _scheduleTick() {
        if (this._tickTimeoutId)
            GLib.Source.remove(this._tickTimeoutId);

        this._tickTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            TICK_SECONDS,
            () => {
                this._updateMenuLabels();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _toggleLanguage() {
        this._language = this._language === 'zh' ? 'en' : 'zh';
        saveLanguage(this._language);
        this._updateDisplay();
        this._showHoverDetails();
    }

    refresh() {
        if (this._refreshing)
            return;

        this._refreshing = true;

        const file = Gio.File.new_for_path(SCRIPT_PATH);
        if (!file.query_exists(null)) {
            this._applyError(`${this._t('missing')} ${SCRIPT_PATH}`);
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
                    this._applyError((stderr || stdout || this._t('usageScriptFailed')).trim());
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
        this._updateDisplay();
    }

    _updateDisplay() {
        const data = this._lastData;
        if (!data) {
            this._label.text = this._t('usageUnknown');
            this._updateMenuLabels();
            return;
        }

        this._label.text = this._formatPanelText(data);
        this._label.remove_style_class_name('codex-usage-error');
        this._label.remove_style_class_name('codex-usage-stale');

        if (!data.ok)
            this._label.add_style_class_name('codex-usage-error');
        else if (data.stale)
            this._label.add_style_class_name('codex-usage-stale');

        this._updateMenuLabels();
    }

    _formatPanelText(data) {
        const primary = data.primary || {};
        const secondary = data.secondary || {};
        const pLeft = primary.left_percent;
        const sLeft = secondary.left_percent;

        if (pLeft === undefined && sLeft === undefined)
            return this._t('usageUnknown');
        if (pLeft === undefined)
            return `Codex ${this._t('weekShort')} ${sLeft}%`;
        if (sLeft === undefined)
            return this._language === 'zh' ? `Codex 5时 ${pLeft}%` : `Codex 5h ${pLeft}%`;

        if (this._language === 'zh')
            return `Codex 5时 ${pLeft}% · ${this._t('weekShort')} ${sLeft}%`;

        return `Codex 5h ${pLeft}% · ${this._t('weekShort')} ${sLeft}%`;
    }

    _updateMenuLabels() {
        const strings = STRINGS[this._language];
        const data = this._lastData || {};
        const primary = data.primary || null;
        const secondary = data.secondary || null;

        this._primaryItem.label.text = `${strings.primaryLimit}: ${percentText(primary, strings)}`;
        this._primaryResetItem.label.text = `${strings.resets}: ${formatReset(primary?.resets_at, false, this._language, strings)} (${formatCountdown(primary?.resets_at, strings)})`;
        this._secondaryItem.label.text = `${strings.weeklyLimit}: ${percentText(secondary, strings)}`;
        this._secondaryResetItem.label.text = `${strings.resets}: ${formatReset(secondary?.resets_at, true, this._language, strings)} (${formatCountdown(secondary?.resets_at, strings)})`;

        const status = data.stale ? strings.stale : strings.fresh;
        this._updatedItem.label.text = `${strings.lastUpdated}: ${formatTimestamp(data.updated_at, strings)} (${status})`;
        this._eventItem.label.text = `${strings.lastEvent}: ${formatTimestamp(data.seen_at, strings)}`;
        this._refreshIntervalItem.label.text = `${strings.refreshEvery}: ${REFRESH_SECONDS}${strings.seconds}`;
        this._languageStatusItem.label.text = `${strings.language}: ${this._language === 'zh' ? '中文' : 'English'}`;
        this._refreshItem.label.text = strings.refreshNow;
        this._languageItem.label.text = strings.switchLanguage;
        this._openItem.label.text = strings.openUsagePage;

        if (this._hoverLabel?.visible)
            this._updateHoverDetails();
    }

    _detailText() {
        const strings = STRINGS[this._language];
        const data = this._lastData || {};
        const primary = data.primary || null;
        const secondary = data.secondary || null;
        const status = data.stale ? strings.stale : strings.fresh;

        if (this._language === 'zh') {
            return [
                strings.title,
                `${strings.primaryLimit}: ${percentText(primary, strings)} / 已用 ${primary?.used_percent ?? strings.unknown}%`,
                `${strings.resets}: ${formatReset(primary?.resets_at, false, this._language, strings)} (${formatCountdown(primary?.resets_at, strings)})`,
                `${strings.weeklyLimit}: ${percentText(secondary, strings)} / 已用 ${secondary?.used_percent ?? strings.unknown}%`,
                `${strings.resets}: ${formatReset(secondary?.resets_at, true, this._language, strings)} (${formatCountdown(secondary?.resets_at, strings)})`,
                `${strings.lastEvent}: ${formatTimestamp(data.seen_at, strings)}`,
                `${strings.lastUpdated}: ${formatTimestamp(data.updated_at, strings)} (${status})`,
            ].join('\n');
        }

        return [
            strings.title,
            `${strings.primaryLimit}: ${percentText(primary, strings)} / used ${primary?.used_percent ?? strings.unknown}%`,
            `${strings.resets}: ${formatReset(primary?.resets_at, false, this._language, strings)} (${formatCountdown(primary?.resets_at, strings)})`,
            `${strings.weeklyLimit}: ${percentText(secondary, strings)} / used ${secondary?.used_percent ?? strings.unknown}%`,
            `${strings.resets}: ${formatReset(secondary?.resets_at, true, this._language, strings)} (${formatCountdown(secondary?.resets_at, strings)})`,
            `${strings.lastEvent}: ${formatTimestamp(data.seen_at, strings)}`,
            `${strings.lastUpdated}: ${formatTimestamp(data.updated_at, strings)} (${status})`,
        ].join('\n');
    }

    _showHoverDetails() {
        if (!this._hoverLabel || this.menu.isOpen)
            return;

        this._updateHoverDetails();
        this._hoverLabel.show();
    }

    _hideHoverDetails() {
        this._hoverLabel?.hide();
    }

    _updateHoverDetails() {
        if (!this._hoverLabel)
            return;

        this._hoverLabel.text = this._detailText();

        const [actorX, actorY] = this.get_transformed_position();
        const [actorWidth, actorHeight] = this.get_transformed_size();
        const [, tooltipWidth] = this._hoverLabel.get_preferred_width(-1);
        const monitor = Main.layoutManager.primaryMonitor;
        const margin = 8;

        let tooltipX = Math.round(actorX + actorWidth / 2 - tooltipWidth / 2);
        tooltipX = Math.max(monitor.x + margin, tooltipX);
        tooltipX = Math.min(monitor.x + monitor.width - tooltipWidth - margin, tooltipX);

        const tooltipY = Math.round(actorY + actorHeight + 6);
        this._hoverLabel.set_position(tooltipX, tooltipY);
    }

    _applyError(message) {
        if (this._lastData) {
            const data = {...this._lastData, stale: true, error: message};
            this._applyData(data);
            return;
        }

        this._label.text = this._t('usageUnknown');
        this._label.remove_style_class_name('codex-usage-stale');
        this._label.add_style_class_name('codex-usage-error');
        this._updateMenuLabels();
        this._updatedItem.label.text = `${this._t('lastUpdated')}: ${this._t('failed')} (${message})`;
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
