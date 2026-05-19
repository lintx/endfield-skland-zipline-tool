// ==UserScript==
// @name         终末地森空岛地图工具滑索加强
// @namespace    http://tampermonkey.net/
// @version      2026-05-18
// @description  导入、管理终末地在森空岛上的自定义滑索.
// @author       LinTx
// @match        https://game.skland.com/map/endfield*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=skland.com
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const IMPORT_KEYS_KEY = 'import-zipline-keys';
    const IMPORT_KEY_PREFIX = 'import-zipline-';
    const MY_ZIPLINE_KEY = 'my-zipline';
    const LINE_TEMPLATE_ID = '65863e646fa58f7a3154be46774a9144';
    const LOCAL_ZIPLINE_TEMPLATE_IDS = new Set([
        '0f45150a59b97bd0de9a4eed7a0fbf23',
        '5d53bdb714ba42c1e1a1b748b55b686f'
    ]);
    const INDUSTRIAL_TYPE_NAME = '工业设施';
    const DEFAULT_POINT_PIC = 'https://bbs.hycdn.cn/image/2026/01/19/78170df3542fad3569e2fe813a45efbc.png';
    const DEFAULT_SUBTYPE_PIC = 'https://bbs.hycdn.cn/image/2026/01/19/49aa54dcf3938607211baad01b808f8b.png';

    const pos = { x: null, y: null, z: null };
    let posSwitchDom = null;
    let activeMapId = 'map01';
    let activeDetailRecord = null;
    let activeDetailPositionDom = null;
    let modalZIndex = 999999;
    let importConfigs = [];
    let myConfig = null;
    const myZiplines = [];
    const importZiplines = [];
    const localZiplines = [];
    const ziplineById = new Map();
    const localZiplineRecords = new Map();
    const configRuntime = new Map();
    const dom = {};

    const originalFetch = window.fetch;

    function makeUuid() {
        return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, function () {
            return Math.floor(Math.random() * 16).toString(16);
        });
    }

    function makeUniqueZiplineId() {
        let id = makeUuid();
        while (ziplineById.has(id)) {
            id = makeUuid();
        }
        return id;
    }

    function ensureConfigId(config, usedIds, preferredId) {
        const oldId = config.id;
        let id = isUuid(preferredId) ? preferredId : isUuid(config.id) ? config.id : makeUuid();
        while (usedIds && usedIds.has(id)) {
            id = makeUuid();
        }
        config.id = id;
        if (usedIds) {
            usedIds.add(id);
        }
        return oldId !== config.id;
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
    }

    function safeJsonParse(text, fallback) {
        try {
            return JSON.parse(text);
        } catch (err) {
            return fallback;
        }
    }

    function alertFormatError() {
        alert('数据格式错误，请检查是否缺漏或联系滑索整理者');
    }

    function getImportKeys() {
        const keys = safeJsonParse(localStorage.getItem(IMPORT_KEYS_KEY), []);
        if (!Array.isArray(keys)) {
            return [];
        }
        return keys.filter(key => typeof key === 'string' && key.startsWith(IMPORT_KEY_PREFIX));
    }

    function setImportKeys(keys) {
        const uniqueKeys = Array.from(new Set(keys.filter(key => typeof key === 'string' && key.startsWith(IMPORT_KEY_PREFIX))));
        localStorage.setItem(IMPORT_KEYS_KEY, JSON.stringify(uniqueKeys));
    }

    function getDefaultMyConfig() {
        return {
            id: makeUuid(),
            url: '',
            author: '',
            name: '我的滑索',
            desc: '',
            list: {
                map01: [],
                map02: []
            }
        };
    }

    function readConfigFromStorage(key) {
        const value = localStorage.getItem(key);
        if (!value) {
            return null;
        }
        const parsed = safeJsonParse(value, null);
        if (!validateZiplineConfig(parsed)) {
            return null;
        }
        return parsed;
    }

    function saveConfigToStorage(key, config) {
        localStorage.setItem(key, JSON.stringify(config));
    }

    function loadAllConfigs() {
        importConfigs = [];
        const usedConfigIds = new Set();
        for (const key of getImportKeys()) {
            const config = readConfigFromStorage(key);
            if (config) {
                if (ensureConfigId(config, usedConfigIds)) {
                    saveConfigToStorage(key, config);
                }
                importConfigs.push({ key, config });
            }
        }

        myConfig = readConfigFromStorage(MY_ZIPLINE_KEY);
        if (!myConfig) {
            myConfig = getDefaultMyConfig();
            ensureConfigId(myConfig, usedConfigIds);
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        } else if (ensureConfigId(myConfig, usedConfigIds)) {
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        }

        if (normalizeMyZiplineIds()) {
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        }

        rebuildRuntimeMaps();
    }

    function normalizeMyZiplineIds() {
        if (!myConfig) {
            return false;
        }

        const reservedIds = new Set();
        for (const entry of importConfigs) {
            for (const { item } of getAllItems(entry.config)) {
                reservedIds.add(item.id);
            }
        }

        const myItems = getAllItems(myConfig);
        const seenMyIds = new Set();
        const idMap = new Map();
        let changed = false;

        for (const { item } of myItems) {
            if (!isUuid(item.id) || reservedIds.has(item.id) || seenMyIds.has(item.id)) {
                const oldId = item.id;
                let nextId = makeUuid();
                while (reservedIds.has(nextId) || seenMyIds.has(nextId)) {
                    nextId = makeUuid();
                }
                item.id = nextId;
                idMap.set(oldId, nextId);
                changed = true;
            }
            seenMyIds.add(item.id);
        }

        if (idMap.size > 0) {
            for (const { item } of myItems) {
                item.connect = item.connect.map(id => idMap.get(id) || id);
            }
        }

        return changed;
    }

    function validateZiplineConfig(config) {
        if (!isPlainObject(config)) {
            return false;
        }
        for (const key of ['url', 'author', 'name', 'desc']) {
            if (!Object.prototype.hasOwnProperty.call(config, key) || typeof config[key] !== 'string') {
                return false;
            }
        }
        if (!Object.prototype.hasOwnProperty.call(config, 'list') || !isPlainObject(config.list)) {
            return false;
        }

        const mapKeys = Object.keys(config.list);
        if (mapKeys.length === 0 || mapKeys.some(key => key !== 'map01' && key !== 'map02')) {
            return false;
        }
        if (!mapKeys.includes('map01') && !mapKeys.includes('map02')) {
            return false;
        }

        const globalIds = new Set();
        for (const mapId of mapKeys) {
            const items = config.list[mapId];
            if (!Array.isArray(items)) {
                return false;
            }

            const mapIds = new Set();
            for (const item of items) {
                if (!isPlainObject(item)) {
                    return false;
                }
                for (const key of ['id', 'name', 'pos', 'desc', 'connect']) {
                    if (!Object.prototype.hasOwnProperty.call(item, key)) {
                        return false;
                    }
                }
                if (!isUuid(item.id) || globalIds.has(item.id)) {
                    return false;
                }
                if (typeof item.name !== 'string' || typeof item.desc !== 'string') {
                    return false;
                }
                if (!isPlainObject(item.pos) || !Number.isInteger(item.pos.x) || !Number.isInteger(item.pos.y) || !Number.isInteger(item.pos.z)) {
                    return false;
                }
                if (!Array.isArray(item.connect) || item.connect.some(id => !isUuid(id))) {
                    return false;
                }
                globalIds.add(item.id);
                mapIds.add(item.id);
            }

            for (const item of items) {
                for (const connectId of item.connect) {
                    if (!mapIds.has(connectId)) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    function parseInputAsUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (err) {
            return false;
        }
    }

    async function readConfigText(inputValue) {
        const value = inputValue.trim();
        if (!value) {
            throw new Error('empty');
        }
        if (!parseInputAsUrl(value)) {
            return value;
        }
        const response = await originalFetch(value, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error('download failed');
        }
        return response.text();
    }

    async function loadConfigFromTextOrUrl(inputValue) {
        const text = await readConfigText(inputValue);
        const parsed = safeJsonParse(text, null);
        if (!validateZiplineConfig(parsed)) {
            throw new Error('invalid config');
        }
        ensureConfigId(parsed);
        return parsed;
    }

    function getItems(config, mapId) {
        if (!config || !config.list || !Array.isArray(config.list[mapId])) {
            return [];
        }
        return config.list[mapId];
    }

    function getAllItems(config) {
        return ['map01', 'map02'].flatMap(mapId => getItems(config, mapId).map(item => ({ mapId, item })));
    }

    function makeJsonResponse(response, data) {
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers
        });
    }

    function ensureMapList(config, mapId) {
        if (!isPlainObject(config.list)) {
            config.list = {};
        }
        if (!Array.isArray(config.list[mapId])) {
            config.list[mapId] = [];
        }
        return config.list[mapId];
    }

    function rebuildRuntimeMaps() {
        myZiplines.length = 0;
        importZiplines.length = 0;
        localZiplines.length = 0;
        ziplineById.clear();
        configRuntime.clear();

        for (const entry of importConfigs) {
            configRuntime.set(entry.key, {
                key: entry.key,
                source: 'import',
                config: entry.config,
                subTypeId: entry.config.id
            });
            for (const { mapId, item } of getAllItems(entry.config)) {
                importZiplines.push(item.id);
                ziplineById.set(item.id, {
                    id: item.id,
                    source: 'import',
                    configKey: entry.key,
                    config: entry.config,
                    mapId,
                    item
                });
            }
        }

        configRuntime.set(MY_ZIPLINE_KEY, {
            key: MY_ZIPLINE_KEY,
            source: 'my',
            config: myConfig,
            subTypeId: myConfig.id
        });
        for (const { mapId, item } of getAllItems(myConfig)) {
            myZiplines.push(item.id);
            ziplineById.set(item.id, {
                id: item.id,
                source: 'my',
                configKey: MY_ZIPLINE_KEY,
                config: myConfig,
                mapId,
                item
            });
        }

        for (const record of localZiplineRecords.values()) {
            localZiplines.push(record.id);
            ziplineById.set(record.id, record);
        }
    }

    function rememberLocalZipline(mark) {
        if (!mark || !mark.id || localZiplineRecords.has(mark.id)) {
            return;
        }
        const record = {
            id: mark.id,
            source: 'local',
            configKey: '',
            config: null,
            mapId: mark.mapId || activeMapId,
            item: {
                id: mark.id,
                name: mark.name || mark.title || '本地滑索',
                pos: mark.pos,
                desc: '',
                connect: []
            }
        };
        localZiplineRecords.set(mark.id, record);
        localZiplines.push(mark.id);
        ziplineById.set(mark.id, record);
    }

    function makeSubType(runtime) {
        return {
            id: runtime.subTypeId,
            name: runtime.config.name,
            pic: DEFAULT_SUBTYPE_PIC,
            tagIds: [],
            templateIds: [runtime.subTypeId],
            isAlwaysShow: false,
            relatedSubTypeIds: []
        };
    }

    function makeMarkTemplate(runtime) {
        return {
            id: runtime.subTypeId,
            name: runtime.config.name,
            pic: DEFAULT_POINT_PIC,
            desc: runtime.config.desc,
            triggerDistance: 0
        };
    }

    function makePointMark(item, mapId, templateId) {
        return {
            id: item.id,
            templateId,
            pos: {
                x: item.pos.x,
                y: item.pos.y,
                z: item.pos.z
            },
            isUserMarked: false,
            fromMark: null,
            toMark: null,
            mapId,
            levelId: '',
            regionId: 0,
            isObtained: false,
            isAlwaysShow: false,
            targetRegionId: 0,
            tierIndex: 0
        };
    }

    function makeLineMark(fromItem, toItem, mapId) {
        return {
            id: makeUuid(),
            templateId: LINE_TEMPLATE_ID,
            pos: null,
            isUserMarked: false,
            fromMark: {
                markId: fromItem.id,
                pos: {
                    x: fromItem.pos.x,
                    y: fromItem.pos.y,
                    z: fromItem.pos.z
                }
            },
            toMark: {
                markId: toItem.id,
                pos: {
                    x: toItem.pos.x,
                    y: toItem.pos.y,
                    z: toItem.pos.z
                }
            },
            mapId,
            levelId: '',
            regionId: 0,
            isObtained: false,
            isAlwaysShow: false,
            targetRegionId: 0,
            tierIndex: 0
        };
    }

    function buildConfigMarks(runtime, mapId) {
        const marks = [];
        const items = getItems(runtime.config, mapId);
        const itemById = new Map(items.map(item => [item.id, item]));
        const lineKeys = new Set();

        for (const item of items) {
            marks.push(makePointMark(item, mapId, runtime.subTypeId));
        }

        for (const item of items) {
            for (const connectId of item.connect) {
                const target = itemById.get(connectId);
                if (!target) {
                    continue;
                }
                const key = [item.id, target.id].sort().join(':');
                if (lineKeys.has(key)) {
                    continue;
                }
                lineKeys.add(key);
                marks.push(makeLineMark(item, target, mapId));
            }
        }

        return marks;
    }

    function extractMapIdFromUrl(url) {
        const match = String(url).match(/[?&]mapId=(map0[12])\b/);
        return match ? match[1] : 'map01';
    }

    function injectCatalog(data) {
        if (!isPlainObject(data) || !isPlainObject(data.data) || !Array.isArray(data.data.mainTypes)) {
            return data;
        }
        for (const types of data.data.mainTypes) {
            if (isPlainObject(types) && types.name === INDUSTRIAL_TYPE_NAME && Array.isArray(types.subTypes)) {
                for (const runtime of configRuntime.values()) {
                    types.subTypes.push(makeSubType(runtime));
                }
            }
        }
        return data;
    }

    function injectMarkList(data, mapId) {
        if (!isPlainObject(data) || !isPlainObject(data.data) || !Array.isArray(data.data.saveMarks)) {
            return data;
        }

        activeMapId = mapId;
        data.modified = true;

        for (const mark of data.data.saveMarks) {
            if (mark && LOCAL_ZIPLINE_TEMPLATE_IDS.has(mark.templateId) && mark.pos) {
                rememberLocalZipline(mark);
            }
        }

        if (Array.isArray(data.data.markTemplates)) {
            const templateIds = new Set(data.data.markTemplates.map(template => template.id));
            for (const runtime of configRuntime.values()) {
                if (!templateIds.has(runtime.subTypeId)) {
                    data.data.markTemplates.push(makeMarkTemplate(runtime));
                    templateIds.add(runtime.subTypeId);
                }
            }
        }

        for (const runtime of configRuntime.values()) {
            for (const mark of buildConfigMarks(runtime, mapId)) {
                data.data.saveMarks.push(mark);
            }
        }

        return data;
    }

    window.fetch = async function (url, options) {
        const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url && url.url ? url.url : String(url || '');
        const response = await originalFetch.apply(this, arguments);

        if (requestUrl.includes('zonai.skland.com/web/v1/game/endfield/map/catalog')) {
            try {
                loadAllConfigs();
                const data = await response.clone().json();
                return makeJsonResponse(response, injectCatalog(data));
            } catch (err) {
                return response;
            }
        }

        if (requestUrl.includes('zonai.skland.com/web/v1/game/endfield/map/mark/list')) {
            try {
                loadAllConfigs();
                const mapId = extractMapIdFromUrl(requestUrl);
                const data = await response.clone().json();
                return makeJsonResponse(response, injectMarkList(data, mapId));
            } catch (err) {
                return response;
            }
        }

        return response;
    };

    const originalAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, listener, options) {
        if (type === 'message' && this.url.includes('ws.skland.com/ws/v1/game/endfield/map')) {
            Reflect.apply(originalAddEventListener, this, [type, ev => {
                const data = safeJsonParse(ev.data, null);
                if (isPlainObject(data) && data.type === 1012 && isPlainObject(data.data) && isPlainObject(data.data.pos)) {
                    const x = Math.floor(data.data.pos.x);
                    const y = Math.floor(data.data.pos.y);
                    const z = Math.floor(data.data.pos.z);
                    if (pos.x !== x || pos.y !== y || pos.z !== z) {
                        pos.x = x;
                        pos.y = y;
                        pos.z = z;
                        if (posSwitchDom !== null) {
                            posSwitchDom.innerText = `${data.data.pos.x},${data.data.pos.y},${data.data.pos.z}`;
                        }
                        updateActiveDetailPosition();
                    }
                }
            }, options]);
        }
        return Reflect.apply(originalAddEventListener, this, [type, listener, options]);
    };

    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
            .zipline-tool-mask {
                position: fixed;
                inset: 0;
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, .45);
                color: #e8eef7;
                font-size: 14px;
            }
            .zipline-tool-hidden {
                display: none !important;
            }
            .zipline-tool-panel {
                width: min(760px, calc(100vw - 32px));
                max-height: calc(100vh - 48px);
                overflow: auto;
                background: #17202b;
                border: 1px solid rgba(255, 255, 255, .18);
                border-radius: 8px;
                box-shadow: 0 16px 48px rgba(0, 0, 0, .42);
                padding: 16px;
            }
            .zipline-tool-panel h2 {
                margin: 0 0 12px;
                font-size: 18px;
                font-weight: 600;
            }
            .zipline-tool-panel h3 {
                margin: 16px 0 8px;
                font-size: 15px;
                font-weight: 600;
            }
            .zipline-tool-panel textarea,
            .zipline-tool-panel input {
                box-sizing: border-box;
                width: 100%;
                border: 1px solid rgba(255, 255, 255, .22);
                border-radius: 6px;
                background: #0e151d;
                color: #e8eef7;
                padding: 8px 10px;
                outline: none;
            }
            .zipline-tool-panel textarea {
                min-height: 220px;
                resize: vertical;
                font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            }
            .zipline-tool-row {
                display: flex;
                gap: 8px;
                align-items: center;
                margin-top: 10px;
            }
            .zipline-tool-row > * {
                flex: 1;
            }
            .zipline-tool-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                justify-content: flex-end;
                margin-top: 12px;
            }
            .zipline-tool-panel button {
                border: 1px solid rgba(255, 255, 255, .22);
                border-radius: 6px;
                background: #24364a;
                color: #e8eef7;
                padding: 7px 12px;
                cursor: pointer;
            }
            .zipline-tool-panel button:hover {
                background: #30475f;
            }
            .zipline-tool-list {
                display: grid;
                gap: 10px;
            }
            .zipline-tool-card {
                border: 1px solid rgba(255, 255, 255, .16);
                border-radius: 8px;
                padding: 10px;
                background: #111a24;
            }
            .zipline-tool-title {
                font-weight: 600;
                margin-bottom: 4px;
            }
            .zipline-tool-muted {
                color: #aab8c8;
                font-size: 13px;
                line-height: 1.5;
            }
            .zipline-tool-danger {
                background: #5b2630 !important;
            }
            .zipline-tool-connected {
                color: #67d391;
            }
        `;
        document.head.appendChild(style);
    }

    function createMask(title) {
        const mask = document.createElement('div');
        mask.className = 'zipline-tool-mask zipline-tool-hidden';
        const panel = document.createElement('div');
        panel.className = 'zipline-tool-panel';
        const h2 = document.createElement('h2');
        h2.innerText = title;
        panel.appendChild(h2);
        mask.appendChild(panel);
        document.body.appendChild(mask);
        return { mask, panel };
    }

    function showMask(mask) {
        modalZIndex += 1;
        mask.style.zIndex = `${modalZIndex}`;
        mask.classList.remove('zipline-tool-hidden');
    }

    function hideMask(mask) {
        mask.classList.add('zipline-tool-hidden');
    }

    function clearNode(node) {
        while (node.firstChild) {
            node.removeChild(node.firstChild);
        }
    }

    function appendButton(parent, text, handler, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.innerText = text;
        if (className) {
            button.className = className;
        }
        button.addEventListener('click', handler);
        parent.appendChild(button);
        return button;
    }

    function appendInfo(parent, label, value) {
        const div = document.createElement('div');
        div.className = 'zipline-tool-muted';
        div.innerText = `${label}：${value || ''}`;
        parent.appendChild(div);
        return div;
    }

    function createImportPanel() {
        const created = createMask('导入滑索');
        dom.importMask = created.mask;
        dom.importPanel = created.panel;

        const textarea = document.createElement('textarea');
        textarea.placeholder = '请输入 JSON 文本或 URL';
        created.panel.appendChild(textarea);
        dom.importTextarea = textarea;

        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        created.panel.appendChild(actions);

        appendButton(actions, '取消', () => hideMask(created.mask));
        appendButton(actions, '确定导入', async () => {
            try {
                const config = await loadConfigFromTextOrUrl(textarea.value);
                ensureConfigId(config);
                const key = `${IMPORT_KEY_PREFIX}${makeUuid()}`;
                saveConfigToStorage(key, config);
                setImportKeys(getImportKeys().concat(key));
                loadAllConfigs();
                textarea.value = '';
                alert('导入成功，刷新页面后可以查看');
            } catch (err) {
                alertFormatError();
            }
        });
    }

    function createManagerPanel() {
        const created = createMask('滑索管理');
        dom.managerMask = created.mask;
        dom.managerPanel = created.panel;
        dom.managerContent = document.createElement('div');
        created.panel.appendChild(dom.managerContent);
    }

    function openManagerPanel() {
        renderManagerPanel();
        showMask(dom.managerMask);
    }

    function renderManagerPanel() {
        loadAllConfigs();
        clearNode(dom.managerContent);

        const topActions = document.createElement('div');
        topActions.className = 'zipline-tool-actions';
        dom.managerContent.appendChild(topActions);
        appendButton(topActions, '导入滑索', () => showMask(dom.importMask));

        const importTitle = document.createElement('h3');
        importTitle.innerText = '已导入滑索';
        dom.managerContent.appendChild(importTitle);

        const importList = document.createElement('div');
        importList.className = 'zipline-tool-list';
        dom.managerContent.appendChild(importList);

        if (importConfigs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'zipline-tool-muted';
            empty.innerText = '暂无导入配置';
            importList.appendChild(empty);
        }

        for (const entry of importConfigs) {
            importList.appendChild(renderImportConfigCard(entry));
        }

        const myTitle = document.createElement('h3');
        myTitle.innerText = '我的滑索';
        dom.managerContent.appendChild(myTitle);
        dom.managerContent.appendChild(renderMyConfigEditor());

        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        dom.managerContent.appendChild(actions);
        appendButton(actions, '关闭', () => hideMask(dom.managerMask));
    }

    function renderImportConfigCard(entry) {
        const card = document.createElement('div');
        card.className = 'zipline-tool-card';
        const config = entry.config;
        const pointCount = getAllItems(config).length;

        const title = document.createElement('div');
        title.className = 'zipline-tool-title';
        title.innerText = config.name;
        card.appendChild(title);
        appendInfo(card, '作者', config.author);
        appendInfo(card, '简介', config.desc);
        appendInfo(card, '数量', `${pointCount}`);

        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        card.appendChild(actions);

        if (config.url.trim()) {
            appendButton(actions, '更新', async () => {
                try {
                    const nextConfig = await loadConfigFromTextOrUrl(config.url);
                    ensureConfigId(nextConfig, null, config.id);
                    saveConfigToStorage(entry.key, nextConfig);
                    loadAllConfigs();
                    renderManagerPanel();
                    alert('导入成功，刷新页面后可以查看');
                } catch (err) {
                    alertFormatError();
                }
            });
        }

        appendButton(actions, '显示JSON', () => {
            openExportText(config);
        });
        appendButton(actions, '下载JSON', () => {
            downloadJson(`${config.name || 'zipline'}.json`, config);
        });
        appendButton(actions, '删除', () => {
            if (!confirm(`确定删除“${config.name}”吗？`)) {
                return;
            }
            localStorage.removeItem(entry.key);
            setImportKeys(getImportKeys().filter(key => key !== entry.key));
            loadAllConfigs();
            renderManagerPanel();
        }, 'zipline-tool-danger');

        return card;
    }

    function renderMyConfigEditor() {
        const card = document.createElement('div');
        card.className = 'zipline-tool-card';
        const fields = {};

        for (const key of ['url', 'author', 'name', 'desc']) {
            const row = document.createElement('div');
            row.className = 'zipline-tool-row';
            const input = document.createElement('input');
            input.value = myConfig[key] || '';
            input.placeholder = key;
            row.appendChild(input);
            fields[key] = input;
            card.appendChild(row);
        }

        appendInfo(card, '数量', `${getAllItems(myConfig).length}`);

        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        card.appendChild(actions);
        appendButton(actions, '保存我的滑索信息', () => {
            for (const key of Object.keys(fields)) {
                myConfig[key] = fields[key].value;
            }
            if (!validateZiplineConfig(myConfig)) {
                alertFormatError();
                return;
            }
            ensureConfigId(myConfig);
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
            loadAllConfigs();
            renderManagerPanel();
        });
        appendButton(actions, '显示JSON', () => openExportText(myConfig));
        appendButton(actions, '下载JSON', () => downloadJson(`${myConfig.name || 'my-zipline'}.json`, myConfig));

        return card;
    }

    function openExportText(config) {
        dom.exportTextarea.value = JSON.stringify(config, null, 4);
        showMask(dom.exportMask);
    }

    function createExportPanel() {
        const created = createMask('导出滑索');
        dom.exportMask = created.mask;
        dom.exportPanel = created.panel;
        const textarea = document.createElement('textarea');
        textarea.readOnly = true;
        created.panel.appendChild(textarea);
        dom.exportTextarea = textarea;
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        created.panel.appendChild(actions);
        appendButton(actions, '关闭', () => hideMask(created.mask));
    }

    function downloadJson(filename, config) {
        const blob = new Blob([JSON.stringify(config, null, 4)], { type: 'application/json;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename.replace(/[\\/:*?"<>|]/g, '_');
        document.body.appendChild(link);
        link.click();
        URL.revokeObjectURL(link.href);
        link.remove();
    }

    function createDetailPanel() {
        const created = createMask('滑索详情');
        dom.detailMask = created.mask;
        dom.detailPanel = created.panel;
        dom.detailContent = document.createElement('div');
        created.panel.appendChild(dom.detailContent);
    }

    function openZiplineDetail(id) {
        const record = ziplineById.get(id);
        if (!record) {
            return;
        }
        activeDetailRecord = record;
        clearNode(dom.detailContent);

        const item = record.item;
        appendInfo(dom.detailContent, '名称', item.name || '本地滑索');
        if (record.source !== 'local') {
            appendInfo(dom.detailContent, '简介', item.desc);
        }
        appendInfo(dom.detailContent, '坐标', `${item.pos.x},${item.pos.y},${item.pos.z}`);
        activeDetailPositionDom = appendInfo(dom.detailContent, '位置', getRelativeText(item.pos));

        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        dom.detailContent.appendChild(actions);

        if (record.source === 'local' || record.source === 'import') {
            appendButton(actions, '添加到我的滑索', () => openMyZiplineEdit(record, 'add'));
        }
        if (record.source === 'my') {
            appendButton(actions, '修改', () => openMyZiplineEdit(record, 'edit'));
            appendButton(actions, '连接', () => renderConnectList(record));
            appendButton(actions, '取消连接', () => renderDisconnectList(record));
            appendButton(actions, '移除', () => removeMyZipline(record), 'zipline-tool-danger');
        }
        appendButton(actions, '关闭', closeDetailPanel);
        showMask(dom.detailMask);
    }

    function closeDetailPanel() {
        activeDetailRecord = null;
        activeDetailPositionDom = null;
        hideMask(dom.detailMask);
    }

    function updateActiveDetailPosition() {
        if (!activeDetailRecord || !activeDetailPositionDom || dom.detailMask.classList.contains('zipline-tool-hidden')) {
            return;
        }
        activeDetailPositionDom.innerText = `位置：${getRelativeText(activeDetailRecord.item.pos)}`;
    }

    function getRelativeText(targetPos) {
        if (pos.x === null || pos.y === null || pos.z === null) {
            return '位置同步未开启，无法显示位置';
        }
        const dx = targetPos.x - pos.x;
        const dy = targetPos.y - pos.y;
        const dz = targetPos.z - pos.z;
        const eastWest = dx >= 0 ? `东方${Math.abs(dx)}米` : `西方${Math.abs(dx)}米`;
        const northSouth = dz >= 0 ? `北方${Math.abs(dz)}米` : `南方${Math.abs(dz)}米`;
        const upDown = dy >= 0 ? `上方${Math.abs(dy)}米` : `下方${Math.abs(dy)}米`;
        return `该滑索在您的${eastWest}、${northSouth}、${upDown}`;
    }

    function createEditPanel() {
        const created = createMask('设置滑索属性');
        dom.editMask = created.mask;
        dom.editPanel = created.panel;
        dom.editContent = document.createElement('div');
        created.panel.appendChild(dom.editContent);
    }

    function openMyZiplineEdit(record, mode) {
        clearNode(dom.editContent);
        const nameInput = document.createElement('input');
        nameInput.placeholder = '名称';
        nameInput.value = record.source === 'import' || record.source === 'my' ? record.item.name : '本地滑索';
        dom.editContent.appendChild(nameInput);

        const descRow = document.createElement('div');
        descRow.className = 'zipline-tool-row';
        const descInput = document.createElement('input');
        descInput.placeholder = '简介';
        descInput.value = record.source === 'import' || record.source === 'my' ? record.item.desc : '';
        descRow.appendChild(descInput);
        dom.editContent.appendChild(descRow);

        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        dom.editContent.appendChild(actions);

        appendButton(actions, '取消', () => hideMask(dom.editMask));
        appendButton(actions, '保存', () => {
            if (mode === 'edit') {
                record.item.name = nameInput.value;
                record.item.desc = descInput.value;
            } else {
                const list = ensureMapList(myConfig, record.mapId || activeMapId);
                list.push({
                    id: makeUniqueZiplineId(),
                    name: nameInput.value,
                    pos: {
                        x: record.item.pos.x,
                        y: record.item.pos.y,
                        z: record.item.pos.z
                    },
                    desc: descInput.value,
                    connect: []
                });
            }
            ensureConfigId(myConfig);
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
            loadAllConfigs();
            hideMask(dom.editMask);
            closeDetailPanel();
            if (mode !== 'edit') {
                alert('已保存，刷新页面后可以查看');
            }
        });

        showMask(dom.editMask);
    }

    function removeMyZipline(record) {
        if (!confirm(`确定移除“${record.item.name}”吗？`)) {
            return;
        }
        const list = ensureMapList(myConfig, record.mapId);
        const nextList = list.filter(item => item.id !== record.item.id);
        myConfig.list[record.mapId] = nextList;
        for (const item of nextList) {
            item.connect = item.connect.filter(id => id !== record.item.id);
        }
        ensureConfigId(myConfig);
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        loadAllConfigs();
        closeDetailPanel();
        alert('已移除，刷新页面后可以查看');
    }

    function distance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function renderConnectList(record) {
        const old = dom.detailContent.querySelector('.zipline-tool-connect-list');
        if (old) {
            old.remove();
        }

        const wrap = document.createElement('div');
        wrap.className = 'zipline-tool-connect-list';
        const title = document.createElement('h3');
        title.innerText = '连接附近滑索';
        wrap.appendChild(title);

        const currentItem = findMyZipline(record.mapId, record.item.id);
        if (!currentItem) {
            appendInfo(wrap, '提示', '该滑索不存在');
            dom.detailContent.appendChild(wrap);
            return;
        }

        const candidates = ensureMapList(myConfig, record.mapId)
            .filter(item => item.id !== currentItem.id)
            .filter(item => distance(item.pos, currentItem.pos) <= 200);

        if (candidates.length === 0) {
            appendInfo(wrap, '提示', '200米以内没有可连接的我的滑索');
        }

        for (const item of candidates) {
            const card = document.createElement('div');
            card.className = 'zipline-tool-card';
            const connected = currentItem.connect.includes(item.id);
            const titleLine = document.createElement('div');
            titleLine.className = connected ? 'zipline-tool-title zipline-tool-connected' : 'zipline-tool-title';
            titleLine.innerText = connected ? `${item.name}（已连接）` : item.name;
            card.appendChild(titleLine);
            appendInfo(card, '距离', `${Math.round(distance(item.pos, currentItem.pos))}米`);
            const actions = document.createElement('div');
            actions.className = 'zipline-tool-actions';
            card.appendChild(actions);
            const button = appendButton(actions, '连接', () => {
                addConnectionById(record.mapId, record.item.id, item.id);
                ensureConfigId(myConfig);
                saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
                loadAllConfigs();
                closeDetailPanel();
                alert('已连接，刷新页面后可以查看');
            });
            button.disabled = connected;
            wrap.appendChild(card);
        }

        dom.detailContent.appendChild(wrap);
    }

    function renderDisconnectList(record) {
        const old = dom.detailContent.querySelector('.zipline-tool-connect-list');
        if (old) {
            old.remove();
        }

        const wrap = document.createElement('div');
        wrap.className = 'zipline-tool-connect-list';
        const title = document.createElement('h3');
        title.innerText = '取消连接';
        wrap.appendChild(title);

        const itemById = new Map(ensureMapList(myConfig, record.mapId).map(item => [item.id, item]));
        const currentItem = itemById.get(record.item.id);
        const connectedItems = currentItem ? currentItem.connect.map(id => itemById.get(id)).filter(Boolean) : [];

        if (connectedItems.length === 0) {
            appendInfo(wrap, '提示', '当前没有已连接的我的滑索');
        }

        for (const item of connectedItems) {
            const card = document.createElement('div');
            card.className = 'zipline-tool-card';
            const titleLine = document.createElement('div');
            titleLine.className = 'zipline-tool-title';
            titleLine.innerText = item.name;
            card.appendChild(titleLine);
            const actions = document.createElement('div');
            actions.className = 'zipline-tool-actions';
            card.appendChild(actions);
            appendButton(actions, '取消连接', () => {
                removeConnectionById(record.mapId, record.item.id, item.id);
                ensureConfigId(myConfig);
                saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
                loadAllConfigs();
                closeDetailPanel();
                alert('已取消连接，刷新页面后可以查看');
            }, 'zipline-tool-danger');
            wrap.appendChild(card);
        }

        dom.detailContent.appendChild(wrap);
    }

    function addConnection(a, b) {
        if (!a.connect.includes(b.id)) {
            a.connect.push(b.id);
        }
        if (!b.connect.includes(a.id)) {
            b.connect.push(a.id);
        }
    }

    function removeConnection(a, b) {
        a.connect = a.connect.filter(id => id !== b.id);
        b.connect = b.connect.filter(id => id !== a.id);
    }

    function findMyZipline(mapId, id) {
        return ensureMapList(myConfig, mapId).find(item => item.id === id) || null;
    }

    function addConnectionById(mapId, aId, bId) {
        const itemById = new Map(ensureMapList(myConfig, mapId).map(item => [item.id, item]));
        const a = itemById.get(aId);
        const b = itemById.get(bId);
        if (a && b) {
            addConnection(a, b);
        }
    }

    function removeConnectionById(mapId, aId, bId) {
        const itemById = new Map(ensureMapList(myConfig, mapId).map(item => [item.id, item]));
        const a = itemById.get(aId);
        const b = itemById.get(bId);
        if (a && b) {
            removeConnection(a, b);
        } else if (a) {
            a.connect = a.connect.filter(id => id !== bId);
        } else if (b) {
            b.connect = b.connect.filter(id => id !== aId);
        }
    }

    function addMapClickListener() {
        const view = document.querySelector('#mapView');
        if (view) {
            view.addEventListener('click', ev => {
                const section = ev.target.closest('section.atlas-marker-wrapper.marker-appear[data-marker-type="MARKER_POINT"]');
                if (!section) {
                    return;
                }
                const id = section.dataset.markerId;
                if (id && (myZiplines.includes(id) || importZiplines.includes(id) || localZiplines.includes(id))) {
                    openZiplineDetail(id);
                }
            }, true);
        } else {
            setTimeout(addMapClickListener, 1000);
        }
    }

    function addButton() {
        const avatar = document.querySelector('#avatar');
        if (avatar) {
            const container = document.createElement('div');
            container.className = avatar.parentElement.firstElementChild.className;

            const menu = document.createElement('div');
            menu.innerText = '滑索工具';
            container.appendChild(menu);
            menu.addEventListener('click', openManagerPanel);

            avatar.parentElement.prepend(container);
        } else {
            setTimeout(addButton, 1000);
        }
    }

    function findPosSwitchDom() {
        const switchDom = document.querySelector('div[class^="PointSwitch__SwitchRow"]');
        if (switchDom) {
            const span = document.createElement('span');
            span.className = switchDom.firstElementChild.className;
            posSwitchDom = span;
            switchDom.prepend(span);
        } else {
            setTimeout(findPosSwitchDom, 1000);
        }
    }

    function initUi() {
        injectStyle();
        createImportPanel();
        createManagerPanel();
        createExportPanel();
        createDetailPanel();
        createEditPanel();
    }

    loadAllConfigs();
    initUi();
    addMapClickListener();
    addButton();
    findPosSwitchDom();
})();
