// Theme Manager server storage plugin for SillyTavern.
// Stores metadata and externalizes user-supplied images out of browser storage.

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const info = {
    id: 'theme-manager',
    name: 'Theme Manager Storage',
    description: 'Server-side persistence backend for the Theme Manager extension.',
};

const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DATA_FILE = path.join(DATA_DIR, 'theme-manager.json');
const IMAGE_URL_PREFIX = '/api/plugins/theme-manager/images/';
const AVATAR_DATA_FILE = path.join(DATA_DIR, 'avatar-manifest.json');
const AVATAR_SCHEMA_VERSION = 1;
const AVATAR_CAPABILITY_VERSION = 1;
const AVATAR_BINDINGS_VERSION = 4;
const GC_GRACE_MS = 24 * 60 * 60 * 1000;

const avatarImageVerificationCache = new Map();
// Short-lived per-user inventory cache. Theme JSON files are read again after
// the TTL, while repeated manager opens during the same UI session avoid a
// full directory parse.
const themeInventoryCache = new Map();
const THEME_INVENTORY_CACHE_MS = 2000;
const avatarImageVerificationStats = { statCalls: 0, hashCalls: 0, bytesHashed: 0 };

const DATA_URL_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
const SAFE_IMAGE_NAME_RE = /^[a-f0-9]{40}\.[a-z0-9]+$/i;
const ALLOWED_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'gif', 'bmp']);
const IMAGE_KEYS = new Set(['imageData', 'thumbData', 'previewData', 'fabImage']);

function ensureDirsSync() {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m === 'jpeg' || m === 'jpg' || m === 'pjpeg') return 'jpg';
    if (m === 'png') return 'png';
    if (m === 'webp') return 'webp';
    if (m === 'gif') return 'gif';
    if (m === 'bmp') return 'bmp';
    return null;
}

function isValidImageName(name) {
    if (!SAFE_IMAGE_NAME_RE.test(name)) return false;
    const ext = name.split('.').pop().toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

async function writeJsonAtomic(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
}

async function readDataFile(filePath = DATA_FILE) {
    try {
        const text = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(text);
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
}

async function storeBase64Image(dataUrl) {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return null;

    const ext = extFromMime(m[1]);
    if (!ext) return null;

    const raw = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    if (!raw.length) return null;
    const sha1 = crypto.createHash('sha1').update(raw).digest('hex');
    const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    const name = sha1 + '.' + ext;
    const filePath = path.join(IMAGES_DIR, name);

    try {
        await fsp.access(filePath);
    } catch {
        await fsp.writeFile(filePath, raw);
    }

    return {
        name,
        url: IMAGE_URL_PREFIX + name,
        sha256: 'sha256:' + sha256,
        bytes: raw.length,
        mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext),
    };
}

async function imageToDataUrl(name) {
    if (!isValidImageName(name)) return null;
    const filePath = path.join(IMAGES_DIR, name);
    if (!filePath.startsWith(IMAGES_DIR + path.sep) && filePath !== path.join(IMAGES_DIR, name)) return null;

    try {
        const buf = await fsp.readFile(filePath);
        const ext = name.split('.').pop().toLowerCase();
        const mimeMap = { jpg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' };
        const mime = mimeMap[ext] || 'jpeg';
        return 'data:image/' + mime + ';base64,' + buf.toString('base64');
    } catch {
        return null;
    }
}

async function externalizeImages(value, keyHint = '') {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        for (const item of value) {
            await externalizeImages(item);
        }
        return;
    }

    for (const key of Object.keys(value)) {
        const item = value[key];
        if (typeof item === 'string' && IMAGE_KEYS.has(key)) {
            if (item.startsWith('data:image/')) {
                const stored = await storeBase64Image(item);
                if (stored && stored.url) value[key] = stored.url;
            }
            continue;
        }
        if (item && typeof item === 'object') {
            await externalizeImages(item, key);
        }
    }
}

function collectReferencedImages(value, refs) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
        value.forEach(item => collectReferencedImages(item, refs));
        return;
    }

    for (const key of Object.keys(value)) {
        const item = value[key];
        if (typeof item === 'string' && IMAGE_KEYS.has(key) && item.startsWith(IMAGE_URL_PREFIX)) {
            const name = path.basename(item);
            if (isValidImageName(name)) refs.add(name);
            continue;
        }
        if (item && typeof item === 'object') collectReferencedImages(item, refs);
    }
}

