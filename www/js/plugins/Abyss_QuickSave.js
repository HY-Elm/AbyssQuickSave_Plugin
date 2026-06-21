//=============================================================================
// Abyss_QuickSave.js
//=============================================================================

/*:
 * @plugindesc 使用官方第20号槽的快速保存、官方读取入口与安全卸载。
 * @author Abyss
 *
 * @help
 * Ctrl+Shift+S      快速保存到界面显示的第20号槽
 * Ctrl+Shift+L      打开官方读取界面并定位第20号槽
 * Ctrl+Shift+Delete 删除快速存档并停用功能
 *
 * 战斗、敌人警戒/追击或附近存在敌人时不会写入存档。
 * 在家（剧情区域）以及剧情/事件演出过程中不会写入存档，但仍可正常快速读取。
 * 每次保存都会显示第20号槽覆盖确认。
 * 地面存在掉落物时会额外显示官方篝火与读取恢复风险。
 *
 * 主菜单中可打开“快速存档管理”。
 */

(function() {
    'use strict';

    var PLUGIN_NAME = 'Abyss_QuickSave';
    // TSR_Save 把内部1号作为自动存档，普通槽显示为“内部ID - 1”。
    // 因此界面第20号槽实际对应 file21.rpgsave。
    var OFFICIAL_SLOT = 21;
    var DISABLED_FILE = 'AbyssQuickSave.disabled';
    var SAVE_VERSION = 6;
    var COMBAT_SAFE_FRAMES = 60;
    var COMBAT_RADIUS_PIXELS = 240;
    var HOSTILE_PROJECTILE_GROUPS = [
        'enemyBullet',
        'enemyWeapon',
        'enemyDash'
    ];

    var AbyssQuickSave = {
        pendingAction: null,
        pendingDelay: 0,
        pendingTimeout: 0,
        abyssConfirmed: false,
        busy: false,
        operationBusy: false,
        operationName: '',
        savingOfficialSlot: false,
        openLoadAtSlot20: false,
        loadSwitchArmed: false,
        loadSwitchTimeout: 0,
        loadedFromManagedSave: false,
        managedLoadGraceFrames: 0,
        managedUiRepairPending: false,
        managedUiRepairDelay: 0,
        managedUiRepairMapId: 0,
        managedVirtualButtonsVisible: null,
        combatQuietFrames: 0,
        combatSafetyMapId: 0,
        preserveSpawnDataOnReload: false
    };

    window.AbyssQuickSave = AbyssQuickSave;

    AbyssQuickSave.runAsync = function(promise, label) {
        Promise.resolve(promise).catch(function(error) {
            console.error(PLUGIN_NAME + ': ' + (label || 'async operation') +
                ' failed', error);
        });
    };

    AbyssQuickSave.beginOperation = function(name) {
        if (this.operationBusy || this.pendingAction) {
            SoundManager.playBuzzer();
            this.toast('已有快速存档操作正在等待或执行，请先完成当前操作。', '#ffb0b0');
            return false;
        }
        this.operationBusy = true;
        this.operationName = name || 'operation';
        return true;
    };

    AbyssQuickSave.endOperation = function() {
        this.operationBusy = false;
        this.operationName = '';
    };

    AbyssQuickSave.focusCancelButton = function(expectedConfirmText) {
        var observer = null;
        var fallbackTimer = null;
        var timeoutTimer = null;

        var cleanup = function() {
            if (observer) observer.disconnect();
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            observer = null;
            fallbackTimer = null;
            timeoutTimer = null;
        };

        var findButton = function() {
            var overlays = document.querySelectorAll('.dialog-overlay');
            for (var i = overlays.length - 1; i >= 0; i--) {
                var confirmButton =
                    overlays[i].querySelector('[data-action="confirm"]');
                var cancelButton =
                    overlays[i].querySelector('[data-action="cancel"]');
                if (!confirmButton || !cancelButton) continue;
                if (String(confirmButton.textContent || '').trim() !==
                    String(expectedConfirmText || '').trim()) {
                    continue;
                }

                cleanup();
                // rpg_custom.js 会在 50ms 后聚焦确认按钮；稍后再聚焦取消，
                // 确保键盘回车不会默认执行覆盖、删除或卸载。
                setTimeout(function() {
                    if (document.body.contains(cancelButton)) {
                        cancelButton.focus();
                    }
                }, 100);
                return true;
            }
            return false;
        };

        if (findButton()) return;
        if (typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(findButton);
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            var poll = function() {
                if (!findButton()) fallbackTimer = setTimeout(poll, 50);
            };
            fallbackTimer = setTimeout(poll, 50);
        }
        timeoutTimer = setTimeout(cleanup, 10 * 60 * 1000);
    };

    AbyssQuickSave.confirmAction = async function(message, options) {
        var dialogOptions = Object.assign({
            confirmText: '确认',
            cancelText: '取消',
            align: 'left',
            width: 620
        }, options || {});

        try {
            var result = window.confirm(message, dialogOptions);
            if (result && typeof result.then === 'function') {
                this.focusCancelButton(dialogOptions.confirmText);
                result = await result;
            }
            return result === true;
        } catch (error) {
            console.error(PLUGIN_NAME + ': confirmation failed; cancelled', error);
            return false;
        }
    };

    AbyssQuickSave.alertAction = async function(message, options) {
        try {
            var result = window.alert(message, options || {});
            if (result && typeof result.then === 'function') await result;
            return true;
        } catch (error) {
            console.error(PLUGIN_NAME + ': alert failed', error);
            return false;
        }
    };

    AbyssQuickSave.saveDirectory = function() {
        return StorageManager.localFileDirectoryPath();
    };

    AbyssQuickSave.disabledPath = function() {
        if (!StorageManager.isLocalMode()) return '';
        var path = require('path');
        return path.join(this.saveDirectory(), DISABLED_FILE);
    };

    AbyssQuickSave.isDisabled = function() {
        if (StorageManager.isLocalMode()) {
            var fs = require('fs');
            return fs.existsSync(this.disabledPath());
        }
        return localStorage.getItem('AbyssQuickSaveDisabled') === '1';
    };

    AbyssQuickSave.setDisabled = function(value) {
        if (StorageManager.isLocalMode()) {
            var fs = require('fs');
            var path = require('path');
            var file = this.disabledPath();
            if (value) {
                var dir = path.dirname(file);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(file, 'disabled', 'utf8');
            } else if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } else if (value) {
            localStorage.setItem('AbyssQuickSaveDisabled', '1');
        } else {
            localStorage.removeItem('AbyssQuickSaveDisabled');
        }
    };

    AbyssQuickSave.exists = function(slotId) {
        try {
            return StorageManager.exists(slotId);
        } catch (e) {
            return false;
        }
    };

    AbyssQuickSave.slotInfo = function() {
        try {
            return DataManager.loadSavefileInfo(OFFICIAL_SLOT);
        } catch (e) {
            return null;
        }
    };

    // 结构化兼容检测：识别本插件（含历史命名）写入的快存标记，
    // 不在代码中保留任何旧品牌字符串。新存档统一写成 _abyssQuickSave。
    AbyssQuickSave.detectContentsMarker = function(contents) {
        if (!contents || typeof contents !== 'object') return null;
        if (contents._abyssQuickSave &&
            typeof contents._abyssQuickSave === 'object') {
            return contents._abyssQuickSave;
        }
        var keys = Object.keys(contents);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key.charAt(0) !== '_' || !/QuickSave$/.test(key)) continue;
            var value = contents[key];
            if (value && typeof value === 'object' &&
                typeof value.version === 'number' &&
                typeof value.mapId === 'number' &&
                typeof value.timestamp === 'number') {
                return value;
            }
        }
        return null;
    };

    AbyssQuickSave.detectInfoMarker = function(info) {
        if (!info || typeof info !== 'object') return false;
        if (info.abyssQuickSave === true) return true;
        var keys = Object.keys(info);
        for (var i = 0; i < keys.length; i++) {
            if (/QuickSave$/.test(keys[i]) && info[keys[i]] === true) return true;
        }
        return false;
    };

    AbyssQuickSave.isManagedSlot = function() {
        return this.detectInfoMarker(this.slotInfo());
    };

    AbyssQuickSave.isSlotManaged = function(slotId) {
        try {
            if (this.detectInfoMarker(DataManager.loadSavefileInfo(slotId))) {
                return true;
            }
        } catch (e) {
        }

        if (!this.exists(slotId)) return false;
        try {
            var contents = JsonEx.parse(StorageManager.load(slotId));
            return !!this.detectContentsMarker(contents);
        } catch (e2) {
            console.warn(PLUGIN_NAME + ': unable to inspect slot ' + slotId, e2);
            return false;
        }
    };

    AbyssQuickSave.groundDropCount = function() {
        if (!$gameMap || !$gameMap.getGroupBulletListQJ) return 0;
        try {
            return $gameMap.getGroupBulletListQJ('itemDrops').length;
        } catch (e) {
            return 0;
        }
    };

    AbyssQuickSave.saveConfirmationText = function(abyss, dropCount) {
        var lines = [];
        lines.push('快速保存将写入官方第20号槽。');
        lines.push('');

        var info = this.slotInfo();
        if (info) {
            var type = this.detectInfoMarker(info) ?
                '本插件创建的快速存档' : '普通/官方存档';
            var timestamp = info.timestamp ?
                new Date(info.timestamp).toLocaleString() : '时间未知';
            lines.push('当前槽位：' + type + '（' + timestamp + '）');
            lines.push('继续将覆盖该存档，覆盖后无法撤销。');
        } else {
            lines.push('当前第20号槽为空，将创建新存档。');
        }

        if (abyss) {
            lines.push('');
            lines.push('当前位置为迷宫/深渊，请保留进入前的其他存档。');
        }

        if (dropCount > 0) {
            lines.push('');
            lines.push('检测到地面掉落物：' + dropCount + ' 个。');
            lines.push('官方篝火保存也会清除这些掉落物的当前显示；');
            lines.push('本插件会尝试在读取时重建，但特殊掉落仍可能无法恢复。');
            lines.push('建议取消并先拾取地面物品。');
        }

        lines.push('');
        lines.push('是否继续保存？');
        return lines.join('\n');
    };

    AbyssQuickSave.hasAnyManagedSave = function() {
        return this.isSlotManaged(OFFICIAL_SLOT);
    };

    AbyssQuickSave.isAbyssMap = function() {
        if (!$dataMap) return false;
        if ($dataMap.meta && $dataMap.meta['深渊'] !== undefined) return true;
        return /<深渊>/i.test($dataMap.note || '');
    };

    // 家（备注 <宅>）是剧情流程跑的地方，禁止快速保存（仍可快速读取），
    // 从源头杜绝“在家剧情演出半途存档”把跑了一半的事件烤进存档。
    AbyssQuickSave.isHomeMap = function() {
        if (!$dataMap) return false;
        if ($dataMap.meta && $dataMap.meta['宅'] !== undefined) return true;
        return /<宅>/i.test($dataMap.note || '');
    };

    /*
    是否有地图事件解释器正在“自动往下跑”的剧情演出。停在 Show Choices /
    数字输入 / 物品选择处等待玩家输入的不算（此时后续命令尚未执行，存档
    后读回来会重新弹出选择，安全）。其余（Wait、移动、加状态等自动推进）
    都算危险：半途存档会把未跑完的事件序列化，读取时从中途继续执行，
    导致重复加状态/掉血等异常。
    */
    AbyssQuickSave.isStoryEventAdvancing = function() {
        if (!$gameMap || !$gameMap.isEventRunning || !$gameMap.isEventRunning()) {
            return false;
        }
        var waitingForInput = $gameMessage && (
            ($gameMessage.isChoice && $gameMessage.isChoice()) ||
            ($gameMessage.isNumberInput && $gameMessage.isNumberInput()) ||
            ($gameMessage.isItemChoice && $gameMessage.isItemChoice())
        );
        return !waitingForInput;
    };

    AbyssQuickSave.hasProjectileGroup = function(groupName) {
        if (!$gameMap || !$gameMap.getGroupBulletListQJ) return false;
        try {
            return $gameMap.getGroupBulletListQJ(groupName).length > 0;
        } catch (e) {
            return false;
        }
    };

    AbyssQuickSave.enemyEventIds = function() {
        if (!$gameMap || !$gameMap.getGroupEventListQJ) return [];

        var result = [];
        var seen = {};
        // 部分地图的 QJ Group 标签保留了引号，两个键都需要检查。
        ['enemy', '"enemy"'].forEach(function(groupName) {
            var list = $gameMap.getGroupEventListQJ(groupName) || [];
            list.forEach(function(eventId) {
                eventId = Number(eventId || 0);
                if (eventId > 0 && !seen[eventId]) {
                    seen[eventId] = true;
                    result.push(eventId);
                }
            });
        });
        return result;
    };

    AbyssQuickSave.isActiveEnemyEvent = function(event) {
        if (!event || event._erased || !event.page || !event.page()) return false;
        var eventId = Number(event.eventId ? event.eventId() : event._eventId);
        if (eventId <= 0) return false;
        if ($gameSelfSwitches) {
            var mapId = $gameMap.mapId();
            if ($gameSelfSwitches.value([mapId, eventId, 'D']) ||
                $gameSelfSwitches.value([mapId, eventId, 'F'])) {
                return false;
            }
        }
        return true;
    };

    AbyssQuickSave.enemyDistancePixels = function(event) {
        if (!event || !$gamePlayer || !$gameMap) return Infinity;
        var eventX = Number(event._realX !== undefined ? event._realX : event.x);
        var eventY = Number(event._realY !== undefined ? event._realY : event.y);
        var playerX = Number($gamePlayer._realX !== undefined ?
            $gamePlayer._realX : $gamePlayer.x);
        var playerY = Number($gamePlayer._realY !== undefined ?
            $gamePlayer._realY : $gamePlayer.y);
        var dx = $gameMap.deltaX ? $gameMap.deltaX(eventX, playerX) :
            eventX - playerX;
        var dy = $gameMap.deltaY ? $gameMap.deltaY(eventY, playerY) :
            eventY - playerY;
        var tileWidth = $gameMap.tileWidth ? $gameMap.tileWidth() : 48;
        var tileHeight = $gameMap.tileHeight ? $gameMap.tileHeight() : 48;
        return Math.hypot(dx * tileWidth, dy * tileHeight);
    };

    AbyssQuickSave.combatThreatReason = function() {
        if (!$gameMap || !$gamePlayer || !$gameParty) return '';
        if ($gameParty.inBattle && $gameParty.inBattle()) {
            return '战斗中不能快速保存。';
        }
        if ($gameTemp && $gameTemp._isInBattle) {
            return '剧情或特殊战斗中不能快速保存。';
        }

        for (var i = 0; i < HOSTILE_PROJECTILE_GROUPS.length; i++) {
            if (this.hasProjectileGroup(HOSTILE_PROJECTILE_GROUPS[i])) {
                return '敌方攻击尚未结束，不能快速保存。';
            }
        }

        var eventIds = this.enemyEventIds();
        for (var j = 0; j < eventIds.length; j++) {
            var event = $gameMap.event(eventIds[j]);
            if (!this.isActiveEnemyEvent(event)) continue;

            var enemyState = Number(event._enemyState || 0);
            if (enemyState === 1 || enemyState === 2 || enemyState === 3 ||
                event._chasePlayer || event._alertEverything ||
                event._shouldAlert) {
                return '敌人处于警戒或追击状态，不能快速保存。';
            }
            if (this.enemyDistancePixels(event) <= COMBAT_RADIUS_PIXELS) {
                return '附近有敌人，不能快速保存。';
            }
        }
        return '';
    };

    AbyssQuickSave.updateCombatSafety = function() {
        if (!$gameMap || !$gamePlayer) {
            this.combatQuietFrames = 0;
            this.combatSafetyMapId = 0;
            return;
        }

        var mapId = Number($gameMap.mapId() || 0);
        if (this.combatSafetyMapId !== mapId) {
            this.combatSafetyMapId = mapId;
            this.combatQuietFrames = 0;
        }

        if (this.combatThreatReason()) {
            this.combatQuietFrames = 0;
        } else {
            this.combatQuietFrames = Math.min(
                COMBAT_SAFE_FRAMES,
                this.combatQuietFrames + 1
            );
        }
    };

    AbyssQuickSave.combatSaveBlockReason = function() {
        var reason = this.combatThreatReason();
        if (reason) return reason;
        if (this.combatQuietFrames < COMBAT_SAFE_FRAMES) {
            return '请确认已经脱离战斗，稍候再快速保存。';
        }
        return '';
    };

    AbyssQuickSave.canSaveNow = function() {
        if (this.isDisabled()) return '快速存档功能已停用。';
        if (!$gameMap || !$gamePlayer || !$gameSystem || !$gameParty) return '当前没有可保存的游戏。';
        // 家（<宅>）只读不存：家是剧情流程跑的地方，禁止在此快速保存，
        // 避免把半截剧情事件烤进存档（家中仍可正常快速读取）。
        if (this.isHomeMap()) return '在家无法快速保存，请在探索区域保存（家中可正常快速读取）。';
        var combatReason = this.combatSaveBlockReason();
        if (combatReason) return combatReason;
        // 通用防线：剧情/事件正在自动推进时禁止保存（深渊里的剧情演出同样
        // 适用）。停在 Show Choices/输入处等待玩家选择的交互菜单除外，仍可存。
        if (this.isStoryEventAdvancing()) return '剧情/事件进行中不能快速保存，请等这段演出结束。';
        if ($gamePlayer.isTransferring && $gamePlayer.isTransferring()) return '地图切换中不能快速保存。';
        if ($gamePlayer.isMoving && $gamePlayer.isMoving()) return '请先停下角色再快速保存。';
        if (SceneManager.isSceneChanging && SceneManager.isSceneChanging()) return '界面切换中不能快速保存。';
        return '';
    };

    AbyssQuickSave.captureProjectileState = function() {
        if (!$gameMap) return null;
        return {
            bullets: $gameMap._mapBulletsQJ,
            names: $gameMap._mapBulletsNameQJ,
            length: $gameMap._mapBulletsQJLength
        };
    };

    AbyssQuickSave.hideProjectilesForSerialization = function() {
        if (!$gameMap) return;
        $gameMap._mapBulletsQJ = {};
        $gameMap._mapBulletsNameQJ = {};
        $gameMap._mapBulletsQJLength = 0;
    };

    AbyssQuickSave.restoreProjectileState = function(state) {
        if (!$gameMap || !state) return;
        $gameMap._mapBulletsQJ = state.bullets || {};
        $gameMap._mapBulletsNameQJ = state.names || {};
        $gameMap._mapBulletsQJLength = Number(state.length || 0);
    };

    AbyssQuickSave.defaultVirtualButtonsVisible = function() {
        return !!(window.Utils && Utils.isMobileDevice &&
            Utils.isMobileDevice());
    };

    AbyssQuickSave.restoreManagedVirtualButtons = function() {
        if (!window.QJ || !QJ.VB) return;
        var visible = this.managedVirtualButtonsVisible;
        if (visible === null || visible === undefined) {
            visible = this.defaultVirtualButtonsVisible();
        }
        QJ.VB.controlVisible = !!visible;
    };

    AbyssQuickSave.repairManagedMapUi = function() {
        if (!this.loadedFromManagedSave || !$gameMap || !$gamePlayer) {
            return false;
        }
        if (!(SceneManager._scene instanceof Scene_Map) ||
            !SceneManager._scene._spriteset) {
            return false;
        }
        if ($gamePlayer.isTransferring && $gamePlayer.isTransferring()) {
            return false;
        }
        if (this.managedUiRepairMapId > 0 &&
            $gameMap.mapId() !== this.managedUiRepairMapId) {
            return false;
        }

        /*
        正常的事件指令转移会执行公共事件 21，其中负责玩家/UI 初始化的核心是ex_playerConditionCheck()。而托管读取走的是 reserveTransfer
        不会触发那个公共事件。这里只调用确定性的初始化函数；不能跑整个转移公共事件，可能会随机生成地图对象。
        */
        try {
            if (window.QJ && QJ.MPMZ && QJ.MPMZ.tl &&
                typeof QJ.MPMZ.tl.ex_playerConditionCheck === 'function') {
                QJ.MPMZ.tl.ex_playerConditionCheck();
            }
        } catch (e) {
            console.error(PLUGIN_NAME + ': player/UI initialization failed', e);
        }

        // 在系统 group 重建之后，再重建一次任务指引。该函数会先移除旧的 group再创建新的。
        try {
            var actor = $gameParty && $gameParty.leader ?
                $gameParty.leader() : null;
            if (actor && actor._shouldShowQuestGuide &&
                window.chahuiUtil &&
                typeof chahuiUtil.questObjectiveGuide === 'function') {
                chahuiUtil.questObjectiveGuide();
            }
        } catch (e2) {
            console.error(PLUGIN_NAME + ': quest UI initialization failed', e2);
        }

        // ex_playerConditionCheck 会强制把该标志置为开启。这里恢复快速存档时实际捕获的状态。
        this.restoreManagedVirtualButtons();
        return true;
    };

    AbyssQuickSave.clearDisplayCache = function() {
        try {
            if (DataManager.clearSaveDisplayCache) {
                DataManager.clearSaveDisplayCache();
            }
        } catch (error) {
            console.warn(PLUGIN_NAME + ': unable to clear save display cache',
                error);
        }
    };

    AbyssQuickSave.beginManagedDeletion = function(slotIds) {
        var unique = [];
        var seen = {};
        for (var i = 0; i < slotIds.length; i++) {
            var slotId = Number(slotIds[i]);
            if (slotId > 0 && !seen[slotId]) {
                seen[slotId] = true;
                unique.push(slotId);
            }
        }

        var originalGlobalInfo = DataManager.loadGlobalInfo() || [];
        var transaction = {
            ok: false,
            active: true,
            slots: [],
            hadFile: {},
            originalGlobalInfo: originalGlobalInfo.slice()
        };

        try {
            for (var j = 0; j < unique.length; j++) {
                var managedSlotId = unique[j];
                if (!this.isSlotManaged(managedSlotId)) continue;

                transaction.hadFile[managedSlotId] = this.exists(managedSlotId);
                if (transaction.hadFile[managedSlotId]) {
                    StorageManager.backup(managedSlotId);
                    if (!StorageManager.backupExists(managedSlotId)) {
                        throw new Error('无法为存档槽 ' + managedSlotId + ' 创建删除备份。');
                    }
                }
                transaction.slots.push(managedSlotId);
            }

            if (transaction.slots.length === 0) {
                transaction.ok = true;
                return transaction;
            }

            var nextGlobalInfo = transaction.originalGlobalInfo.slice();
            for (var k = 0; k < transaction.slots.length; k++) {
                var deletingSlotId = transaction.slots[k];
                StorageManager.remove(deletingSlotId);
                delete nextGlobalInfo[deletingSlotId];
            }
            DataManager.saveGlobalInfo(nextGlobalInfo);
            transaction.ok = true;
            return transaction;
        } catch (error) {
            transaction.error = error;
            console.error(PLUGIN_NAME + ': managed save deletion failed', error);
            this.rollbackManagedDeletion(transaction);
            transaction.ok = false;
            return transaction;
        }
    };

    AbyssQuickSave.rollbackManagedDeletion = function(transaction) {
        if (!transaction || !transaction.active) return true;
        var restored = true;

        for (var i = 0; i < transaction.slots.length; i++) {
            var slotId = transaction.slots[i];
            if (!transaction.hadFile[slotId]) continue;
            try {
                if (!StorageManager.backupExists(slotId)) {
                    throw new Error('存档槽 ' + slotId + ' 的回滚备份不存在。');
                }
                StorageManager.restoreBackup(slotId);
            } catch (error) {
                restored = false;
                console.error(PLUGIN_NAME + ': unable to restore slot ' + slotId, error);
            }
        }

        try {
            DataManager.saveGlobalInfo(transaction.originalGlobalInfo);
        } catch (globalError) {
            restored = false;
            console.error(PLUGIN_NAME + ': unable to restore global save index',
                globalError);
        }

        transaction.active = false;
        this.clearDisplayCache();
        return restored;
    };

    AbyssQuickSave.commitManagedDeletion = function(transaction) {
        if (!transaction || !transaction.active) return;
        for (var i = 0; i < transaction.slots.length; i++) {
            var slotId = transaction.slots[i];
            try {
                StorageManager.cleanBackup(slotId);
            } catch (error) {
                // 删除已经完成；备份清理失败时保留 .bak 比丢失回滚数据更安全。
                console.warn(PLUGIN_NAME + ': unable to clean deletion backup for slot ' +
                    slotId, error);
            }
        }
        transaction.active = false;
        this.clearDisplayCache();
    };

    AbyssQuickSave.quickSave = async function() {
        if (!this.beginOperation('save')) return false;

        try {
            var reason = this.canSaveNow();
            if (reason) {
                SoundManager.playBuzzer();
                this.toast(reason, '#ffb0b0');
                return false;
            }

            var abyss = this.isAbyssMap();
            var dropCount = this.groundDropCount();
            var confirmed = await this.confirmAction(
                this.saveConfirmationText(abyss, dropCount),
                {
                    title: '快速保存',
                    confirmText: '确认覆盖',
                    cancelText: '取消'
                }
            );
            if (confirmed !== true) {
                SoundManager.playCancel();
                this.toast('已取消快速保存，第20号槽未被修改。', '#ffd59d');
                return false;
            }

            // 玩家确认期间游戏状态可能已经改变；写盘前必须重新验证。
            reason = this.canSaveNow();
            if (reason) {
                SoundManager.playBuzzer();
                this.toast('保存条件已经变化：' + reason, '#ffb0b0');
                return false;
            }
            if (!(SceneManager._scene instanceof Scene_Map)) {
                SoundManager.playBuzzer();
                this.toast('当前已不在地图场景，快速保存已取消。', '#ffb0b0');
                return false;
            }

            var projectileState = this.captureProjectileState();
            var previousLastAccessed = DataManager.lastAccessedSavefileId();
            var success = false;

            this.busy = true;
            try {
                if ($gameMap.saveSpawnEventDataQJ) $gameMap.saveSpawnEventDataQJ();
                if ($gameSystem.truePlaytimeText) $gameSystem.truePlaytimeText();
                if ($gameSystem.onBeforeSave) $gameSystem.onBeforeSave();

                this.hideProjectilesForSerialization();
                this.savingOfficialSlot = true;
                success = DataManager.saveGame(OFFICIAL_SLOT);
            } catch (error) {
                console.error(PLUGIN_NAME + ': official slot save failed', error);
                success = false;
            } finally {
                this.savingOfficialSlot = false;
                this.restoreProjectileState(projectileState);
                DataManager._lastAccessedId = previousLastAccessed;
                this.busy = false;
            }

            if (success && this.exists(OFFICIAL_SLOT)) {
                this.clearDisplayCache();
                SoundManager.playSave();
                this.toast(
                    dropCount > 0 ?
                        '已保存到第20号槽；读取时将尝试重建地面掉落物' :
                        (abyss ? '已保存到官方第20号槽（迷宫存档）' :
                            '已保存到官方第20号槽'),
                    '#b8ffbf'
                );
                return true;
            }

            SoundManager.playBuzzer();
            this.toast('快速存档失败，第20号槽已尽量恢复。', '#ff9d9d');
            return false;
        } finally {
            this.endOperation();
        }
    };

    /*
    快捷读取崩溃根因：地图场景尚未建立 _spriteset 等显示对象时切换到读取界面，
    会触发官方 Scene_Map.terminate 里的 this._spriteset.update()对 undefined 调用。
    读取前必须确认地图场景已经完整启动且空闲。
    */
    AbyssQuickSave.mapLoadBlockReason = function() {
        var scene = SceneManager._scene;
        if (!(scene instanceof Scene_Map)) {
            return '请在地图界面使用快捷读取。';
        }
        /*官方/自定义 terminate 真正会解引用的只有 _spriteset.update() 与_mapNameWindow.hide()；
        这两者在地图加载完成后必然存在。_fadeSprite、_windowLayer 只是传给 removeChild（对 undefined 安全），
        不能作为“是否载入完成”的判据——从菜单返回的地图不触发淡入，_fadeSprite 永远不会创建，旧判据会在安全地点误报“地图还在载入中”。
        */
        if (!scene._spriteset || !scene._mapNameWindow) {
            return '地图还在载入中，请稍候再读取。';
        }
        if (SceneManager.isSceneChanging && SceneManager.isSceneChanging()) {
            return '界面切换中不能读取。';
        }
        if (scene.isBusy && scene.isBusy()) {
            return '当前界面忙碌，请稍候再读取。';
        }
        if (!$gameMap || !$gamePlayer || !$gameSystem) {
            return '游戏尚未就绪，请稍候再读取。';
        }
        if ($gamePlayer.isTransferring && $gamePlayer.isTransferring()) {
            return '地图切换中不能读取。';
        }
        /*
        不再因为“有事件在跑”就拒绝读取：家园等枢纽场景往往有常驻的/并行/自动执行事件驱动交互 UI，isEventRunning() 
        长期为 true，会让玩家在安全地点永远无法读取。读取本身会用存档完整重建游戏状态，
        事件中途被打断不会损坏存档；真正会崩的“地图未就绪”已由上面的_spriteset / _mapNameWindow 判据兜住。
        只在“真正有对话正文在显示”时拦截。交互弹出的选项按钮在引擎里是Show Choices（$gameMessage.isChoice()），isBusy() 会把它算作忙碌，
        导致玩家点开交互按钮就读不了。hasText() 仅在有对话正文时为真，正好对应玩家说的“进入剧情演出”。
        */
        if ($gameMessage && $gameMessage.hasText && $gameMessage.hasText()) {
            return '对话或剧情演出中不能读取。';
        }
        if ($gameParty && $gameParty.inBattle && $gameParty.inBattle()) {
            return '战斗中不能读取。';
        }
        if ($gameTemp && $gameTemp._isInBattle) {
            return '战斗中不能读取。';
        }
        // 自定义确认框（rpg_custom 的 .dialog-overlay）打开时拒绝读取。
        if (typeof document !== 'undefined' && document.querySelector &&
            document.querySelector('.dialog-overlay')) {
            return '请先关闭当前确认框再读取。';
        }
        return '';
    };

    // 读取切换锁在 Scene_Load 真正启动后释放；切换失败或超时也会清理。
    AbyssQuickSave.onLoadSceneStarted = function() {
        if (!this.loadSwitchArmed) return;
        this.loadSwitchArmed = false;
        this.loadSwitchTimeout = 0;
        this.endOperation();
    };

    AbyssQuickSave.releaseLoadSwitchLock = function() {
        if (!this.loadSwitchArmed) return;
        this.loadSwitchArmed = false;
        this.loadSwitchTimeout = 0;
        this.openLoadAtSlot20 = false;
        this.endOperation();
    };

    AbyssQuickSave.quickLoad = function(fromManager) {
        if (this.operationBusy || this.pendingAction || this.loadSwitchArmed) {
            SoundManager.playBuzzer();
            this.toast('已有快速存档操作正在等待或执行。', '#ffb0b0');
            return false;
        }
        if (this.isDisabled()) {
            SoundManager.playBuzzer();
            this.toast('快速存档功能已停用。', '#ffb0b0');
            return false;
        }
        if (!this.exists(OFFICIAL_SLOT)) {
            SoundManager.playBuzzer();
            this.toast('官方第20号槽没有存档。', '#ffb0b0');
            return false;
        }
        /* 
         从地图快捷键读取时执行完整的地图安全检查；从管理界面打开读取时
         当前场景本就是菜单，允许直接切换到官方读取界面。
         */
        if (!fromManager) {
            var blockReason = this.mapLoadBlockReason();
            if (blockReason) {
                SoundManager.playBuzzer();
                this.toast(blockReason, '#ffb0b0');
                return false;
            }
        }

        if (!this.beginOperation('load')) return false;
        try {
            this.openLoadAtSlot20 = true;
            this.loadSwitchArmed = true;
            // 切换正常会在下一帧完成；留出足够帧数作为超时兜底。
            this.loadSwitchTimeout = 120;
            SceneManager.push(Scene_Load);
            // 锁保持到 Scene_Load.start 触发或超时，不在此处释放。
            return true;
        } catch (error) {
            this.loadSwitchArmed = false;
            this.loadSwitchTimeout = 0;
            this.openLoadAtSlot20 = false;
            this.endOperation();
            console.error(PLUGIN_NAME + ': unable to open load scene', error);
            SoundManager.playBuzzer();
            this.toast('无法打开官方读取界面。', '#ffb0b0');
            return false;
        }
    };

    AbyssQuickSave.deleteManagedSlot = function() {
        var transaction = this.beginManagedDeletion([OFFICIAL_SLOT]);
        if (!transaction.ok) return false;
        var removed = transaction.slots.length > 0;
        this.commitManagedDeletion(transaction);
        return removed;
    };

    AbyssQuickSave.clearQuickSave = function(disableFeature) {
        var wasDisabled = this.isDisabled();
        var transaction = this.beginManagedDeletion([OFFICIAL_SLOT]);
        if (!transaction.ok) return false;

        try {
            if (disableFeature) this.setDisabled(true);
            this.commitManagedDeletion(transaction);
            return true;
        } catch (error) {
            console.error(PLUGIN_NAME + ': unable to clear/disable quick save', error);
            this.rollbackManagedDeletion(transaction);
            try {
                this.setDisabled(wasDisabled);
            } catch (restoreError) {
                console.error(PLUGIN_NAME + ': unable to restore disabled state',
                    restoreError);
            }
            return false;
        }
    };

    AbyssQuickSave.disableConfirmationText = function() {
        return this.hasAnyManagedSave() ?
            '这会删除本插件创建的快速存档并停用快捷键。\n' +
                '其他普通存档及没有 Abyss 标记的旧插件槽位不会被删除。\n\n' +
                '确认继续吗？' :
            '这会停用快速存档快捷键。\n' +
                '没有检测到本插件创建的快速存档，因此不会删除普通存档。\n\n' +
                '确认继续吗？';
    };

    AbyssQuickSave.requestDisable = async function() {
        if (!this.beginOperation('disable')) return false;
        try {
            var confirmed = await this.confirmAction(
                this.disableConfirmationText(),
                {
                    title: '删除快存并停用',
                    confirmText: '确认停用',
                    cancelText: '取消'
                }
            );
            if (confirmed !== true) {
                SoundManager.playCancel();
                return false;
            }

            if (!this.clearQuickSave(true)) {
                SoundManager.playBuzzer();
                await this.alertAction(
                    '删除快速存档或更新停用状态失败，操作已取消并尝试恢复原数据。',
                    { title: '操作失败', confirmText: '关闭' }
                );
                return false;
            }

            SoundManager.playOk();
            this.toast('快速存档功能已停用。', '#ffd59d');
            return true;
        } finally {
            this.endOperation();
        }
    };

    AbyssQuickSave.enable = function() {
        if (this.operationBusy) {
            SoundManager.playBuzzer();
            return false;
        }
        try {
            this.setDisabled(false);
            this.toast('快速存档功能已重新启用。', '#b8ffbf');
            return true;
        } catch (error) {
            console.error(PLUGIN_NAME + ': unable to enable quick save', error);
            SoundManager.playBuzzer();
            this.toast('重新启用失败，请检查存档目录写入权限。', '#ffb0b0');
            return false;
        }
    };

    AbyssQuickSave.statusText = function() {
        var lines = [];
        lines.push('快捷键：Ctrl+Shift+S 保存　Ctrl+Shift+L 官方读取');
        lines.push('目标：官方第20号槽　状态：' + (this.isDisabled() ? '已停用' : '已启用'));
        lines.push('安全限制：战斗、敌人警戒/追击、附近有敌人、在家及剧情演出中禁止保存');
        lines.push('覆盖规则：每次保存均需确认；地面掉落物会显示额外警告');

        var info = this.slotInfo();
        if (info) {
            var mark = this.detectInfoMarker(info) ? '快速存档' : '普通存档';
            lines.push('第20号槽：' + mark + '　' + new Date(info.timestamp || 0).toLocaleString());
        } else {
            lines.push('第20号槽：空');
        }
        lines.push('迷宫读取请在官方界面确认第20号槽，不再使用强制原地读取。');
        return lines.join('\n');
    };

    AbyssQuickSave.toast = function(text, color) {
        var scene = SceneManager._scene;
        if (!scene || !scene.addChild || typeof Bitmap === 'undefined') return;
        if (scene._abyssQuickSaveToast) {
            scene.removeChild(scene._abyssQuickSaveToast);
            scene._abyssQuickSaveToast.destroy();
        }

        var width = Math.min(Graphics.boxWidth - 40, 900);
        var sprite = new Sprite(new Bitmap(width, 56));
        sprite.bitmap.fillRect(0, 0, width, 56, 'rgba(0,0,0,0.78)');
        sprite.bitmap.textColor = color || '#ffffff';
        sprite.bitmap.outlineColor = 'rgba(0,0,0,0.9)';
        sprite.bitmap.outlineWidth = 4;
        sprite.bitmap.fontSize = 24;
        sprite.bitmap.drawText(text, 12, 4, width - 24, 48, 'center');
        sprite.x = Math.floor((Graphics.boxWidth - width) / 2);
        sprite.y = 24;
        sprite._abyssDuration = 180;
        scene._abyssQuickSaveToast = sprite;
        scene.addChild(sprite);
    };

    AbyssQuickSave.updateToast = function(scene) {
        var sprite = scene && scene._abyssQuickSaveToast;
        if (!sprite) return;
        sprite._abyssDuration--;
        if (sprite._abyssDuration < 30) sprite.opacity = Math.max(0, sprite._abyssDuration * 8);
        if (sprite._abyssDuration <= 0) {
            scene.removeChild(sprite);
            sprite.destroy();
            scene._abyssQuickSaveToast = null;
        }
    };

    AbyssQuickSave.scheduleSaveFromMenu = function() {
        if (this.operationBusy || this.pendingAction) {
            SoundManager.playBuzzer();
            this.toast('已有快速存档操作正在等待或执行。', '#ffb0b0');
            return false;
        }
        this.pendingAction = 'save';
        this.pendingDelay = 20;
        this.pendingTimeout = 300;
        SceneManager.goto(Scene_Map);
        return true;
    };

    AbyssQuickSave.performPendingAction = function() {
        if (this.pendingAction !== 'save') return;
        if (this.pendingDelay > 0) {
            this.pendingDelay--;
            return;
        }

        if (this.canSaveNow()) {
            this.pendingTimeout--;
            if (this.pendingTimeout <= 0) {
                this.pendingAction = null;
                SoundManager.playBuzzer();
                this.toast('等待安全保存时机超时，请回到地图后使用快捷键。', '#ffb0b0');
            }
            return;
        }

        this.pendingAction = null;
        this.runAsync(this.quickSave(), 'pending quick save');
    };

    AbyssQuickSave.uninstallConfirmationText = function() {
        return '这会移除快速存档插件并关闭游戏。\n' +
            '本插件创建的快速存档也会删除；其他普通/官方存档不会被删除。' +
            '\n\n确认彻底卸载吗？';
    };

    AbyssQuickSave.uninstall = async function() {
        if (!this.beginOperation('uninstall')) return false;
        try {
            var confirmed = await this.confirmAction(
                this.uninstallConfirmationText(),
                {
                    title: '彻底卸载快速存档功能',
                    confirmText: '确认卸载',
                    cancelText: '取消'
                }
            );
            if (confirmed !== true) {
                SoundManager.playCancel();
                return false;
            }

            if (!StorageManager.isLocalMode()) {
                await this.alertAction(
                    '当前运行方式不支持自动卸载。',
                    { title: '无法卸载', confirmText: '关闭' }
                );
                return false;
            }

            var fs = require('fs');
            var path = require('path');
            var wwwDir = path.dirname(process.mainModule.filename);
            var pluginsPath = path.join(wwwDir, 'js', 'plugins.js');
            var pluginPath = path.join(
                wwwDir, 'js', 'plugins', 'Abyss_QuickSave.js'
            );
            var backupPath =
                pluginsPath + '.before_Abyss_QuickSave_uninstall';
            var pluginBackupPath = pluginPath + '.before_uninstall';
            var wasDisabled = this.isDisabled();
            var deletionTransaction = null;
            var configBackupCreated = false;
            var pluginBackupCreated = false;
            var operationSucceeded = false;
            var failure = null;

            try {
                var text = fs.readFileSync(pluginsPath, 'utf8');
                var entryPattern =
                    /,\s*\{"name":"Abyss_QuickSave","status":(?:true|false),"description":"[^"]*","parameters":\{\}\}/;
                if (!entryPattern.test(text)) {
                    throw new Error(
                        '在 plugins.js 中找不到快速存档插件登记项。'
                    );
                }
                var nextText = text.replace(entryPattern, '');

                fs.copyFileSync(pluginsPath, backupPath);
                configBackupCreated = true;
                if (fs.existsSync(pluginPath)) {
                    fs.copyFileSync(pluginPath, pluginBackupPath);
                    pluginBackupCreated = true;
                }

                deletionTransaction = this.beginManagedDeletion([OFFICIAL_SLOT]);
                if (!deletionTransaction.ok) {
                    throw deletionTransaction.error ||
                        new Error('无法安全删除快速存档。');
                }

                fs.writeFileSync(pluginsPath, nextText, 'utf8');
                this.setDisabled(false);
                if (fs.existsSync(pluginPath)) fs.unlinkSync(pluginPath);

                this.commitManagedDeletion(deletionTransaction);
                operationSucceeded = true;
                try {
                    if (pluginBackupCreated &&
                        fs.existsSync(pluginBackupPath)) {
                        fs.unlinkSync(pluginBackupPath);
                    }
                } catch (cleanupError) {
                    console.warn(PLUGIN_NAME +
                        ': unable to clean plugin uninstall backup',
                    cleanupError);
                }
            } catch (error) {
                failure = error;
                console.error(PLUGIN_NAME + ': uninstall failed', error);

                if (deletionTransaction && deletionTransaction.active) {
                    this.rollbackManagedDeletion(deletionTransaction);
                }
                try {
                    if (configBackupCreated && fs.existsSync(backupPath)) {
                        fs.copyFileSync(backupPath, pluginsPath);
                    }
                } catch (configRestoreError) {
                    console.error(PLUGIN_NAME +
                        ': unable to restore plugins.js', configRestoreError);
                }
                try {
                    if (pluginBackupCreated &&
                        fs.existsSync(pluginBackupPath)) {
                        fs.copyFileSync(pluginBackupPath, pluginPath);
                    }
                } catch (pluginRestoreError) {
                    console.error(PLUGIN_NAME +
                        ': unable to restore plugin file', pluginRestoreError);
                }
                try {
                    this.setDisabled(wasDisabled);
                } catch (disabledRestoreError) {
                    console.error(PLUGIN_NAME +
                        ': unable to restore disabled state',
                    disabledRestoreError);
                }
            }

            if (!operationSucceeded) {
                await this.alertAction(
                    '自动卸载失败：\n' +
                        (failure && failure.message ?
                            failure.message : '未知错误') +
                        '\n\n插件已尽量恢复，请不要继续删除文件；可重新启动游戏确认状态。',
                    { title: '卸载失败', confirmText: '关闭', width: 680 }
                );
                return false;
            }

            // 必须等玩家关闭成功提示，之后才退出游戏。
            await this.alertAction(
                '快速存档功能已卸载。\n' +
                    '游戏现在将关闭，请重新启动。\n\n插件配置备份：\n' +
                    backupPath,
                { title: '卸载完成', confirmText: '关闭', width: 720 }
            );
            if (window.nw && nw.App) nw.App.quit();
            else window.close();
            return true;
        } finally {
            this.endOperation();
        }
    };

    //-------------------------------------------------------------------------
    // 标准存档标记：存档本体保持官方格式，仅增加可忽略的标识字段。
    //-------------------------------------------------------------------------

    var _DataManager_makeSaveContents = DataManager.makeSaveContents;
    DataManager.makeSaveContents = function() {
        var contents = _DataManager_makeSaveContents.call(this);
        if (AbyssQuickSave.savingOfficialSlot) {
            contents._abyssQuickSave = {
                version: SAVE_VERSION,
                mapId: $gameMap.mapId(),
                abyss: AbyssQuickSave.isAbyssMap(),
                virtualButtonsVisible:
                    !!(window.QJ && QJ.VB && QJ.VB.controlVisible),
                timestamp: Date.now()
            };
        }
        return contents;
    };

    var _DataManager_makeSavefileInfo = DataManager.makeSavefileInfo;
    DataManager.makeSavefileInfo = function() {
        var info = _DataManager_makeSavefileInfo.call(this);
        if (AbyssQuickSave.savingOfficialSlot) {
            info.abyssQuickSave = true;
            info.abyssQuickSaveVersion = SAVE_VERSION;
            info.abyssQuickSaveAbyss = AbyssQuickSave.isAbyssMap();
        }
        return info;
    };

    var _DataManager_extractSaveContents = DataManager.extractSaveContents;
    DataManager.extractSaveContents = function(contents) {
        _DataManager_extractSaveContents.call(this, contents);
        var marker = AbyssQuickSave.detectContentsMarker(contents);
        AbyssQuickSave.loadedFromManagedSave =
            !!marker;
        AbyssQuickSave.managedLoadGraceFrames =
            AbyssQuickSave.loadedFromManagedSave ? 600 : 0;
        AbyssQuickSave.managedUiRepairPending =
            AbyssQuickSave.loadedFromManagedSave;
        AbyssQuickSave.managedUiRepairDelay =
            AbyssQuickSave.loadedFromManagedSave ? 30 : 0;
        AbyssQuickSave.managedUiRepairMapId =
            marker ? Number(marker.mapId || 0) : 0;
        AbyssQuickSave.managedVirtualButtonsVisible =
            marker && Object.prototype.hasOwnProperty.call(
                marker, 'virtualButtonsVisible'
            ) ? !!marker.virtualButtonsVisible : null;
        AbyssQuickSave.combatQuietFrames = 0;
        AbyssQuickSave.combatSafetyMapId = 0;
        AbyssQuickSave.preserveSpawnDataOnReload = false;
        if (AbyssQuickSave.loadedFromManagedSave) {
            AbyssQuickSave.restoreManagedVirtualButtons();
        }
    };

    var _DataManager_setupNewGame = DataManager.setupNewGame;
    DataManager.setupNewGame = function() {
        _DataManager_setupNewGame.apply(this, arguments);
        AbyssQuickSave.releaseLoadSwitchLock();
        AbyssQuickSave.loadedFromManagedSave = false;
        AbyssQuickSave.managedLoadGraceFrames = 0;
        AbyssQuickSave.managedUiRepairPending = false;
        AbyssQuickSave.managedUiRepairDelay = 0;
        AbyssQuickSave.managedUiRepairMapId = 0;
        AbyssQuickSave.managedVirtualButtonsVisible = null;
        AbyssQuickSave.combatQuietFrames = 0;
        AbyssQuickSave.combatSafetyMapId = 0;
        AbyssQuickSave.preserveSpawnDataOnReload = false;
    };

    //-------------------------------------------------------------------------
    // 修复游戏原有的“读档同步装备”缺陷。
    //
    // 原函数在 resetAttribute 分支中先卸下匹配装备，再刷新属性后直接
    // return，导致装备格永久变空；而且会覆盖随机属性。当前版本生成的
    // 快存不需要执行这段旧版本迁移，因此只对本插件存档跳过该分支。
    //-------------------------------------------------------------------------

    if (window.QJ && QJ.MPMZ && QJ.MPMZ.tl &&
        typeof QJ.MPMZ.tl._refreshEquipByBaseIds === 'function') {
        var _QJ_refreshEquipByBaseIds = QJ.MPMZ.tl._refreshEquipByBaseIds;
        QJ.MPMZ.tl._refreshEquipByBaseIds = function(kind, baseIds, opt) {
            opt = opt || {};
            if (opt.resetAttribute && AbyssQuickSave.loadedFromManagedSave) return;
            return _QJ_refreshEquipByBaseIds.apply(this, arguments);
        };
    }

    //-------------------------------------------------------------------------
    // 官方读取界面定位到界面显示的第20号槽（内部索引20）。
    //-------------------------------------------------------------------------

    var _Scene_Load_initialize = Scene_Load.prototype.initialize;
    Scene_Load.prototype.initialize = function() {
        _Scene_Load_initialize.apply(this, arguments);
        if (AbyssQuickSave.openLoadAtSlot20) {
            this._abyssQuickSaveStartIndex = OFFICIAL_SLOT - 1;
            AbyssQuickSave.openLoadAtSlot20 = false;
        }
    };

    // Scene_Load 真正启动后释放读取切换锁（连续按键期间只会切换一次）。
    var _Scene_Load_start = Scene_Load.prototype.start;
    Scene_Load.prototype.start = function() {
        _Scene_Load_start.apply(this, arguments);
        AbyssQuickSave.onLoadSceneStarted();
    };

    var _Scene_Load_firstSavefileIndex = Scene_Load.prototype.firstSavefileIndex;
    Scene_Load.prototype.firstSavefileIndex = function() {
        if (this._abyssQuickSaveStartIndex !== undefined) {
            return this._abyssQuickSaveStartIndex;
        }
        return _Scene_Load_firstSavefileIndex.call(this);
    };

    // 官方读取同一张地图时通常沿用存档内的 $gameMap，不会重跑地图事件。
    // 快存中又有意排除了 QJ 弹幕/UI，因此必须在官方读档成功阶段请求一次
    // 同地图重载，才能重建时间、任务、宝箱提示等界面对象。
    var _Scene_Load_onLoadSuccess = Scene_Load.prototype.onLoadSuccess;
    Scene_Load.prototype.onLoadSuccess = function() {
        if (AbyssQuickSave.loadedFromManagedSave && $gameMap && $gamePlayer) {
            var mapId = $gameMap.mapId();
            var x = $gamePlayer.x;
            var y = $gamePlayer.y;
            var direction = $gamePlayer.direction();
            // QJ-SpawnEvent 会在任何地图转移前重新生成动态事件存档。
            // 快存读取的同地图强制重载必须沿用文件内已经保存的掉落物数据，
            // 否则此时不可见的掉落物会把旧备份覆盖成空列表。
            AbyssQuickSave.preserveSpawnDataOnReload = true;
            $gamePlayer.reserveTransfer(mapId, x, y, direction, 0);
            $gamePlayer.requestMapReload();
            if ($gameTemp) $gameTemp._drill_GSM_isInLoadScene = true;
        }
        _Scene_Load_onLoadSuccess.apply(this, arguments);
    };

    if (Game_Map.prototype.saveSpawnEventDataQJ) {
        var _Game_Map_saveSpawnEventDataQJ =
            Game_Map.prototype.saveSpawnEventDataQJ;
        Game_Map.prototype.saveSpawnEventDataQJ = function() {
            if (AbyssQuickSave.preserveSpawnDataOnReload &&
                $gamePlayer && $gamePlayer.isTransferring &&
                $gamePlayer.isTransferring() &&
                Number($gamePlayer._newMapId || 0) === this.mapId() &&
                $gamePlayer._needsMapReload) {
                return;
            }
            return _Game_Map_saveSpawnEventDataQJ.apply(this, arguments);
        };
    }

    var _Game_Player_performTransfer = Game_Player.prototype.performTransfer;
    Game_Player.prototype.performTransfer = function() {
        var preserve = AbyssQuickSave.preserveSpawnDataOnReload;
        try {
            return _Game_Player_performTransfer.apply(this, arguments);
        } finally {
            if (preserve) {
                AbyssQuickSave.preserveSpawnDataOnReload = false;
            }
        }
    };

    //-------------------------------------------------------------------------
    // 管理界面
    //-------------------------------------------------------------------------

    function Window_AbyssQuickSaveCommand() {
        this.initialize.apply(this, arguments);
    }

    Window_AbyssQuickSaveCommand.prototype = Object.create(Window_Command.prototype);
    Window_AbyssQuickSaveCommand.prototype.constructor = Window_AbyssQuickSaveCommand;
    Window_AbyssQuickSaveCommand.prototype.initialize = function(x, y) {
        Window_Command.prototype.initialize.call(this, x, y);
    };
    Window_AbyssQuickSaveCommand.prototype.windowWidth = function() {
        return 560;
    };
    Window_AbyssQuickSaveCommand.prototype.numVisibleRows = function() {
        return this.maxItems();
    };
    Window_AbyssQuickSaveCommand.prototype.makeCommandList = function() {
        var disabled = AbyssQuickSave.isDisabled();
        if (!disabled) {
            this.addCommand('快速保存到第20号槽', 'quickSave');
            this.addCommand('官方读取第20号槽', 'quickLoad', AbyssQuickSave.exists(OFFICIAL_SLOT));
            this.addCommand('删除快存并停用功能', 'disable');
        } else {
            this.addCommand('重新启用快速存档', 'enable');
        }
        this.addCommand('彻底卸载快速存档功能', 'uninstall');
        this.addCommand('返回', 'cancel');
    };

    function Scene_AbyssQuickSaveManager() {
        this.initialize.apply(this, arguments);
    }

    Scene_AbyssQuickSaveManager.prototype = Object.create(Scene_MenuBase.prototype);
    Scene_AbyssQuickSaveManager.prototype.constructor = Scene_AbyssQuickSaveManager;
    Scene_AbyssQuickSaveManager.prototype.initialize = function() {
        Scene_MenuBase.prototype.initialize.call(this);
    };
    Scene_AbyssQuickSaveManager.prototype.create = function() {
        Scene_MenuBase.prototype.create.call(this);
        this.createHelpWindow();
        this.createCommandWindow();
        this.refreshHelp();
    };
    Scene_AbyssQuickSaveManager.prototype.createHelpWindow = function() {
        this._helpWindow = new Window_Help(6);
        this.addWindow(this._helpWindow);
    };
    Scene_AbyssQuickSaveManager.prototype.createCommandWindow = function() {
        this._commandWindow = new Window_AbyssQuickSaveCommand(0, 0);
        this._commandWindow.x = Math.floor((Graphics.boxWidth - this._commandWindow.width) / 2);
        this._commandWindow.y = this._helpWindow.height + 32;
        this._commandWindow.setHandler('quickSave', this.commandQuickSave.bind(this));
        this._commandWindow.setHandler('quickLoad', this.commandQuickLoad.bind(this));
        this._commandWindow.setHandler('disable', this.commandDisable.bind(this));
        this._commandWindow.setHandler('enable', this.commandEnable.bind(this));
        this._commandWindow.setHandler('uninstall', this.commandUninstall.bind(this));
        this._commandWindow.setHandler('cancel', this.popScene.bind(this));
        this.addWindow(this._commandWindow);
    };
    Scene_AbyssQuickSaveManager.prototype.refreshHelp = function() {
        this._helpWindow.setText(AbyssQuickSave.statusText());
    };
    Scene_AbyssQuickSaveManager.prototype.refreshCommands = function() {
        this._commandWindow.refresh();
        this._commandWindow.select(0);
        this._commandWindow.activate();
        this.refreshHelp();
    };
    Scene_AbyssQuickSaveManager.prototype.commandQuickSave = function() {
        if (!AbyssQuickSave.scheduleSaveFromMenu()) {
            this._commandWindow.activate();
        }
    };
    Scene_AbyssQuickSaveManager.prototype.commandQuickLoad = function() {
        // 从管理界面打开读取：当前不在地图，允许直接切换。
        if (!AbyssQuickSave.quickLoad(true)) {
            this._commandWindow.activate();
        }
    };
    Scene_AbyssQuickSaveManager.prototype.commandDisable = function() {
        var scene = this;
        this._commandWindow.deactivate();
        AbyssQuickSave.runAsync(
            AbyssQuickSave.requestDisable().then(function(success) {
                if (success) scene.refreshCommands();
                else scene._commandWindow.activate();
            }),
            'menu disable'
        );
    };
    Scene_AbyssQuickSaveManager.prototype.commandEnable = function() {
        if (AbyssQuickSave.enable()) {
            SoundManager.playOk();
            this.refreshCommands();
        } else {
            this._commandWindow.activate();
        }
    };
    Scene_AbyssQuickSaveManager.prototype.commandUninstall = function() {
        var scene = this;
        this._commandWindow.deactivate();
        AbyssQuickSave.runAsync(
            AbyssQuickSave.uninstall().then(function(success) {
                if (!success) scene._commandWindow.activate();
            }),
            'menu uninstall'
        );
    };

    window.Window_AbyssQuickSaveCommand = Window_AbyssQuickSaveCommand;
    window.Scene_AbyssQuickSaveManager = Scene_AbyssQuickSaveManager;

    var _Window_MenuCommand_addOriginalCommands = Window_MenuCommand.prototype.addOriginalCommands;
    Window_MenuCommand.prototype.addOriginalCommands = function() {
        _Window_MenuCommand_addOriginalCommands.call(this);
        var name = AbyssQuickSave.isDisabled() ?
            '快速存档管理（已停用）' : '快速存档管理';
        this.addCommand(name, 'abyssQuickSaveManager', true);
    };

    var _Scene_Menu_createCommandWindow = Scene_Menu.prototype.createCommandWindow;
    Scene_Menu.prototype.createCommandWindow = function() {
        _Scene_Menu_createCommandWindow.call(this);
        this._commandWindow.setHandler(
            'abyssQuickSaveManager',
            this.commandAbyssQuickSaveManager.bind(this)
        );
    };
    Scene_Menu.prototype.commandAbyssQuickSaveManager = function() {
        SceneManager.push(Scene_AbyssQuickSaveManager);
    };

    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        AbyssQuickSave.updateToast(this);
        AbyssQuickSave.updateCombatSafety();
        AbyssQuickSave.performPendingAction();
        // 兜底：若切换未能进入 Scene_Load（仍停留在地图），超时释放锁。
        if (AbyssQuickSave.loadSwitchArmed) {
            AbyssQuickSave.loadSwitchTimeout--;
            if (AbyssQuickSave.loadSwitchTimeout <= 0) {
                AbyssQuickSave.releaseLoadSwitchLock();
            }
        }
        if (AbyssQuickSave.managedUiRepairPending) {
            if (AbyssQuickSave.managedUiRepairDelay > 0) {
                AbyssQuickSave.managedUiRepairDelay--;
            } else if (AbyssQuickSave.repairManagedMapUi()) {
                AbyssQuickSave.managedUiRepairPending = false;
            }
        }
        if (AbyssQuickSave.managedLoadGraceFrames > 0) {
            AbyssQuickSave.managedLoadGraceFrames--;
            if (AbyssQuickSave.managedLoadGraceFrames <= 0) {
                AbyssQuickSave.loadedFromManagedSave = false;
                AbyssQuickSave.managedUiRepairPending = false;
            }
        }
    };

    window.addEventListener('keydown', function(event) {
        if (event.repeat || !event.ctrlKey || !event.shiftKey) return;

        var key = String(event.key || '').toLowerCase();
        if (!key && event.keyCode === 83) key = 's';
        if (!key && event.keyCode === 76) key = 'l';
        if (!key && event.keyCode === 46) key = 'delete';

        var action = '';
        if (key === 's') action = 'save';
        if (key === 'l') action = 'load';
        if (key === 'delete') action = 'disable';
        if (!action) return;

        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();

        if (AbyssQuickSave.isDisabled()) {
            SoundManager.playBuzzer();
            AbyssQuickSave.toast('快速存档功能已停用。', '#ffb0b0');
            return;
        }
        if (!(SceneManager._scene instanceof Scene_Map)) {
            SoundManager.playBuzzer();
            return;
        }

        if (action === 'save') {
            AbyssQuickSave.runAsync(
                AbyssQuickSave.quickSave(),
                'shortcut quick save'
            );
        } else if (action === 'load') {
            AbyssQuickSave.quickLoad();
        } else {
            AbyssQuickSave.runAsync(
                AbyssQuickSave.requestDisable(),
                'shortcut disable'
            );
        }
    }, true);
})();
