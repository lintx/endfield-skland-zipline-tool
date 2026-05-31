const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');

const SOURCE_CONFIGS = [
    {
        mapId: 'map02',
        sourceUrl: 'https://183.131.59.248:23463/data_wuling.json'
    },
    {
        mapId: 'map01',
        sourceUrl: 'https://183.131.59.248:23463/data_valleyiv.json'
    }
];

const OUTPUT_CONFIG = {
    url: 'https://raw.githubusercontent.com/lintx/endfield-skland-zipline-tool/refs/heads/main/json/rydi_shihara/data.json',
    author: '石原坂奈',
    name: '石原坂奈的滑索',
    desc: '石原坂奈滑索站（https://183.131.59.248:23463/）的滑索，由于证书及跨域问题无法直接导入，故手动导出到这里，更新可能可能存在延迟。'
};

const OUTPUT_FILE = path.join(__dirname, 'data.json');
const DIRECTION_BY_CODE = {
    1: '北',
    2: '东',
    3: '西',
    4: '南'
};

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { rejectUnauthorized: false }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                resolve(fetchText(new URL(response.headers.location, url).href));
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`下载失败：${url} HTTP ${response.statusCode}`));
                return;
            }

            response.setEncoding('utf8');
            let text = '';
            response.on('data', chunk => {
                text += chunk;
            });
            response.on('end', () => resolve(text));
        });
        request.on('error', reject);
        request.setTimeout(30000, () => {
            request.destroy(new Error(`下载超时：${url}`));
        });
    });
}

async function fetchJson(url) {
    const text = await fetchText(url);
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`JSON 解析失败：${url}：${err.message}`);
    }
}

function normalizeZipline(raw, connections) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
        throw new Error('滑索数据缺少 id');
    }
    if (typeof raw.name !== 'string') {
        throw new Error(`滑索 ${raw.id} 缺少 name`);
    }

    const item = {
        id: raw.id,
        name: raw.name,
        connect: Array.from(connections.get(raw.id) || []).sort()
    };

    if (Number.isInteger(raw.h)) {
        item.h = raw.h;
    }
    if (Number.isInteger(raw.natureId)) {
        item.natureId = raw.natureId;
    }
    if (typeof raw.desc === 'string' && raw.desc) {
        item.desc = raw.desc;
    }
    if (typeof raw.imgUrl === 'string' && raw.imgUrl) {
        item.imgUrl = raw.imgUrl;
    }
    if (typeof raw.bvUrl === 'string' && raw.bvUrl) {
        item.bvUrl = raw.bvUrl;
    }
    if (Object.prototype.hasOwnProperty.call(DIRECTION_BY_CODE, raw.direction)) {
        item.direction = DIRECTION_BY_CODE[raw.direction];
    }

    return item;
}

function buildConnectionMap(connections) {
    const map = new Map();
    for (const pair of connections || []) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
            throw new Error(`连线数据格式错误：${JSON.stringify(pair)}`);
        }
        const [from, to] = pair;
        if (!map.has(from)) {
            map.set(from, new Set());
        }
        if (!map.has(to)) {
            map.set(to, new Set());
        }
        map.get(from).add(to);
        map.get(to).add(from);
    }
    return map;
}

function normalizeLinePlans(lines) {
    const plans = [];
    for (const line of lines || []) {
        if (!line || typeof line !== 'object') {
            throw new Error('线路数据格式错误');
        }

        const baseName = line.name && line.regionName ? `${line.name}(${line.regionName})` : line.name || line.regionName || '未命名路线';
        const presets = Array.isArray(line.presets) && line.presets.length ? line.presets : [];
        for (const preset of presets) {
            if (!Array.isArray(preset.ziplineIds)) {
                throw new Error(`线路 ${baseName} 缺少 ziplineIds`);
            }
            const hasMultiplePresets = presets.length > 1;
            const presetName = preset.name || preset.id || '未命名预设';
            plans.push({
                name: hasMultiplePresets ? `${baseName} - ${presetName}` : baseName,
                marks: preset.ziplineIds.slice()
            });
        }
    }
    return plans;
}

function convertDataset(dataset, mapId) {
    if (!dataset || typeof dataset !== 'object') {
        throw new Error(`${mapId} 数据不是对象`);
    }
    if (!Array.isArray(dataset.ziplines)) {
        throw new Error(`${mapId} 数据缺少 ziplines`);
    }

    const connections = buildConnectionMap(dataset.connections);
    const list = { map01: [], map02: [] };
    list[mapId] = dataset.ziplines.map(raw => normalizeZipline(raw, connections));

    return {
        list,
        plans: normalizeLinePlans(dataset.lines)
    };
}

function mergeDatasets(datasets) {
    const output = {
        ...OUTPUT_CONFIG,
        list: {
            map01: [],
            map02: []
        },
        plans: []
    };

    for (const { mapId, dataset } of datasets) {
        const converted = convertDataset(dataset, mapId);
        output.list[mapId] = converted.list[mapId];
        output.plans.push(...converted.plans);
    }

    return output;
}

async function main() {
    const datasets = [];
    for (const config of SOURCE_CONFIGS) {
        const dataset = await fetchJson(config.sourceUrl);
        datasets.push({ mapId: config.mapId, dataset });
    }

    const output = mergeDatasets(datasets);
    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 4)}\n`, 'utf8');
    console.log(`已生成 ${OUTPUT_FILE}`);
    console.log(`map01: ${output.list.map01.length}，map02: ${output.list.map02.length}，plans: ${output.plans.length}`);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err.message);
        process.exitCode = 1;
    });
}

module.exports = {
    DIRECTION_BY_CODE,
    convertDataset,
    mergeDatasets
};