function avatarError(code, message, status = 500, details) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    if (details) error.details = details;
    return error;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function manifestFingerprint(manifest) {
    return 'sha256:' + crypto.createHash('sha256').update(stableStringify(manifest)).digest('hex');
}

function hasExactKeys(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isCanonicalText(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isCanonicalAvatarView(view) {
    return hasExactKeys(view, ['x', 'y', 'scale', 'rotate', 'flipX', 'flipY']) &&
        Number.isFinite(view.x) && view.x >= -20 && view.x <= 20 &&
        Number.isFinite(view.y) && view.y >= -20 && view.y <= 20 &&
        Number.isFinite(view.scale) && view.scale >= 0.5 && view.scale <= 3 &&
        Number.isFinite(view.rotate) && view.rotate >= -180 && view.rotate <= 180 &&
        typeof view.flipX === 'boolean' && typeof view.flipY === 'boolean';
}

function validateAvatarImageRef(ref, label) {
    if (!hasExactKeys(ref, ['name', 'url', 'sha256', 'bytes', 'mime'])) {
        throw avatarError('AVATAR_MANIFEST_INVALID', label + ' must be a canonical object', 422);
    }
    const { name, url, sha256, bytes, mime } = ref;
    if (typeof name !== 'string' || typeof url !== 'string' || typeof sha256 !== 'string' || typeof mime !== 'string') {
        throw avatarError('AVATAR_MANIFEST_INVALID', label + ' has invalid field types', 422);
    }
    if (!isValidImageName(name) || url !== IMAGE_URL_PREFIX + name || !/^sha256:[a-f0-9]{64}$/i.test(sha256) ||
        sha256 !== sha256.toLowerCase() || !Number.isSafeInteger(bytes) || bytes < 1 ||
        !/^image\/(?:jpeg|png|webp|gif|bmp)$/.test(mime)) {
        throw avatarError('AVATAR_MANIFEST_INVALID', label + ' is invalid', 422);
    }
    return { name, url, sha256, bytes, mime };
}

function validateAvatarManifest(raw) {
    if (!hasExactKeys(raw, ['schemaVersion', 'assets', 'bindings', 'nativeViews', 'sourceIntents']) ||
        raw.schemaVersion !== AVATAR_SCHEMA_VERSION || !Array.isArray(raw.assets) ||
        !Array.isArray(raw.bindings) || !Array.isArray(raw.nativeViews) || !Array.isArray(raw.sourceIntents)) {
        throw avatarError('AVATAR_MANIFEST_INVALID', 'Avatar manifest shape is invalid', 422);
    }

    const manifest = JSON.parse(JSON.stringify(raw));
    const assetIds = new Set();
    const bindingIds = new Set();
    const nativeTargets = new Set();
    const sourceTargets = new Set();
    manifest.assets.forEach((asset, index) => {
        if (!hasExactKeys(asset, ['version', 'id', 'name', 'mimeType', 'width', 'height', 'createdAt', 'updatedAt', 'image', 'thumbnail']) ||
            asset.version !== 1 || !isCanonicalText(asset.id) || assetIds.has(asset.id) || !isCanonicalText(asset.name) ||
            !/^image\/(?:jpeg|png|webp)$/.test(asset.mimeType) || !Number.isSafeInteger(asset.width) || asset.width < 1 ||
            !Number.isSafeInteger(asset.height) || asset.height < 1 || !isCanonicalText(asset.createdAt) || !isCanonicalText(asset.updatedAt)) {
            throw avatarError('AVATAR_MANIFEST_INVALID', 'Avatar asset ' + index + ' is invalid', 422);
        }
        assetIds.add(asset.id);
        asset.image = validateAvatarImageRef(asset.image, 'Avatar asset image ' + index);
        asset.thumbnail = validateAvatarImageRef(asset.thumbnail, 'Avatar asset thumbnail ' + index);
        if (asset.image.mime !== String(asset.mimeType).toLowerCase()) {
            throw avatarError('AVATAR_MANIFEST_INVALID', 'Avatar asset MIME does not match its image', 422);
        }
    });
    manifest.bindings.forEach((binding, index) => {
        if (!hasExactKeys(binding, ['version', 'id', 'themeKey', 'targetKey', 'avatarId', 'view', 'updatedAt']) ||
            !Number.isSafeInteger(binding.version) || binding.version < 1 || binding.version > AVATAR_BINDINGS_VERSION ||
            !isCanonicalText(binding.id) || bindingIds.has(binding.id) || !isCanonicalText(binding.themeKey) || !isCanonicalText(binding.targetKey) ||
            binding.id !== binding.themeKey + '\u001f' + binding.targetKey || !isCanonicalText(binding.avatarId) || !assetIds.has(binding.avatarId) ||
            !isCanonicalAvatarView(binding.view) || !isCanonicalText(binding.updatedAt)) {
            throw avatarError('AVATAR_MANIFEST_INVALID', 'Avatar binding ' + index + ' is invalid', 422);
        }
        bindingIds.add(binding.id);
    });
    manifest.nativeViews.forEach((view, index) => {
        if (!hasExactKeys(view, ['version', 'id', 'targetKey', 'sourceKey', 'view', 'updatedAt']) || view.version !== 1 ||
            !isCanonicalText(view.targetKey) || view.id !== 'native-view\u001f' + view.targetKey || nativeTargets.has(view.targetKey) ||
            !isCanonicalText(view.sourceKey) || !isCanonicalAvatarView(view.view) || !isCanonicalText(view.updatedAt)) {
            throw avatarError('AVATAR_MANIFEST_INVALID', 'Avatar native view ' + index + ' is invalid', 422);
        }
        nativeTargets.add(view.targetKey);
    });
    manifest.sourceIntents.forEach((intent, index) => {
        if (!hasExactKeys(intent, ['version', 'id', 'targetKey', 'mode', 'updatedAt']) || intent.version !== 1 ||
            !isCanonicalText(intent.targetKey) || intent.id !== 'source-intent\u001f' + intent.targetKey || sourceTargets.has(intent.targetKey) ||
            intent.mode !== 'host-source' || !isCanonicalText(intent.updatedAt)) {
            throw avatarError('AVATAR_MANIFEST_INVALID', 'Avatar source intent ' + index + ' is invalid', 422);
        }
        sourceTargets.add(intent.targetKey);
    });
    return manifest;
}

function collectAvatarReferencedImages(manifest, refs) {
    if (!manifest || !Array.isArray(manifest.assets)) return;
    manifest.assets.forEach(asset => {
        [asset && asset.image, asset && asset.thumbnail].forEach(ref => {
            const name = ref && String(ref.name || '');
            if (isValidImageName(name)) refs.add(name);
        });
    });
}

function avatarImageRefSignature(ref) {
    return [ref.name, ref.url, ref.sha256, ref.bytes, ref.mime].join('\u001f');
}

function avatarImageStatSignature(stat) {
    return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino].join('\u001f');
}

function avatarImageCacheKey(imagesDir, name) {
    return path.resolve(imagesDir) + '\u001f' + name;
}

function clearAvatarImageVerificationCache() {
    avatarImageVerificationCache.clear();
}

function resetAvatarImageVerificationStats() {
    avatarImageVerificationStats.statCalls = 0;
    avatarImageVerificationStats.hashCalls = 0;
    avatarImageVerificationStats.bytesHashed = 0;
}

function getAvatarImageVerificationStats() {
    return { ...avatarImageVerificationStats, cacheEntries: avatarImageVerificationCache.size };
}

async function statAvatarImage(filePath, normalized) {
    avatarImageVerificationStats.statCalls += 1;
    try { return await fsp.stat(filePath); }
    catch (error) {
        avatarImageVerificationCache.delete(avatarImageCacheKey(path.dirname(filePath), normalized.name));
        throw avatarError('AVATAR_IMAGE_MISSING', 'Referenced avatar image is missing', 422, { name: normalized.name, cause: error.code });
    }
}

async function verifyAvatarImageRef(ref, imagesDir = IMAGES_DIR) {
    const normalized = validateAvatarImageRef(ref, 'Avatar image reference');
    const filePath = path.join(imagesDir, normalized.name);
    const cacheKey = avatarImageCacheKey(imagesDir, normalized.name);
    const refSignature = avatarImageRefSignature(normalized);
    const initialStat = await statAvatarImage(filePath, normalized);
    const initialStatSignature = avatarImageStatSignature(initialStat);
    const cached = avatarImageVerificationCache.get(cacheKey);
    if (cached && cached.refSignature === refSignature && cached.statSignature === initialStatSignature) {
        return normalized;
    }

    let raw;
    try { raw = await fsp.readFile(filePath); }
    catch (error) {
        avatarImageVerificationCache.delete(cacheKey);
        throw avatarError('AVATAR_IMAGE_MISSING', 'Referenced avatar image is missing', 422, { name: normalized.name, cause: error.code });
    }
    avatarImageVerificationStats.hashCalls += 1;
    avatarImageVerificationStats.bytesHashed += raw.length;
    const ext = normalized.name.split('.').pop().toLowerCase();
    const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
    const sha1 = crypto.createHash('sha1').update(raw).digest('hex');
    const sha256 = 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex');
    if (normalized.name !== sha1 + '.' + ext || raw.length !== normalized.bytes || mime !== normalized.mime || sha256 !== normalized.sha256) {
        avatarImageVerificationCache.delete(cacheKey);
        throw avatarError('AVATAR_IMAGE_INVALID', 'Referenced avatar image metadata does not match stored bytes', 422, { name: normalized.name });
    }

    const finalStat = await statAvatarImage(filePath, normalized);
    const finalStatSignature = avatarImageStatSignature(finalStat);
    if (initialStatSignature !== finalStatSignature || finalStat.size !== raw.length) {
        avatarImageVerificationCache.delete(cacheKey);
        throw avatarError('AVATAR_IMAGE_INVALID', 'Referenced avatar image changed while it was being verified', 422, {
            name: normalized.name,
            cause: 'file-changed-during-verification',
        });
    }
    avatarImageVerificationCache.set(cacheKey, { refSignature, statSignature: finalStatSignature });
    return normalized;
}

async function verifyAvatarManifestImages(manifest, imagesDir = IMAGES_DIR, options = {}) {
    const seen = options.session || new Map();
    for (const asset of manifest.assets) {
        for (const ref of [asset.image, asset.thumbnail]) {
            const normalized = validateAvatarImageRef(ref, 'Avatar image reference');
            const refSignature = avatarImageRefSignature(normalized);
            const existing = seen.get(normalized.name);
            if (existing) {
                if (existing.refSignature !== refSignature) {
                    throw avatarError('AVATAR_IMAGE_INVALID', 'The same avatar image name has conflicting metadata', 422, { name: normalized.name });
                }
                await existing.promise;
                continue;
            }
            const promise = verifyAvatarImageRef(normalized, imagesDir);
            seen.set(normalized.name, { refSignature, promise });
            await promise;
        }
    }
    return seen;
}

async function readAvatarDataset(filePath = AVATAR_DATA_FILE, imagesDir = IMAGES_DIR, options = {}) {
    let raw;
    try { raw = await fsp.readFile(filePath, 'utf8'); }
    catch (error) {
        if (error && error.code === 'ENOENT') return { state: 'empty', dataset: null };
        throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw avatarError('AVATAR_DATASET_INVALID', 'Avatar dataset JSON is invalid', 422, { cause: error.message }); }
    if (!isPlainObject(parsed) || parsed.schemaVersion !== AVATAR_SCHEMA_VERSION ||
        typeof parsed.datasetId !== 'string' || !/^[A-Za-z0-9._-]{8,128}$/.test(parsed.datasetId) ||
        !Number.isSafeInteger(parsed.revision) || parsed.revision < 1 || typeof parsed.fingerprint !== 'string') {
        throw avatarError('AVATAR_DATASET_INVALID', 'Avatar dataset header is invalid', 422);
    }
    const manifest = validateAvatarManifest(parsed.manifest);
    const fingerprint = manifestFingerprint(manifest);
    if (parsed.fingerprint !== fingerprint) throw avatarError('AVATAR_DATASET_INVALID', 'Avatar dataset fingerprint does not match its manifest', 422);
    if (options.verifyImages !== false) await verifyAvatarManifestImages(manifest, imagesDir);
    return {
        state: 'present',
        dataset: {
            schemaVersion: AVATAR_SCHEMA_VERSION,
            datasetId: parsed.datasetId,
            revision: parsed.revision,
            updatedAt: String(parsed.updatedAt || ''),
            fingerprint,
            manifest,
        },
    };
}

async function commitAvatarManifest(input, filePath = AVATAR_DATA_FILE, imagesDir = IMAGES_DIR) {
    if (!isPlainObject(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        typeof input.datasetId !== 'string' || !/^[A-Za-z0-9._-]{8,128}$/.test(input.datasetId)) {
        throw avatarError('AVATAR_COMMIT_INVALID', 'Avatar manifest commit header is invalid', 400);
    }
    const manifest = validateAvatarManifest(input.manifest);
    const current = await readAvatarDataset(filePath, imagesDir, { verifyImages: false });
    if (current.state === 'empty') {
        if (input.expectedRevision !== 0) {
            throw avatarError('AVATAR_REVISION_CONFLICT', 'Avatar revision conflict', 409, { datasetId: null, revision: 0 });
        }
    } else if (current.dataset.datasetId !== input.datasetId || current.dataset.revision !== input.expectedRevision) {
        throw avatarError('AVATAR_REVISION_CONFLICT', 'Avatar revision conflict', 409, {
            datasetId: current.dataset.datasetId,
            revision: current.dataset.revision,
        });
    }
    const verificationSession = new Map();
    if (current.state === 'present') {
        await verifyAvatarManifestImages(current.dataset.manifest, imagesDir, { session: verificationSession });
    }
    await verifyAvatarManifestImages(manifest, imagesDir, { session: verificationSession });
    const dataset = {
        schemaVersion: AVATAR_SCHEMA_VERSION,
        datasetId: input.datasetId,
        revision: input.expectedRevision + 1,
        updatedAt: new Date().toISOString(),
        fingerprint: manifestFingerprint(manifest),
        manifest,
    };
    await writeJsonAtomic(filePath, dataset);
    const verified = await readAvatarDataset(filePath, imagesDir, { verifyImages: false });
    if (verified.state !== 'present' || verified.dataset.datasetId !== dataset.datasetId ||
        verified.dataset.revision !== dataset.revision || verified.dataset.fingerprint !== dataset.fingerprint) {
        throw avatarError('AVATAR_DATASET_INVALID', 'Avatar dataset atomic write verification failed', 500);
    }
    return verified.dataset;
}

let storageWriteQueue = Promise.resolve();
function withStorageWriteLock(task) {
    const result = storageWriteQueue.then(task, task);
    storageWriteQueue = result.catch(() => {});
    return result;
}

function normalizeExpectedGcFiles(value) {
    if (!Array.isArray(value)) {
        throw avatarError('IMAGE_GC_CONFIRMATION_REQUIRED', 'A dry-run file list is required before image GC', 400);
    }
    const normalized = value.map(file => String(file || ''));
    if (normalized.some(file => !isValidImageName(file)) || new Set(normalized).size !== normalized.length) {
        throw avatarError('IMAGE_GC_CONFIRMATION_INVALID', 'The image GC confirmation list is invalid', 400);
    }
    return normalized.sort();
}

async function gcImages(dryRun, options = {}) {
    const dataFile = options.dataFile || DATA_FILE;
    const avatarDataFile = options.avatarDataFile || AVATAR_DATA_FILE;
    const imagesDir = options.imagesDir || IMAGES_DIR;
    const data = await readDataFile(dataFile);
    const refs = new Set();
    collectReferencedImages(data, refs);

    try {
        const avatarState = await readAvatarDataset(avatarDataFile, imagesDir);
        if (avatarState.state === 'present') collectAvatarReferencedImages(avatarState.dataset.manifest, refs);
    } catch (error) {
        throw avatarError('AVATAR_GC_BLOCKED', 'Avatar dataset is not valid; image GC was blocked', 409, { cause: error.code || error.message });
    }

    let files = [];
    try {
        files = await fsp.readdir(imagesDir);
    } catch (err) {
        if (err && err.code === 'ENOENT') return { kept: 0, removed: 0, bytes: 0, files: [] };
        throw err;
    }

    const now = Date.now();
    const removable = [];
    let removableBytes = 0;
    for (const file of files) {
        if (!isValidImageName(file) || refs.has(file)) continue;
        try {
            const stat = await fsp.stat(path.join(imagesDir, file));
            if (now - stat.mtimeMs >= GC_GRACE_MS) {
                removable.push(file);
                removableBytes += stat.size;
            }
        } catch { /* ignore files that disappeared during the scan */ }
    }
    removable.sort();
    if (!dryRun) {
        const expected = normalizeExpectedGcFiles(options.expectedFiles);
        if (expected.length !== removable.length || expected.some((file, index) => file !== removable[index])) {
            throw avatarError('IMAGE_GC_CHANGED', 'The image GC candidate list changed; scan again before deleting', 409, {
                expected: expected.length,
                current: removable.length,
            });
        }
        for (const file of removable) {
            await fsp.unlink(path.join(imagesDir, file));
        }
    }

    return { kept: refs.size, removed: removable.length, bytes: removableBytes, files: removable };
}

function statusPayload() {
    return {
        ok: true,
        version: 3,
        name: info.name,
        capabilities: {
            avatarStorage: {
                version: AVATAR_CAPABILITY_VERSION,
                manifestVersion: AVATAR_SCHEMA_VERSION,
                revisionCas: true,
                verifiedImageMetadata: true,
            },
            imageGarbageCollection: {
                version: 1,
                avatarAware: true,
                dryRun: true,
                exactCommit: true,
                graceMs: GC_GRACE_MS,
            },
        },
    };
}

async function init(router) {
    const express = require('express');
    router.use(express.json({ limit: '64mb' }));

    router.get('/status', (_req, res) => {
        res.json(statusPayload());
    });

    // Read only this user's themes. The host settings endpoint also reads every
    // preset and several unrelated directories, which makes library refresh costly.
    router.get('/themes', async (req, res) => {
        const directory = req.user && req.user.directories && req.user.directories.themes;
        if (!directory) return res.status(400).json({ ok: false, error: 'User theme directory unavailable' });
        try {
            const cacheKey = path.resolve(directory);
            const cached = themeInventoryCache.get(cacheKey);
            const now = Date.now();
            if (cached && now - cached.at < THEME_INVENTORY_CACHE_MS) {
                res.set('Cache-Control', 'no-store');
                res.set('X-Theme-Inventory-Cache', 'hit');
                return res.json({ themes: cached.themes });
            }
            const files = (await fsp.readdir(directory)).filter(file => path.extname(file) === '.json').sort();
            const themes = new Array(files.length);
            let cursor = 0;
            await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
                while (cursor < files.length) {
                    const index = cursor++;
                    try {
                        themes[index] = JSON.parse(await fsp.readFile(path.join(directory, files[index]), 'utf8'));
                    } catch (error) {
                        // Match the host inventory: omit invalid or disappearing files.
                        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
                    }
                }
            }));
            const result = themes.filter(theme => theme !== undefined);
            themeInventoryCache.set(cacheKey, { at: Date.now(), themes: result });
            res.set('Cache-Control', 'no-store');
            res.set('X-Theme-Inventory-Cache', 'miss');
            res.json({ themes: result });
        } catch (error) {
            console.error('[theme-manager] GET /themes failed:', error.message);
            res.status(500).json({ ok: false, error: 'Failed to read themes' });
        }
    });

    router.get('/backgrounds', async (req, res) => {
        const directory = req.user && req.user.directories && req.user.directories.backgrounds;
        if (!directory) return res.status(400).json({ error: 'User background directory unavailable' });
        try {
            // The picker only needs filenames, not animation metadata for every image.
            const entries = await fsp.readdir(directory, { withFileTypes: true });
            const mime = require('mime-types');
            const images = entries.filter(entry => {
                const type = entry.isFile() && mime.lookup(entry.name);
                return type && type.startsWith('image/');
            }).map(entry => entry.name).sort(Intl.Collator().compare);
            res.set('Cache-Control', 'no-store');
            res.json({ images });
        } catch (error) {
            res.status(500).json({ error: 'Failed to list backgrounds' });
        }
    });

    router.get('/data', async (_req, res) => {
        try {
            const data = await readDataFile();
            res.json({ ok: true, data: data || null });
        } catch (err) {
            console.error('[theme-manager] GET /data failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to read data' });
        }
    });

    router.put('/data', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
            }
            await withStorageWriteLock(async () => {
                await externalizeImages(body);
                await writeJsonAtomic(DATA_FILE, body);
            });
            res.json({ ok: true, data: body });
        } catch (err) {
            console.error('[theme-manager] PUT /data failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to write data' });
        }
    });

    router.get('/avatars/state', async (_req, res) => {
        try {
            const result = await readAvatarDataset();
            if (result.state === 'empty') {
                return res.json({ ok: true, state: 'empty', datasetId: null, revision: 0, manifest: null });
            }
            const dataset = result.dataset;
            res.json({
                ok: true,
                state: 'present',
                datasetId: dataset.datasetId,
                revision: dataset.revision,
                fingerprint: dataset.fingerprint,
                manifest: dataset.manifest,
            });
        } catch (error) {
            console.error('[theme-manager] GET /avatars/state failed:', error.message);
            res.status(error.status || 500).json({
                ok: false,
                state: error.status === 422 ? 'invalid' : 'error',
                error: error.code || 'AVATAR_STATE_READ_FAILED',
            });
        }
    });

    router.put('/avatars/manifest', async (req, res) => {
        try {
            const dataset = await withStorageWriteLock(() => commitAvatarManifest(req.body));
            res.json({
                ok: true,
                state: 'present',
                datasetId: dataset.datasetId,
                revision: dataset.revision,
                fingerprint: dataset.fingerprint,
                manifest: dataset.manifest,
            });
        } catch (error) {
            if (error.status !== 409) console.error('[theme-manager] PUT /avatars/manifest failed:', error.message);
            res.status(error.status || 500).json({
                ok: false,
                error: error.code || 'AVATAR_MANIFEST_WRITE_FAILED',
                current: error.details || null,
            });
        }
    });

    router.post('/images', async (req, res) => {
        try {
            const { dataUrl } = req.body || {};
            if (typeof dataUrl !== 'string' || !dataUrl) {
                return res.status(400).json({ ok: false, error: 'Missing dataUrl field' });
            }
            const stored = await storeBase64Image(dataUrl);
            if (!stored) {
                return res.status(400).json({ ok: false, error: 'Invalid image format. Allowed: jpg/png/webp/gif/bmp' });
            }
            res.json({ ok: true, image: stored, name: stored.name, url: stored.url });
        } catch (err) {
            console.error('[theme-manager] POST /images failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to store image' });
        }
    });

    router.post('/images/batch-fetch', async (req, res) => {
        try {
            const { urls } = req.body || {};
            if (!Array.isArray(urls)) return res.status(400).json({ ok: false, error: 'urls must be an array' });

            const images = {};
            for (const url of urls) {
                if (typeof url !== 'string' || !url.startsWith(IMAGE_URL_PREFIX) || images[url]) continue;
                const name = path.basename(url);
                const dataUrl = await imageToDataUrl(name);
                if (dataUrl) images[url] = dataUrl;
            }
            res.json({ ok: true, images });
        } catch (err) {
            console.error('[theme-manager] POST /images/batch-fetch failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to fetch images' });
        }
    });

    router.get('/images/:name', (req, res) => {
        const name = path.basename(req.params.name || '');
        if (!isValidImageName(name)) return res.status(400).json({ ok: false, error: 'Invalid image name' });

        const filePath = path.join(IMAGES_DIR, name);
        if (!filePath.startsWith(IMAGES_DIR + path.sep)) return res.status(403).json({ ok: false, error: 'Forbidden' });

        // Image names are content hashes; changed content receives a new URL.
        res.sendFile(filePath, { maxAge: '1y', immutable: true }, err => {
            if (!err) return;
            if (err.code === 'ENOENT') res.status(404).json({ ok: false, error: 'Not found' });
            else { try { res.status(500).end(); } catch { /* noop */ } }
        });
    });

    router.post('/gc', async (req, res) => {
        try {
            const dryRun = !!(req.body && req.body.dryRun);
            const expectedFiles = req.body && req.body.expectedFiles;
            if (!dryRun && !Array.isArray(expectedFiles)) {
                throw avatarError('IMAGE_GC_CONFIRMATION_REQUIRED', 'Run image GC in dry-run mode before deleting', 400);
            }
            const result = await withStorageWriteLock(() => gcImages(dryRun, { expectedFiles }));
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[theme-manager] POST /gc failed:', err.message);
            res.status(err.status || 500).json({ ok: false, error: err.code || 'Failed to gc images' });
        }
    });

    router.use((err, _req, res, _next) => {
        if (err.type === 'entity.too.large') {
            res.status(413).json({ ok: false, error: 'Data is too large. Export first or migrate in smaller batches.' });
        } else {
            console.error('[theme-manager] Unexpected error:', err.message);
            res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    });

    ensureDirsSync();
    console.log('[theme-manager] Plugin loaded. Data dir: ' + DATA_DIR);
}

async function exit() {
    // No cleanup needed.
}

module.exports = {
    init,
    exit,
    info,
    _test: {
        AVATAR_SCHEMA_VERSION,
        GC_GRACE_MS,
        stableStringify,
        manifestFingerprint,
        validateAvatarManifest,
        collectAvatarReferencedImages,
        normalizeExpectedGcFiles,
        gcImages,
        statusPayload,
        verifyAvatarImageRef,
        verifyAvatarManifestImages,
        readAvatarDataset,
        commitAvatarManifest,
        clearAvatarImageVerificationCache,
        resetAvatarImageVerificationStats,
        getAvatarImageVerificationStats,
    },
};
