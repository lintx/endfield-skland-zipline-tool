// ==UserScript==
// @name         终末地森空岛地图工具滑索加强
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  导入、管理终末地在森空岛上的自定义滑索.
// @author       LinTx
// @match        https://game.skland.com/map/endfield*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=skland.com
// @updateURL    https://raw.githubusercontent.com/lintx/endfield-skland-zipline-tool/refs/heads/main/main.user.js
// @downloadURL  https://raw.githubusercontent.com/lintx/endfield-skland-zipline-tool/refs/heads/main/main.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const IMPORT_KEYS_KEY = 'import-zipline-keys';
    const IMPORT_KEY_PREFIX = 'import-zipline-';
    const MY_ZIPLINE_KEY = 'my-zipline';
    const DETAIL_POS_KEY = 'zipline-detail-position';
    const LINE_TEMPLATE_ID = '65863e646fa58f7a3154be46774a9144';
    const LOCAL_ZIPLINE_TEMPLATE_IDS = new Set([
        '0f45150a59b97bd0de9a4eed7a0fbf23',
        '5d53bdb714ba42c1e1a1b748b55b686f'
    ]);
    const INDUSTRIAL_TYPE_NAME = '工业设施';
    const DEFAULT_POINT_PIC = 'https://bbs.hycdn.cn/image/2026/01/19/78170df3542fad3569e2fe813a45efbc.png';
    const DEFAULT_SUBTYPE_PIC = 'https://bbs.hycdn.cn/image/2026/01/19/49aa54dcf3938607211baad01b808f8b.png';
    const DIRECTIONS = new Set(['东', '南', '西', '北']);
    const NATURE_TEXT = {
        1: '可传常规',
        2: '不可传常规',
        3: '只能传火',
        4: '可传岩羊',
        5: '可传间接',
        6: '不可传岩羊',
        7: '不可传间接',
        8: '只能相机飞天',
        9: '只能溺水飞天'
    };

    const pos = { x: null, y: null, z: null };
    let posSwitchDom = null;
    let activeMapId = 'map01';
    let modalZIndex = 999999;
    let toastTimer = 0;
    let importConfigs = [];
    let myConfig = null;
    const runtimeRecords = new Map();
    const localZiplineRecords = new Map();
    const localZiplines = [];
    const importZiplines = [];
    const routeZiplines = [];
    const configRuntime = new Map();
    const dom = {};
    const captureState = {
        active: false,
        mapId: 'map01',
        planId: '',
        lastCandidate: '',
        stableCount: 0,
        currentRef: '',
        lastCapturedUuid: '',
        count: 0,
        message: '',
        lastCandidateText: '',
        lastCapturedText: ''
    };

    const originalFetch = window.fetch;

    function makeUuid() {
        return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
    }

    function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
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

    function parseCoordRef(value) {
        if (typeof value === 'string') {
            const match = value.trim().match(/^\((-?\d+),\s*(-?\d+)(?:,\s*(-?\d+))?\)$/);
            if (!match) {
                return null;
            }
            if (match[3] === undefined) {
                return { x: Number(match[1]), z: Number(match[2]) };
            }
            return { x: Number(match[1]), h: Number(match[2]), z: Number(match[3]) };
        }
        if (isPlainObject(value)) {
            const x = Number(value.x);
            const y = value.y === undefined ? value.h : value.y;
            const z = Number(value.z);
            if (!Number.isInteger(x) || !Number.isInteger(z)) {
                return null;
            }
            if (y === undefined || y === null || y === '') {
                return { x, z };
            }
            const h = Number(y);
            return Number.isInteger(h) ? { x, h, z } : null;
        }
        return null;
    }

    function makeXzId(x, z) {
        return `(${x},${z})`;
    }

    function makeExactRef(x, h, z) {
        return Number.isInteger(h) ? `(${x},${h},${z})` : makeXzId(x, z);
    }

    function getItemCoord(item) {
        const coord = parseCoordRef(item.id);
        if (!coord) {
            return null;
        }
        return {
            x: coord.x,
            z: coord.z,
            h: Number.isInteger(item.h) ? item.h : undefined
        };
    }

    function getItemRef(item) {
        const coord = getItemCoord(item);
        return coord ? makeExactRef(coord.x, coord.h, coord.z) : '';
    }

    function getItemXz(item) {
        const coord = getItemCoord(item);
        return coord ? makeXzId(coord.x, coord.z) : '';
    }

    function hasHeight(item) {
        return Number.isInteger(item && item.h);
    }

    function ziplineDistance(a, b) {
        const ca = getItemCoord(a);
        const cb = getItemCoord(b);
        if (!ca || !cb) {
            return Infinity;
        }
        const dx = ca.x - cb.x;
        const dz = ca.z - cb.z;
        if (Number.isInteger(ca.h) && Number.isInteger(cb.h)) {
            const dh = ca.h - cb.h;
            return Math.sqrt(dx * dx + dh * dh + dz * dz);
        }
        return Math.sqrt(dx * dx + dz * dz);
    }

    function getImportKeys() {
        const keys = safeJsonParse(localStorage.getItem(IMPORT_KEYS_KEY), []);
        return Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.startsWith(IMPORT_KEY_PREFIX)) : [];
    }

    function setImportKeys(keys) {
        localStorage.setItem(IMPORT_KEYS_KEY, JSON.stringify(Array.from(new Set(keys))));
    }

    function saveConfigToStorage(key, config) {
        localStorage.setItem(key, JSON.stringify(config));
    }

    function readConfigFromStorage(key, options) {
        const raw = localStorage.getItem(key);
        if (!raw) {
            return null;
        }
        const parsed = safeJsonParse(raw, null);
        return normalizeConfigForStorage(parsed, options);
    }

    function getDefaultMyConfig() {
        return {
            id: makeUuid(),
            url: '',
            author: '',
            name: '我的路线',
            desc: '',
            list: { map01: [], map02: [] },
            plans: []
        };
    }

    function ensureConfigId(config, usedIds, preferredId) {
        let id = isUuid(preferredId) ? preferredId : isUuid(config.id) ? config.id : makeUuid();
        while (usedIds && usedIds.has(id)) {
            id = makeUuid();
        }
        config.id = id;
        if (usedIds) {
            usedIds.add(id);
        }
    }

    function ensurePlanId(plan) {
        if (!isUuid(plan.id)) {
            plan.id = makeUuid();
        }
    }

    function ensureItemUuid(item, usedIds) {
        let uuid = isUuid(item.uuid) ? item.uuid : isUuid(item.runtimeId) ? item.runtimeId : makeUuid();
        while (usedIds.has(uuid)) {
            uuid = makeUuid();
        }
        item.uuid = uuid;
        usedIds.add(uuid);
    }

    function normalizeConfigForStorage(input, options) {
        if (!isPlainObject(input) || !isPlainObject(input.list)) {
            return null;
        }
        const allowEmpty = !!(options && options.allowEmpty);
        if (typeof input.url !== 'string' || typeof input.author !== 'string' || typeof input.name !== 'string') {
            return null;
        }
        if (input.desc !== undefined && typeof input.desc !== 'string') {
            return null;
        }
        if (input.id !== undefined && !isUuid(input.id)) {
            return null;
        }
        if (input.plans !== undefined && !Array.isArray(input.plans)) {
            return null;
        }
        const mapKeys = Object.keys(input.list);
        if (!mapKeys.length || mapKeys.some(key => key !== 'map01' && key !== 'map02')) {
            return null;
        }
        if (!mapKeys.some(key => key === 'map01' || key === 'map02')) {
            return null;
        }
        for (const mapId of mapKeys) {
            if (!Array.isArray(input.list[mapId])) {
                return null;
            }
        }
        const normalizedPlans = Array.isArray(input.plans) ? input.plans.map(plan => normalizePlan(plan)) : [];
        if (normalizedPlans.some(plan => !plan)) {
            return null;
        }
        const config = {
            id: isUuid(input.id) ? input.id : makeUuid(),
            url: input.url,
            author: input.author,
            name: input.name,
            list: {},
            plans: normalizedPlans
        };
        if (typeof input.desc === 'string') {
            config.desc = input.desc;
        }

        const usedItemUuids = new Set();
        for (const mapId of ['map01', 'map02']) {
            const items = Array.isArray(input.list[mapId]) ? input.list[mapId] : [];
            const normalizedItems = items.map(item => normalizeItem(item, usedItemUuids));
            if (normalizedItems.some(item => !item)) {
                return null;
            }
            config.list[mapId] = normalizedItems;
        }
        if (!allowEmpty && !config.list.map01.length && !config.list.map02.length) {
            return null;
        }

        buildInternalReferences(config);
        return config;
    }

    function normalizePlan(plan) {
        if (!isPlainObject(plan) || typeof plan.name !== 'string') {
            return null;
        }
        if (plan.id !== undefined && !isUuid(plan.id)) {
            return null;
        }
        if (plan.marks !== undefined && !Array.isArray(plan.marks)) {
            return null;
        }
        const next = {
            id: isUuid(plan.id) ? plan.id : makeUuid(),
            name: plan.name,
            marks: Array.isArray(plan.marks) ? plan.marks.slice() : [],
            _marks: Array.isArray(plan._marks) ? plan._marks.filter(isUuid) : [],
            _runtimeIds: isPlainObject(plan._runtimeIds) ? Object.fromEntries(Object.entries(plan._runtimeIds).filter(([itemUuid, runtimeId]) => isUuid(itemUuid) && isUuid(runtimeId))) : {}
        };
        return next;
    }

    function normalizeItem(raw, usedItemUuids) {
        if (!isPlainObject(raw)) {
            return null;
        }
        let coord = parseCoordRef(raw.id);
        if (!coord && isPlainObject(raw.pos)) {
            coord = parseCoordRef(raw.pos);
        }
        if (!coord && Number.isInteger(raw.x) && Number.isInteger(raw.z)) {
            coord = parseCoordRef(raw);
        }
        if (!coord) {
            return null;
        }
        if (typeof raw.name !== 'string' || !Array.isArray(raw.connect)) {
            return null;
        }
        if (raw.h !== undefined && !Number.isInteger(raw.h)) {
            return null;
        }
        if (raw.desc !== undefined && typeof raw.desc !== 'string') {
            return null;
        }
        if (raw.natureId !== undefined && (!Number.isInteger(raw.natureId) || raw.natureId < 1 || raw.natureId > 9)) {
            return null;
        }
        if (raw.direction !== undefined && (typeof raw.direction !== 'string' || !DIRECTIONS.has(raw.direction))) {
            return null;
        }
        if (raw.bvUrl !== undefined && typeof raw.bvUrl !== 'string') {
            return null;
        }
        if (raw.imgUrl !== undefined && typeof raw.imgUrl !== 'string') {
            return null;
        }

        const item = {
            id: makeXzId(coord.x, coord.z),
            name: raw.name,
            connect: raw.connect.slice()
        };
        const h = raw.h === undefined ? coord.h : raw.h;
        if (Number.isInteger(h)) {
            item.h = h;
        }
        if (typeof raw.desc === 'string') {
            item.desc = raw.desc;
        }
        if (Number.isInteger(raw.natureId) && raw.natureId >= 1 && raw.natureId <= 9) {
            item.natureId = raw.natureId;
        }
        if (typeof raw.direction === 'string' && DIRECTIONS.has(raw.direction)) {
            item.direction = raw.direction;
        }
        if (typeof raw.bvUrl === 'string' && raw.bvUrl.trim()) {
            item.bvUrl = raw.bvUrl.trim();
        }
        if (typeof raw.imgUrl === 'string' && raw.imgUrl.trim()) {
            item.imgUrl = raw.imgUrl.trim();
        }
        if (Array.isArray(raw._connect)) {
            item._connect = raw._connect.filter(isUuid);
        }
        item.uuid = isUuid(raw.uuid) ? raw.uuid : isUuid(raw.runtimeId) ? raw.runtimeId : isUuid(raw.id) ? raw.id : makeUuid();
        ensureItemUuid(item, usedItemUuids);
        return item;
    }

    function buildIndexes(config) {
        const byUuid = new Map();
        const byMapUuid = new Map();
        const byMapXz = new Map();
        const byGlobalXz = new Map();
        const byMapExact = new Map();
        for (const mapId of ['map01', 'map02']) {
            for (const item of config.list[mapId] || []) {
                const xz = getItemXz(item);
                const exact = getItemRef(item);
                byUuid.set(item.uuid, { mapId, item });
                byMapUuid.set(`${mapId}:${item.uuid}`, item);
                if (!byMapXz.has(`${mapId}:${xz}`)) {
                    byMapXz.set(`${mapId}:${xz}`, []);
                }
                byMapXz.get(`${mapId}:${xz}`).push(item);
                if (!byGlobalXz.has(xz)) {
                    byGlobalXz.set(xz, []);
                }
                byGlobalXz.get(xz).push({ mapId, item });
                byMapExact.set(`${mapId}:${exact}`, item);
            }
        }
        return { byUuid, byMapUuid, byMapXz, byGlobalXz, byMapExact };
    }

    function resolveItemRef(config, ref, mapId) {
        const indexes = buildIndexes(config);
        if (isUuid(ref)) {
            if (mapId) {
                return indexes.byMapUuid.get(`${mapId}:${ref}`) || null;
            }
            const found = indexes.byUuid.get(ref);
            return found ? found.item : null;
        }
        const coord = parseCoordRef(ref);
        if (!coord) {
            return null;
        }
        if (Number.isInteger(coord.h)) {
            const exact = makeExactRef(coord.x, coord.h, coord.z);
            if (mapId) {
                return indexes.byMapExact.get(`${mapId}:${exact}`) || null;
            }
            const matches = [];
            for (const id of ['map01', 'map02']) {
                const item = indexes.byMapExact.get(`${id}:${exact}`);
                if (item) {
                    matches.push(item);
                }
            }
            return matches.length === 1 ? matches[0] : null;
        }
        const xz = makeXzId(coord.x, coord.z);
        const matches = mapId ? indexes.byMapXz.get(`${mapId}:${xz}`) || [] : indexes.byGlobalXz.get(xz) || [];
        return matches.length === 1 ? (matches[0].item || matches[0]) : null;
    }

    function normalizeRefForExport(ref) {
        const coord = parseCoordRef(ref);
        return coord ? makeXzId(coord.x, coord.z) : null;
    }

    function buildInternalReferences(config) {
        for (const mapId of ['map01', 'map02']) {
            for (const item of config.list[mapId] || []) {
                const existingConnect = Array.isArray(item._connect) ? item._connect.filter(uuid => {
                    const found = findItemByUuid(config, uuid);
                    return found && found.mapId === mapId;
                }) : [];
                item._connect = existingConnect;
                const seen = new Set();
                for (const ref of existingConnect.length ? [] : item.connect || []) {
                    const target = resolveItemRef(config, ref, mapId);
                    if (!target || target.uuid === item.uuid || seen.has(target.uuid)) {
                        continue;
                    }
                    seen.add(target.uuid);
                    item._connect.push(target.uuid);
                }
                item.connect = item._connect.map(uuid => {
                    const target = findItemByUuid(config, uuid);
                    return target ? getItemXz(target.item) : null;
                }).filter(Boolean);
            }
        }
        for (const plan of config.plans || []) {
            ensurePlanId(plan);
            const existingMarks = Array.isArray(plan._marks) ? plan._marks.filter(uuid => !!findItemByUuid(config, uuid)) : [];
            plan._marks = existingMarks;
            const seen = new Set();
            for (const ref of existingMarks.length ? [] : plan.marks || []) {
                const target = resolveItemRef(config, ref);
                if (!target || seen.has(target.uuid)) {
                    continue;
                }
                seen.add(target.uuid);
                plan._marks.push(target.uuid);
            }
            plan.marks = plan._marks.map(uuid => {
                const target = findItemByUuid(config, uuid);
                return target ? getItemXz(target.item) : null;
            }).filter(Boolean);
            if (isPlainObject(plan._runtimeIds)) {
                for (const uuid of Object.keys(plan._runtimeIds)) {
                    if (!plan._marks.includes(uuid)) {
                        delete plan._runtimeIds[uuid];
                    }
                }
            }
        }
    }

    function findItemByUuid(config, uuid) {
        for (const mapId of ['map01', 'map02']) {
            const item = (config.list[mapId] || []).find(entry => entry.uuid === uuid);
            if (item) {
                return { mapId, item };
            }
        }
        return null;
    }

    function getAllItems(config) {
        return ['map01', 'map02'].flatMap(mapId => (config.list[mapId] || []).map(item => ({ mapId, item })));
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

    function loadAllConfigs() {
        importConfigs = [];
        const usedConfigIds = new Set();
        for (const key of getImportKeys()) {
            const config = readConfigFromStorage(key);
            if (config) {
                ensureConfigId(config, usedConfigIds);
                saveConfigToStorage(key, config);
                importConfigs.push({ key, config });
            }
        }
        myConfig = readConfigFromStorage(MY_ZIPLINE_KEY, { allowEmpty: true }) || getDefaultMyConfig();
        ensureConfigId(myConfig, usedConfigIds);
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        rebuildRuntimeMaps();
    }

    function buildPlanRuntimes(config, source, key) {
        const plans = Array.isArray(config.plans) && config.plans.length ? config.plans : [{
            id: config.id,
            name: config.name,
            _marks: getAllItems(config).map(entry => entry.item.uuid)
        }];
        return plans.map(plan => ({ key, source, config, plan, subTypeId: plan.id || config.id }));
    }

    function rebuildRuntimeMaps() {
        runtimeRecords.clear();
        configRuntime.clear();
        importZiplines.length = 0;
        routeZiplines.length = 0;
        localZiplines.length = 0;
        for (const entry of importConfigs) {
            for (const runtime of buildPlanRuntimes(entry.config, 'import', entry.key)) {
                configRuntime.set(`${entry.key}:${runtime.subTypeId}`, runtime);
            }
        }
        for (const runtime of buildPlanRuntimes(myConfig, 'my', MY_ZIPLINE_KEY)) {
            configRuntime.set(`${MY_ZIPLINE_KEY}:${runtime.subTypeId}`, runtime);
        }
        for (const runtime of configRuntime.values()) {
            restoreRuntimeRecords(runtime);
        }
        for (const record of localZiplineRecords.values()) {
            localZiplines.push(record.runtimeId);
            runtimeRecords.set(record.runtimeId, record);
        }
    }

    function restoreRuntimeRecords(runtime) {
        const planSet = new Set(runtime.plan._marks || []);
        for (const uuid of planSet) {
            const found = findItemByUuid(runtime.config, uuid);
            if (!found) {
                continue;
            }
            const runtimeId = ensurePlanMarkRuntimeId(runtime, found.item);
            rememberRuntimeRecord(runtime, found.mapId, found.item, runtimeId);
        }
    }

    function rememberRuntimeRecord(runtime, mapId, item, runtimeId) {
        runtimeRecords.set(runtimeId, { runtimeId, source: runtime.source, config: runtime.config, plan: runtime.plan, mapId, item });
        const list = runtime.source === 'my' ? routeZiplines : importZiplines;
        if (!list.includes(runtimeId)) {
            list.push(runtimeId);
        }
    }

    function persistRuntimeConfig(runtime) {
        if (runtime && runtime.key) {
            saveConfigToStorage(runtime.key, runtime.config);
        }
    }

    function ensurePlanMarkRuntimeId(runtime, item) {
        const plan = runtime.plan;
        if (!isPlainObject(plan._runtimeIds)) {
            plan._runtimeIds = {};
        }
        if (!isUuid(plan._runtimeIds[item.uuid])) {
            plan._runtimeIds[item.uuid] = makeUuid();
            persistRuntimeConfig(runtime);
        }
        return plan._runtimeIds[item.uuid];
    }

    function makeSubType(runtime) {
        return {
            id: runtime.subTypeId,
            name: runtime.plan.name || runtime.config.name,
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
            name: runtime.plan.name || runtime.config.name,
            pic: DEFAULT_POINT_PIC,
            desc: runtime.config.desc || '',
            triggerDistance: 0
        };
    }

    function makePointMark(item, mapId, templateId, runtimeId) {
        const coord = getItemCoord(item);
        return {
            id: runtimeId,
            templateId,
            pos: { x: coord.x, y: Number.isInteger(coord.h) ? coord.h : 0, z: coord.z },
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

    function makeLineMark(fromMark, toMark, mapId) {
        return {
            id: makeUuid(),
            templateId: LINE_TEMPLATE_ID,
            pos: null,
            isUserMarked: false,
            fromMark: { markId: fromMark.id, pos: fromMark.pos },
            toMark: { markId: toMark.id, pos: toMark.pos },
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
        const lineKeys = new Set();
        const planSet = new Set(runtime.plan._marks || []);
        const pointByUuid = new Map();

        for (const uuid of planSet) {
            const found = findItemByUuid(runtime.config, uuid);
            if (!found || found.mapId !== mapId) {
                continue;
            }
            const runtimeId = ensurePlanMarkRuntimeId(runtime, found.item);
            const mark = makePointMark(found.item, mapId, runtime.subTypeId, runtimeId);
            marks.push(mark);
            pointByUuid.set(uuid, mark);
            rememberRuntimeRecord(runtime, mapId, found.item, runtimeId);
        }

        for (const uuid of planSet) {
            const found = findItemByUuid(runtime.config, uuid);
            if (!found || found.mapId !== mapId) {
                continue;
            }
            for (const targetUuid of found.item._connect || []) {
                if (!planSet.has(targetUuid) || !pointByUuid.has(uuid) || !pointByUuid.has(targetUuid)) {
                    continue;
                }
                const key = [uuid, targetUuid].sort().join(':');
                if (lineKeys.has(key)) {
                    continue;
                }
                lineKeys.add(key);
                marks.push(makeLineMark(pointByUuid.get(uuid), pointByUuid.get(targetUuid), mapId));
            }
        }
        return marks;
    }

    function rememberLocalZipline(mark) {
        if (!mark || !mark.id || !mark.pos || localZiplineRecords.has(mark.id)) {
            return;
        }
        const item = {
            id: makeXzId(Math.floor(mark.pos.x), Math.floor(mark.pos.z)),
            uuid: mark.id,
            name: mark.name || mark.title || '本地滑索',
            h: Math.floor(mark.pos.y),
            connect: [],
            _connect: []
        };
        const record = { runtimeId: mark.id, source: 'local', config: null, plan: null, mapId: mark.mapId || activeMapId, item, officialPos: mark.pos };
        localZiplineRecords.set(mark.id, record);
        runtimeRecords.set(mark.id, record);
        localZiplines.push(mark.id);
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

    function extractMapIdFromUrl(url) {
        const match = String(url).match(/[?&]mapId=(map0[12])\b/);
        return match ? match[1] : 'map01';
    }

    function makeJsonResponse(response, data) {
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
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
                    pos.x = Math.floor(data.data.pos.x);
                    pos.y = Math.floor(data.data.pos.y);
                    pos.z = Math.floor(data.data.pos.z);
                    if (typeof data.data.mapId === 'string') {
                        activeMapId = data.data.mapId;
                    }
                    if (posSwitchDom !== null) {
                        posSwitchDom.innerText = `${data.data.pos.x},${data.data.pos.y},${data.data.pos.z}`;
                    }
                    updateActiveDetailPosition();
                    updateAutoCapture();
                }
            }, options]);
        }
        return Reflect.apply(originalAddEventListener, this, [type, listener, options]);
    };

    function toShareConfig(config) {
        const out = {
            url: config.url || '',
            author: config.author || '',
            name: config.name || '',
            list: { map01: [], map02: [] }
        };
        if (typeof config.desc === 'string') {
            out.desc = config.desc;
        }
        for (const mapId of ['map01', 'map02']) {
            out.list[mapId] = (config.list[mapId] || []).map(item => {
                const next = { id: getItemXz(item), name: item.name || '未命名滑索', connect: (item._connect || []).map(uuid => {
                    const found = findItemByUuid(config, uuid);
                    return found ? getItemXz(found.item) : null;
                }).filter(Boolean) };
                if (Number.isInteger(item.natureId)) {
                    next.natureId = item.natureId;
                }
                if (Number.isInteger(item.h)) {
                    next.h = item.h;
                }
                for (const key of ['desc', 'direction', 'bvUrl', 'imgUrl']) {
                    if (typeof item[key] === 'string' && item[key] !== '') {
                        next[key] = item[key];
                    }
                }
                return next;
            });
        }
        if (Array.isArray(config.plans) && config.plans.length) {
            out.plans = config.plans.map(plan => ({
                name: plan.name,
                marks: (plan._marks || []).map(uuid => {
                    const found = findItemByUuid(config, uuid);
                    return found ? getItemXz(found.item) : null;
                }).filter(Boolean)
            }));
        }
        if (!out.list.map01.length) {
            delete out.list.map01;
        }
        if (!out.list.map02.length) {
            delete out.list.map02;
        }
        return out;
    }

    async function loadConfigFromTextOrUrl(inputValue) {
        const value = inputValue.trim();
        if (!value) {
            throw new Error('empty');
        }
        let text = value;
        if (/^https?:\/\//i.test(value)) {
            const response = await originalFetch(value, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error('download failed');
            }
            text = await response.text();
        }
        const parsed = safeJsonParse(text, null);
        const config = normalizeConfigForStorage(parsed);
        if (!config) {
            throw new Error('invalid config');
        }
        return config;
    }

    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
            .zipline-tool-mask{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);color:#e8eef7;font-size:14px}
            .zipline-tool-hidden{display:none!important}
            .zipline-tool-panel{width:min(820px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:#17202b;border:1px solid rgba(255,255,255,.18);border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,.42);padding:16px}
            .zipline-tool-detail{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);width:min(560px,calc(100vw - 24px));max-height:50vh;overflow:auto;z-index:1000000;background:#17202b;color:#e8eef7;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:12px;box-shadow:0 16px 48px rgba(0,0,0,.42)}
            .zipline-tool-detail-header{cursor:move;font-weight:600;margin-bottom:8px}
            .zipline-tool-panel h2,.zipline-tool-detail h2{margin:0 0 12px;font-size:18px}
            .zipline-tool-panel h3{margin:16px 0 8px;font-size:15px}
            .zipline-tool-panel textarea,.zipline-tool-panel input,.zipline-tool-panel select{box-sizing:border-box;width:100%;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:#0e151d;color:#e8eef7;padding:8px 10px;outline:none}
            .zipline-tool-panel textarea{min-height:220px;resize:vertical;font-family:Consolas,monospace}
            .zipline-tool-row{display:flex;gap:8px;align-items:center;margin-top:10px}
            .zipline-tool-row>*{flex:1}
            .zipline-tool-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px}
            .zipline-tool-field{margin-top:10px}
            .zipline-tool-field label{display:block;margin-bottom:4px;color:#aab8c8;font-size:13px}
            .zipline-tool-panel button,.zipline-tool-detail button{border:1px solid rgba(255,255,255,.22);border-radius:6px;background:#24364a;color:#e8eef7;padding:7px 12px;cursor:pointer}
            .zipline-tool-card{border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:10px;background:#111a24;margin-bottom:10px}
            .zipline-tool-title{font-weight:600;margin-bottom:4px}
            .zipline-tool-muted{color:#aab8c8;font-size:13px;line-height:1.5}
            .zipline-tool-danger{background:#5b2630!important}
            .zipline-tool-tag{display:inline-block;margin:2px 4px 2px 0;padding:2px 6px;border:1px solid rgba(255,255,255,.22);border-radius:4px;color:#d7e6ff}
            .zipline-tool-img{max-width:100%;max-height:180px;display:block;margin-top:8px;border-radius:6px}
            .zipline-tool-toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000001;background:#17202b;color:#e8eef7;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:8px 12px;box-shadow:0 10px 32px rgba(0,0,0,.35)}
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

    function showToast(text) {
        if (!dom.toast) {
            dom.toast = document.createElement('div');
            dom.toast.className = 'zipline-tool-toast zipline-tool-hidden';
            document.body.appendChild(dom.toast);
        }
        dom.toast.innerText = text;
        dom.toast.classList.remove('zipline-tool-hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => dom.toast.classList.add('zipline-tool-hidden'), 2400);
    }

    function createImportPanel() {
        const created = createMask('导入滑索');
        dom.importMask = created.mask;
        const textarea = document.createElement('textarea');
        textarea.placeholder = '请输入 JSON 文本或 URL';
        created.panel.appendChild(textarea);
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        created.panel.appendChild(actions);
        appendButton(actions, '取消', () => hideMask(created.mask));
        appendButton(actions, '确定导入', async () => {
            try {
                const config = await loadConfigFromTextOrUrl(textarea.value);
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
        appendButton(topActions, captureState.active ? '停止采集' : '开始采集', () => captureState.active ? stopAutoCapture() : startAutoCapture());
        appendButton(topActions, '复制我的JSON', () => copyText(JSON.stringify(toShareConfig(myConfig), null, 4)));
        renderCaptureStatus(dom.managerContent);

        appendSectionTitle(dom.managerContent, '已导入配置');
        if (!importConfigs.length) {
            appendInfo(dom.managerContent, '提示', '暂无导入配置');
        }
        for (const entry of importConfigs) {
            dom.managerContent.appendChild(renderImportConfigCard(entry));
        }

        appendSectionTitle(dom.managerContent, '我的路线');
        dom.managerContent.appendChild(renderMyConfigEditor());
        dom.managerContent.appendChild(renderRouteManager());
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        dom.managerContent.appendChild(actions);
        appendButton(actions, '关闭', () => hideMask(dom.managerMask));
    }

    function renderCaptureStatus(parent) {
        const card = document.createElement('div');
        card.className = 'zipline-tool-card';
        appendInfo(card, '采集状态', captureState.active ? '正在采集' : '未开始');
        if (captureState.active) {
            const plan = (myConfig.plans || []).find(entry => entry.id === captureState.planId);
            appendInfo(card, '路线', plan ? plan.name : '路线不存在');
            appendInfo(card, '地图', captureState.mapId || activeMapId);
            appendInfo(card, '已采集', `${captureState.count}`);
            appendInfo(card, '最近候选', captureState.lastCandidateText || '暂无');
            appendInfo(card, '最近采集', captureState.lastCapturedText || '暂无');
            appendInfo(card, '提示', captureState.message || (localZiplineRecords.size ? '等待靠近滑索' : '本地滑索标记未加载，请先打开或刷新地图标记'));
        } else if (captureState.message) {
            appendInfo(card, '提示', captureState.message);
        }
        parent.appendChild(card);
    }

    function refreshManagerIfOpen() {
        if (dom.managerMask && !dom.managerMask.classList.contains('zipline-tool-hidden')) {
            renderManagerPanel();
        }
    }

    function appendSectionTitle(parent, text) {
        const title = document.createElement('h3');
        title.innerText = text;
        parent.appendChild(title);
    }

    function renderImportConfigCard(entry) {
        const card = document.createElement('div');
        card.className = 'zipline-tool-card';
        const config = entry.config;
        const title = document.createElement('div');
        title.className = 'zipline-tool-title';
        title.innerText = config.name;
        card.appendChild(title);
        appendInfo(card, '作者', config.author);
        appendInfo(card, '简介', config.desc || '');
        appendInfo(card, '滑索', `${getAllItems(config).length}`);
        appendInfo(card, '路线', `${(config.plans || []).length}`);
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        card.appendChild(actions);
        if (config.url) {
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
        appendButton(actions, '显示JSON', () => openExportText(toShareConfig(config)));
        appendButton(actions, '下载JSON', () => downloadJson(`${config.name || 'zipline'}.json`, toShareConfig(config)));
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
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        card.appendChild(actions);
        appendButton(actions, '保存配置', () => {
            for (const key of Object.keys(fields)) {
                myConfig[key] = fields[key].value;
            }
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
            loadAllConfigs();
            renderManagerPanel();
        });
        appendButton(actions, '显示JSON', () => openExportText(toShareConfig(myConfig)));
        appendButton(actions, '下载JSON', () => downloadJson(`${myConfig.name || 'my-routes'}.json`, toShareConfig(myConfig)));
        return card;
    }

    function renderRouteManager() {
        const wrap = document.createElement('div');
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        wrap.appendChild(actions);
        appendButton(actions, '新建路线', () => {
            const name = prompt('路线名');
            if (!name) {
                return;
            }
            myConfig.plans.push({ id: makeUuid(), name, marks: [], _marks: [] });
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
            renderManagerPanel();
        });
        for (const plan of myConfig.plans || []) {
            const card = document.createElement('div');
            card.className = 'zipline-tool-card';
            const title = document.createElement('div');
            title.className = 'zipline-tool-title';
            title.innerText = `${plan.name}（${(plan._marks || []).length}）`;
            card.appendChild(title);
            appendInfo(card, '滑索', (plan._marks || []).map(uuid => {
                const found = findItemByUuid(myConfig, uuid);
                return found ? found.item.name : '';
            }).filter(Boolean).join('、'));
            const row = document.createElement('div');
            row.className = 'zipline-tool-actions';
            card.appendChild(row);
            appendButton(row, '重命名', () => {
                const next = prompt('路线名', plan.name);
                if (!next) {
                    return;
                }
                plan.name = next;
                saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
                renderManagerPanel();
            });
            appendButton(row, '导出路线', () => openExportText(routeToShareConfig(plan)));
            appendButton(row, '删除', () => {
                if (!confirm(`确定删除路线“${plan.name}”吗？`)) {
                    return;
                }
                myConfig.plans = myConfig.plans.filter(entry => entry.id !== plan.id);
                saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
                renderManagerPanel();
            }, 'zipline-tool-danger');
            wrap.appendChild(card);
        }
        return wrap;
    }

    function routeToShareConfig(plan) {
        const allowed = new Set(plan._marks || []);
        const clone = {
            id: myConfig.id,
            url: myConfig.url || '',
            author: myConfig.author || '',
            name: myConfig.name || '',
            list: { map01: [], map02: [] },
            plans: [{ id: plan.id, name: plan.name, marks: [], _marks: Array.from(allowed) }]
        };
        if (typeof myConfig.desc === 'string') {
            clone.desc = myConfig.desc;
        }
        for (const mapId of ['map01', 'map02']) {
            clone.list[mapId] = (myConfig.list[mapId] || [])
                .filter(item => allowed.has(item.uuid))
                .map(item => {
                    const next = JSON.parse(JSON.stringify(item));
                    next._connect = (next._connect || []).filter(uuid => allowed.has(uuid));
                    return next;
                });
        }
        buildInternalReferences(clone);
        return toShareConfig(clone);
    }

    function createExportPanel() {
        const created = createMask('导出滑索');
        dom.exportMask = created.mask;
        dom.exportTextarea = document.createElement('textarea');
        dom.exportTextarea.readOnly = true;
        created.panel.appendChild(dom.exportTextarea);
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        created.panel.appendChild(actions);
        appendButton(actions, '复制', () => copyText(dom.exportTextarea.value));
        appendButton(actions, '关闭', () => hideMask(created.mask));
    }

    function createEditPanel() {
        const created = createMask('修改滑索');
        dom.editMask = created.mask;
        dom.editFields = {};
        dom.editFields.name = appendEditField(created.panel, '名称', document.createElement('input'));
        const natureSelect = document.createElement('select');
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.innerText = '未设置';
        natureSelect.appendChild(emptyOption);
        for (const id of Object.keys(NATURE_TEXT)) {
            const option = document.createElement('option');
            option.value = id;
            option.innerText = `${id} ${NATURE_TEXT[id]}`;
            natureSelect.appendChild(option);
        }
        dom.editFields.natureId = appendEditField(created.panel, '类型', natureSelect);
        dom.editFields.desc = appendEditField(created.panel, '简介', document.createElement('input'));
        dom.editFields.bvUrl = appendEditField(created.panel, 'B站视频 BV号或链接', document.createElement('input'));
        dom.editFields.imgUrl = appendEditField(created.panel, '图片链接', document.createElement('input'));
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        created.panel.appendChild(actions);
        appendButton(actions, '取消', () => hideMask(dom.editMask));
        appendButton(actions, '保存', saveEditPanel);
    }

    function appendEditField(parent, labelText, control) {
        const wrap = document.createElement('div');
        wrap.className = 'zipline-tool-field';
        const label = document.createElement('label');
        label.innerText = labelText;
        wrap.appendChild(label);
        wrap.appendChild(control);
        parent.appendChild(wrap);
        return control;
    }

    function openExportText(config) {
        dom.exportTextarea.value = JSON.stringify(config, null, 4);
        showMask(dom.exportMask);
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

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }

    function createDetailPanel() {
        dom.detailPanel = document.createElement('div');
        dom.detailPanel.className = 'zipline-tool-detail zipline-tool-hidden';
        const header = document.createElement('div');
        header.className = 'zipline-tool-detail-header';
        header.innerText = '滑索详情';
        dom.detailPanel.appendChild(header);
        dom.detailContent = document.createElement('div');
        dom.detailPanel.appendChild(dom.detailContent);
        document.body.appendChild(dom.detailPanel);
        makeDraggable(dom.detailPanel, header);
        applyDetailPosition();
    }

    function makeDraggable(panel, handle) {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let left = 0;
        let top = 0;
        handle.addEventListener('mousedown', ev => {
            dragging = true;
            startX = ev.clientX;
            startY = ev.clientY;
            const rect = panel.getBoundingClientRect();
            left = rect.left;
            top = rect.top;
            panel.style.transform = 'none';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            ev.preventDefault();
        });
        window.addEventListener('mousemove', ev => {
            if (!dragging) {
                return;
            }
            panel.style.left = `${left + ev.clientX - startX}px`;
            panel.style.top = `${top + ev.clientY - startY}px`;
            panel.style.bottom = 'auto';
        });
        window.addEventListener('mouseup', () => {
            if (dragging) {
                const anchor = getDetailPanelAnchor(panel.getBoundingClientRect(), getViewportSize());
                localStorage.setItem(DETAIL_POS_KEY, JSON.stringify(anchor));
                applyDetailPanelAnchor(panel, anchor);
            }
            dragging = false;
        });
    }

    function getViewportSize() {
        return { width: window.innerWidth || document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight };
    }

    function getDetailPanelAnchor(rect, viewport) {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const x = centerX < viewport.width / 3 ? 'left' : centerX > viewport.width * 2 / 3 ? 'right' : 'center';
        const y = centerY < viewport.height / 3 ? 'top' : centerY > viewport.height * 2 / 3 ? 'bottom' : 'center';
        return {
            x,
            y,
            left: Math.round(Math.max(8, rect.left)),
            right: Math.round(Math.max(8, viewport.width - rect.right)),
            centerX: Math.round(centerX - viewport.width / 2),
            top: Math.round(Math.max(8, rect.top)),
            bottom: Math.round(Math.max(8, viewport.height - rect.bottom)),
            centerY: Math.round(centerY - viewport.height / 2)
        };
    }

    function formatCenterCalc(offset) {
        if (!offset) {
            return '50%';
        }
        return `calc(50% ${offset > 0 ? '+' : '-'} ${Math.abs(offset)}px)`;
    }

    function applyDetailPanelAnchor(panel, anchor) {
        const transforms = [];
        panel.style.left = 'auto';
        panel.style.right = 'auto';
        panel.style.top = 'auto';
        panel.style.bottom = 'auto';
        if (anchor.x === 'left') {
            panel.style.left = `${anchor.left}px`;
        } else if (anchor.x === 'right') {
            panel.style.right = `${anchor.right}px`;
        } else {
            panel.style.left = formatCenterCalc(anchor.centerX);
            transforms.push('translateX(-50%)');
        }
        if (anchor.y === 'top') {
            panel.style.top = `${anchor.top}px`;
        } else if (anchor.y === 'bottom') {
            panel.style.bottom = `${anchor.bottom}px`;
        } else {
            panel.style.top = formatCenterCalc(anchor.centerY);
            transforms.push('translateY(-50%)');
        }
        panel.style.transform = transforms.length ? transforms.join(' ') : 'none';
    }

    function applyDetailPosition() {
        const saved = safeJsonParse(localStorage.getItem(DETAIL_POS_KEY), null);
        if (saved && saved.x && saved.y) {
            applyDetailPanelAnchor(dom.detailPanel, saved);
        }
    }

    function showDetail(record) {
        dom.activeRecord = record;
        clearNode(dom.detailContent);
        const item = record.item;
        appendInfo(dom.detailContent, '名称', item.name || '未命名滑索');
        appendInfo(dom.detailContent, '坐标', formatItemCoord(item));
        if (!hasHeight(item)) {
            appendTag(dom.detailContent, 'Y 未确定');
        }
        appendInfo(dom.detailContent, '方向', item.direction && DIRECTIONS.has(item.direction) ? item.direction : '未校准方向');
        if (Number.isInteger(item.natureId)) {
            appendInfo(dom.detailContent, '类型', NATURE_TEXT[item.natureId] || `${item.natureId}`);
        }
        if (item.desc) {
            appendInfo(dom.detailContent, '简介', item.desc);
        }
        const positionLine = appendInfo(dom.detailContent, '位置', getRelativeText(item));
        positionLine.dataset.positionLine = '1';
        appendLink(dom.detailContent, item.bvUrl);
        appendImage(dom.detailContent, item.imgUrl);
        if (record.source === 'my') {
            appendInfo(dom.detailContent, '所属路线', findPlansForItem(myConfig, item.uuid).map(plan => plan.name).join('、'));
        }
        const actions = document.createElement('div');
        actions.className = 'zipline-tool-actions';
        dom.detailContent.appendChild(actions);
        if (record.source === 'local' || record.source === 'import') {
            appendButton(actions, '添加到路线', () => addRecordToRoute(record));
        }
        if (record.source === 'my') {
            appendButton(actions, '修改', () => editMyItem(record));
            appendButton(actions, '校准坐标和方向', () => calibrateMyItem(record));
            appendButton(actions, '连接', () => renderConnectList(record));
            appendButton(actions, '取消连接', () => renderDisconnectList(record));
            appendButton(actions, '从路线移除', () => removeItemFromPlan(record), 'zipline-tool-danger');
        }
        appendButton(actions, '关闭', hideDetail);
        modalZIndex += 1;
        dom.detailPanel.style.zIndex = `${modalZIndex}`;
        dom.detailPanel.classList.remove('zipline-tool-hidden');
    }

    function hideDetail() {
        dom.detailPanel.classList.add('zipline-tool-hidden');
    }

    function appendTag(parent, text) {
        const span = document.createElement('span');
        span.className = 'zipline-tool-tag';
        span.innerText = text;
        parent.appendChild(span);
    }

    function appendLink(parent, value) {
        if (!value) {
            return;
        }
        const href = /^BV/i.test(value) ? `https://www.bilibili.com/video/${value}` : value;
        if (!/^https?:\/\//i.test(href)) {
            return;
        }
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerText = href;
        parent.appendChild(a);
    }

    function appendImage(parent, value) {
        if (!/^https?:\/\//i.test(value || '')) {
            return;
        }
        const img = document.createElement('img');
        img.className = 'zipline-tool-img';
        img.src = value;
        img.onerror = () => {
            img.remove();
            appendLink(parent, value);
        };
        parent.appendChild(img);
    }

    function formatItemCoord(item) {
        const coord = getItemCoord(item);
        return Number.isInteger(coord.h) ? `(${coord.x},${coord.h},${coord.z})` : `(${coord.x},?,${coord.z})`;
    }

    function getRelativeText(item) {
        const coord = getItemCoord(item);
        if (pos.x === null || pos.y === null || pos.z === null) {
            return '位置同步未开启，无法显示位置';
        }
        const dx = coord.x - pos.x;
        const dz = coord.z - pos.z;
        const eastWest = dx >= 0 ? `东方${Math.abs(dx)}米` : `西方${Math.abs(dx)}米`;
        const northSouth = dz >= 0 ? `北方${Math.abs(dz)}米` : `南方${Math.abs(dz)}米`;
        if (!Number.isInteger(coord.h)) {
            return `该滑索在您的${eastWest}、${northSouth}`;
        }
        const dy = coord.h - pos.y;
        const upDown = dy >= 0 ? `上方${Math.abs(dy)}米` : `下方${Math.abs(dy)}米`;
        return `该滑索在您的${eastWest}、${northSouth}、${upDown}`;
    }

    function updateActiveDetailPosition() {
        const info = dom.detailContent && dom.detailContent.querySelector('[data-position-line="1"]');
        if (info && dom.activeRecord) {
            info.innerText = `位置：${getRelativeText(dom.activeRecord.item)}`;
        }
    }

    function findPlansForItem(config, uuid) {
        return (config.plans || []).filter(plan => (plan._marks || []).includes(uuid));
    }

    function addRecordToRoute(record) {
        const plan = chooseOrCreatePlan();
        if (!plan) {
            return;
        }
        const target = ensureItemInMyConfig(record);
        if (!plan._marks.includes(target.item.uuid)) {
            plan._marks.push(target.item.uuid);
            plan.marks.push(getItemXz(target.item));
        }
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        loadAllConfigs();
        hideDetail();
        alert('已添加到路线，刷新页面后可以查看');
    }

    function chooseOrCreatePlan() {
        const names = (myConfig.plans || []).map(plan => plan.name).join('、');
        const name = prompt(names ? `输入路线名，已有：${names}` : '输入路线名');
        if (!name) {
            return null;
        }
        let plan = myConfig.plans.find(entry => entry.name === name);
        if (!plan) {
            plan = { id: makeUuid(), name, marks: [], _marks: [] };
            myConfig.plans.push(plan);
        }
        return plan;
    }

    function ensureItemInMyConfig(record) {
        const existing = getAllItems(myConfig).find(entry => sameZipline(entry.item, record.item));
        if (existing) {
            return existing;
        }
        const item = cloneItemForMy(record.item);
        ensureMapList(myConfig, record.mapId || activeMapId).push(item);
        return { mapId: record.mapId || activeMapId, item };
    }

    function sameZipline(a, b) {
        const ca = getItemCoord(a);
        const cb = getItemCoord(b);
        if (!ca || !cb || ca.x !== cb.x || ca.z !== cb.z) {
            return false;
        }
        if (Number.isInteger(ca.h) || Number.isInteger(cb.h)) {
            return ca.h === cb.h;
        }
        return true;
    }

    function cloneItemForMy(item) {
        const next = JSON.parse(JSON.stringify(item));
        next.uuid = makeUuid();
        next.connect = [];
        next._connect = [];
        delete next._runtimeIds;
        return next;
    }

    function editMyItem(record) {
        dom.editRecord = record;
        dom.editFields.name.value = record.item.name || '';
        dom.editFields.natureId.value = Number.isInteger(record.item.natureId) ? `${record.item.natureId}` : '';
        dom.editFields.desc.value = record.item.desc || '';
        dom.editFields.bvUrl.value = record.item.bvUrl || '';
        dom.editFields.imgUrl.value = record.item.imgUrl || '';
        showMask(dom.editMask);
    }

    function saveEditPanel() {
        const record = dom.editRecord;
        if (!record || !record.item) {
            hideMask(dom.editMask);
            return;
        }
        const natureValue = dom.editFields.natureId.value;
        if (natureValue) {
            record.item.natureId = Number(natureValue);
        } else {
            delete record.item.natureId;
        }
        record.item.name = dom.editFields.name.value;
        record.item.desc = dom.editFields.desc.value;
        if (dom.editFields.bvUrl.value.trim()) {
            record.item.bvUrl = dom.editFields.bvUrl.value.trim();
        } else {
            delete record.item.bvUrl;
        }
        if (dom.editFields.imgUrl.value.trim()) {
            record.item.imgUrl = dom.editFields.imgUrl.value.trim();
        } else {
            delete record.item.imgUrl;
        }
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        loadAllConfigs();
        hideMask(dom.editMask);
        hideDetail();
    }

    function calibrateMyItem(record) {
        if (!confirm('请先登上滑索架并保持位置同步开启，然后点击确定自动校准坐标和方向')) {
            return;
        }
        if (pos.x === null || pos.y === null || pos.z === null) {
            alert('位置同步未开启，无法校准');
            return;
        }
        if (!localZiplineRecords.size) {
            alert('本地滑索标记未加载，请先打开或刷新地图标记');
            return;
        }
        const candidate = findNearestOfficialCandidate();
        if (!candidate) {
            alert('未检测到可校准的滑索，请站在滑索架上后重试');
            return;
        }
        record.item.id = makeXzId(candidate.x, candidate.z);
        record.item.h = candidate.h;
        record.item.direction = candidate.direction;
        buildInternalReferences(myConfig);
        for (const plan of myConfig.plans || []) {
            plan.marks = (plan._marks || []).map(uuid => {
                const found = findItemByUuid(myConfig, uuid);
                return found ? getItemXz(found.item) : null;
            }).filter(Boolean);
        }
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        loadAllConfigs();
        hideDetail();
        showToast(`已校准坐标和方向：${formatCandidateCoord(candidate)}`);
    }

    function renderConnectList(record) {
        removeInlineList();
        const wrap = createInlineList('连接附近滑索');
        const candidates = getAllItems(myConfig)
            .filter(entry => entry.mapId === record.mapId)
            .filter(entry => entry.item.uuid !== record.item.uuid)
            .filter(entry => ziplineDistance(entry.item, record.item) <= 200);
        for (const entry of candidates) {
            const connected = (record.item._connect || []).includes(entry.item.uuid);
            const card = document.createElement('div');
            card.className = 'zipline-tool-card';
            card.innerText = `${entry.item.name} ${Math.round(ziplineDistance(entry.item, record.item))}米${connected ? '（已连接）' : ''}`;
            const actions = document.createElement('div');
            actions.className = 'zipline-tool-actions';
            card.appendChild(actions);
            const button = appendButton(actions, '连接', () => {
                addConnection(record.item, entry.item);
                saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
                loadAllConfigs();
                hideDetail();
                alert('已连接，刷新页面后可以查看');
            });
            button.disabled = connected;
            wrap.appendChild(card);
        }
        dom.detailContent.appendChild(wrap);
    }

    function renderDisconnectList(record) {
        removeInlineList();
        const wrap = createInlineList('取消连接');
        const connectedUuids = new Set(record.item._connect || []);
        for (const entry of getAllItems(myConfig)) {
            if (entry.mapId === record.mapId && (entry.item._connect || []).includes(record.item.uuid)) {
                connectedUuids.add(entry.item.uuid);
            }
        }
        for (const uuid of connectedUuids) {
            const found = findItemByUuid(myConfig, uuid);
            if (!found) {
                continue;
            }
            const card = document.createElement('div');
            card.className = 'zipline-tool-card';
            card.innerText = found.item.name;
            const actions = document.createElement('div');
            actions.className = 'zipline-tool-actions';
            card.appendChild(actions);
            appendButton(actions, '取消连接', () => {
                removeConnection(record.item, found.item);
                saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
                loadAllConfigs();
                hideDetail();
                alert('已取消连接，刷新页面后可以查看');
            }, 'zipline-tool-danger');
            wrap.appendChild(card);
        }
        dom.detailContent.appendChild(wrap);
    }

    function createInlineList(title) {
        const wrap = document.createElement('div');
        wrap.className = 'zipline-tool-connect-list';
        const h3 = document.createElement('h3');
        h3.innerText = title;
        wrap.appendChild(h3);
        return wrap;
    }

    function removeInlineList() {
        const old = dom.detailContent.querySelector('.zipline-tool-connect-list');
        if (old) {
            old.remove();
        }
    }

    function addConnection(a, b) {
        if (!Array.isArray(a._connect)) {
            a._connect = [];
        }
        if (!Array.isArray(b._connect)) {
            b._connect = [];
        }
        if (!a._connect.includes(b.uuid)) {
            a._connect.push(b.uuid);
        }
        if (!b._connect.includes(a.uuid)) {
            b._connect.push(a.uuid);
        }
        a.connect = a._connect.map(uuid => {
            const found = findItemByUuid(myConfig, uuid);
            return found ? getItemXz(found.item) : null;
        }).filter(Boolean);
        b.connect = b._connect.map(uuid => {
            const found = findItemByUuid(myConfig, uuid);
            return found ? getItemXz(found.item) : null;
        }).filter(Boolean);
    }

    function removeConnection(a, b) {
        if (!Array.isArray(a._connect)) {
            a._connect = [];
        }
        if (!Array.isArray(b._connect)) {
            b._connect = [];
        }
        a._connect = a._connect.filter(uuid => uuid !== b.uuid);
        b._connect = b._connect.filter(uuid => uuid !== a.uuid);
        a.connect = a._connect.map(uuid => {
            const found = findItemByUuid(myConfig, uuid);
            return found ? getItemXz(found.item) : null;
        }).filter(Boolean);
        b.connect = b._connect.map(uuid => {
            const found = findItemByUuid(myConfig, uuid);
            return found ? getItemXz(found.item) : null;
        }).filter(Boolean);
    }

    function removeItemFromPlan(record) {
        if (!record.plan) {
            return;
        }
        record.plan._marks = (record.plan._marks || []).filter(uuid => uuid !== record.item.uuid);
        record.plan.marks = record.plan._marks.map(uuid => {
            const found = findItemByUuid(myConfig, uuid);
            return found ? getItemXz(found.item) : null;
        }).filter(Boolean);
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        loadAllConfigs();
        hideDetail();
    }

    function startAutoCapture() {
        const plan = chooseOrCreatePlan();
        if (!plan) {
            return;
        }
        saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
        captureState.active = true;
        captureState.planId = plan.id;
        captureState.mapId = activeMapId;
        captureState.lastCandidate = '';
        captureState.stableCount = 0;
        captureState.currentRef = '';
        captureState.lastCapturedUuid = '';
        captureState.count = 0;
        captureState.lastCandidateText = '';
        captureState.lastCapturedText = '';
        captureState.message = localZiplineRecords.size ? '等待靠近滑索' : '本地滑索标记未加载，请先打开或刷新地图标记';
        renderManagerPanel();
    }

    function stopAutoCapture() {
        captureState.active = false;
        captureState.message = '已停止采集';
        renderManagerPanel();
    }

    function updateAutoCapture() {
        if (!captureState.active || pos.x === null || pos.y === null || pos.z === null) {
            return;
        }
        if (!localZiplineRecords.size) {
            if (captureState.message !== '本地滑索标记未加载，请先打开或刷新地图标记') {
                captureState.message = '本地滑索标记未加载，请先打开或刷新地图标记';
                refreshManagerIfOpen();
            }
            return;
        }
        const candidate = findNearestOfficialCandidate();
        if (!candidate) {
            captureState.lastCandidate = '';
            captureState.stableCount = 0;
            return;
        }
        const key = `${candidate.x},${candidate.h},${candidate.z},${candidate.direction}`;
        const text = formatCandidateCoord(candidate);
        if (captureState.lastCandidateText !== text) {
            captureState.lastCandidateText = text;
            captureState.message = '检测到候选滑索，保持位置以确认';
            refreshManagerIfOpen();
        }
        if (key === captureState.currentRef) {
            return;
        }
        if (key === captureState.lastCandidate) {
            captureState.stableCount += 1;
        } else {
            captureState.lastCandidate = key;
            captureState.stableCount = 1;
        }
        if (captureState.stableCount >= 2) {
            captureCandidate(candidate);
            captureState.currentRef = key;
            captureState.stableCount = 0;
        }
    }

    function findNearestOfficialCandidate() {
        let best = null;
        for (const record of localZiplineRecords.values()) {
            if (record.mapId !== activeMapId || !record.officialPos) {
                continue;
            }
            for (const candidate of createOfficialCandidates(record.officialPos)) {
                const dx = candidate.x - pos.x;
                const dz = candidate.z - pos.z;
                const planar = Math.sqrt(dx * dx + dz * dz);
                const heightOffset = Math.abs(pos.y - (candidate.h + 3.5));
                if (planar <= 4 && heightOffset <= 1.5 && (!best || planar < best.planar)) {
                    best = Object.assign({ planar }, candidate);
                }
            }
        }
        return best;
    }

    function createOfficialCandidates(markPos) {
        const x = Math.floor(markPos.x);
        const z = Math.floor(markPos.z);
        const h = Math.floor(markPos.y);
        return [
            { x: x + 1, z: z + 1, h, direction: '北' },
            { x: x - 1, z: z + 1, h, direction: '西' },
            { x: x - 1, z: z - 1, h, direction: '南' },
            { x: x + 1, z: z - 1, h, direction: '东' }
        ];
    }

    function formatCandidateCoord(candidate) {
        return `(${candidate.x},${candidate.h},${candidate.z}) ${candidate.direction}`;
    }

    function captureCandidate(candidate) {
        const plan = myConfig.plans.find(entry => entry.id === captureState.planId);
        if (!plan) {
            captureState.active = false;
            captureState.message = '采集路线不存在，已停止采集';
            refreshManagerIfOpen();
            return;
        }
        const item = {
            id: makeXzId(candidate.x, candidate.z),
            uuid: makeUuid(),
            name: '未命名滑索',
            h: candidate.h,
            direction: candidate.direction,
            connect: [],
            _connect: []
        };
        const existing = getAllItems(myConfig).find(entry => sameZipline(entry.item, item));
        const target = existing ? existing.item : item;
        if (!existing) {
            ensureMapList(myConfig, captureState.mapId).push(item);
        }
        if (!plan._marks.includes(target.uuid)) {
            plan._marks.push(target.uuid);
            plan.marks.push(getItemXz(target));
            if (captureState.lastCapturedUuid) {
                const last = findItemByUuid(myConfig, captureState.lastCapturedUuid);
                if (last) {
                    addConnection(last.item, target);
                }
            }
            captureState.lastCapturedUuid = target.uuid;
            captureState.count += 1;
            captureState.lastCapturedText = formatCandidateCoord(candidate);
            captureState.message = `已采集 ${captureState.lastCapturedText}`;
            saveConfigToStorage(MY_ZIPLINE_KEY, myConfig);
            loadAllConfigs();
            showToast(`已采集滑索：${captureState.lastCapturedText}`);
            refreshManagerIfOpen();
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
                const record = runtimeRecords.get(section.dataset.markerId);
                if (record) {
                    dom.activeRecord = record;
                    showDetail(record);
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
        createEditPanel();
        createDetailPanel();
    }

    loadAllConfigs();
    initUi();
    addMapClickListener();
    addButton();
    findPosSwitchDom();
})();
