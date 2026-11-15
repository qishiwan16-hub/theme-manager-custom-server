'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const api = require('../index.js')._test;

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theme-mgr-avatar-'));
    const imagesDir = path.join(root, 'images');
    const filePath = path.join(root, 'avatar-manifest.json');
    await fs.mkdir(imagesDir, { recursive: true });
    return { root, imagesDir, filePath };
}

async function imageRef(imagesDir, text, ext = 'png') {
    const raw = Buffer.from(text);
    const name = crypto.createHash('sha1').update(raw).digest('hex') + '.' + ext;
    await fs.writeFile(path.join(imagesDir, name), raw);
    return {
        name,
        url: '/api/plugins/theme-manager/images/' + name,
        sha256: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex'),
        bytes: raw.length,
        mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext),
    };
}

async function manifest(imagesDir) {
    const image = await imageRef(imagesDir, 'main-image');
    const thumbnail = await imageRef(imagesDir, 'thumbnail-image');
    return {
        schemaVersion: 1,
        assets: [{
            version: 1,
            id: 'avatar-a',
            name: 'Avatar A',
            mimeType: 'image/png',
            width: 512,
            height: 512,
            createdAt: '2026-09-06T00:00:00.000Z',
            updatedAt: '2026-09-06T00:00:00.000Z',
            image,
            thumbnail,
        }],
        bindings: [{
            version: 4,
            id: 'avatar-default\u001fuser:global',
            themeKey: 'avatar-default',
            targetKey: 'user:global',
            avatarId: 'avatar-a',
            view: { x: 0, y: 0, scale: 1, rotate: 0, flipX: false, flipY: false },
            updatedAt: '2026-09-06T00:00:00.000Z',
        }],
        nativeViews: [],
        sourceIntents: [],
    };
}

test('absent avatar dataset is explicitly empty', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    assert.deepEqual(await api.readAvatarDataset(f.filePath, f.imagesDir), { state: 'empty', dataset: null });
});

test('initial manifest commit is CAS revision 0 and reads back verified revision 1', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const input = { expectedRevision: 0, datasetId: 'dataset-test-a', manifest: await manifest(f.imagesDir) };
    const committed = await api.commitAvatarManifest(input, f.filePath, f.imagesDir);
    assert.equal(committed.datasetId, input.datasetId);
    assert.equal(committed.revision, 1);
    assert.equal(committed.fingerprint, api.manifestFingerprint(input.manifest));
    const read = await api.readAvatarDataset(f.filePath, f.imagesDir);
    assert.equal(read.state, 'present');
    assert.equal(read.dataset.revision, 1);
});

test('stale revision and dataset identity conflicts never overwrite the current dataset', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const first = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: first }, f.filePath, f.imagesDir);
    const changed = JSON.parse(JSON.stringify(first));
    changed.assets[0].name = 'Must not win';
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: changed }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_REVISION_CONFLICT' && error.status === 409
    );
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 1, datasetId: 'dataset-other', manifest: changed }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_REVISION_CONFLICT' && error.status === 409
    );
    const current = await api.readAvatarDataset(f.filePath, f.imagesDir);
    assert.equal(current.dataset.manifest.assets[0].name, 'Avatar A');
    assert.equal(current.dataset.revision, 1);
});

test('manifest validation rejects dangling bindings before any formal write', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const invalid = await manifest(f.imagesDir);
    invalid.bindings[0].avatarId = 'missing-avatar';
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: invalid }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_MANIFEST_INVALID' && error.status === 422
    );
    assert.equal((await api.readAvatarDataset(f.filePath, f.imagesDir)).state, 'empty');
});

test('manifest validation rejects non-canonical records before any formal write', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const invalid = await manifest(f.imagesDir);
    delete invalid.bindings[0].updatedAt;
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: invalid }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_MANIFEST_INVALID' && error.status === 422
    );
    assert.equal((await api.readAvatarDataset(f.filePath, f.imagesDir)).state, 'empty');
});

test('manifest commit rejects a missing or metadata-mismatched image', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const missing = await manifest(f.imagesDir);
    await fs.unlink(path.join(f.imagesDir, missing.assets[0].image.name));
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: missing }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_IMAGE_MISSING' && error.status === 422
    );

    const mismatched = await manifest(f.imagesDir);
    mismatched.assets[0].thumbnail.bytes += 1;
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: mismatched }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_IMAGE_INVALID' && error.status === 422
    );
});

test('avatar references are included in the GC reference set', async () => {
    const refs = new Set();
    api.collectAvatarReferencedImages({ assets: [
        { image: { name: '0123456789012345678901234567890123456789.png' }, thumbnail: { name: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd.webp' } },
    ] }, refs);
    assert.deepEqual([...refs].sort(), [
        '0123456789012345678901234567890123456789.png',
        'abcdefabcdefabcdefabcdefabcdefabcdefabcd.webp',
    ]);
});

test('status advertises avatar-aware exact-confirmation image GC', () => {
    const status = api.statusPayload();
    assert.equal(status.version, 3);
    assert.deepEqual(status.capabilities.imageGarbageCollection, {
        version: 1,
        avatarAware: true,
        dryRun: true,
        exactCommit: true,
        graceMs: api.GC_GRACE_MS,
    });
});

test('GC keeps formal avatar references and removes only an old unreferenced image', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const currentManifest = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: currentManifest }, f.filePath, f.imagesDir);
    const themeImage = await imageRef(f.imagesDir, 'theme-preview-image');
    const dataFile = path.join(f.root, 'theme-manager.json');
    await fs.writeFile(dataFile, JSON.stringify({
        themeMeta: { Example: { imageData: '/api/plugins/theme-manager/images/' + themeImage.name } },
    }), 'utf8');
    const youngOrphan = await imageRef(f.imagesDir, 'young-orphan-image');
    const orphan = await imageRef(f.imagesDir, 'old-orphan-image');
    const old = new Date(Date.now() - api.GC_GRACE_MS - 60_000);
    await fs.utimes(path.join(f.imagesDir, orphan.name), old, old);
    const scan = await api.gcImages(true, {
        dataFile,
        avatarDataFile: f.filePath,
        imagesDir: f.imagesDir,
    });
    assert.equal(scan.bytes, Buffer.byteLength('old-orphan-image'));
    const result = await api.gcImages(false, {
        dataFile,
        avatarDataFile: f.filePath,
        imagesDir: f.imagesDir,
        expectedFiles: scan.files,
    });
    assert.equal(result.removed, 1);
    assert.equal(result.bytes, scan.bytes);
    assert.deepEqual(result.files, [orphan.name]);
    await fs.access(path.join(f.imagesDir, currentManifest.assets[0].image.name));
    await fs.access(path.join(f.imagesDir, currentManifest.assets[0].thumbnail.name));
    await fs.access(path.join(f.imagesDir, themeImage.name));
    await fs.access(path.join(f.imagesDir, youngOrphan.name));
    await assert.rejects(fs.access(path.join(f.imagesDir, orphan.name)));
});

test('GC refuses deletion when the confirmed orphan list changes', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const first = await imageRef(f.imagesDir, 'first-old-orphan');
    const old = new Date(Date.now() - api.GC_GRACE_MS - 60_000);
    await fs.utimes(path.join(f.imagesDir, first.name), old, old);
    const scan = await api.gcImages(true, {
        dataFile: path.join(f.root, 'theme-manager.json'),
        avatarDataFile: f.filePath,
        imagesDir: f.imagesDir,
    });
    const second = await imageRef(f.imagesDir, 'second-old-orphan');
    await fs.utimes(path.join(f.imagesDir, second.name), old, old);
    await assert.rejects(
        api.gcImages(false, {
            dataFile: path.join(f.root, 'theme-manager.json'),
            avatarDataFile: f.filePath,
            imagesDir: f.imagesDir,
            expectedFiles: scan.files,
        }),
        error => error.code === 'IMAGE_GC_CHANGED' && error.status === 409
    );
    await fs.access(path.join(f.imagesDir, first.name));
    await fs.access(path.join(f.imagesDir, second.name));
});

test('binding-only commit reuses verified image blobs and advances one revision', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    api.clearAvatarImageVerificationCache();
    const initial = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: initial }, f.filePath, f.imagesDir);

    const changed = JSON.parse(JSON.stringify(initial));
    changed.bindings[0].view.x = 1;
    changed.bindings[0].updatedAt = '2026-09-06T00:01:00.000Z';
    api.resetAvatarImageVerificationStats();
    const committed = await api.commitAvatarManifest({
        expectedRevision: 1,
        datasetId: 'dataset-test-a',
        manifest: changed,
    }, f.filePath, f.imagesDir);

    const stats = api.getAvatarImageVerificationStats();
    assert.equal(committed.revision, 2);
    assert.equal(stats.hashCalls, 0);
    assert.equal(stats.bytesHashed, 0);
    assert.equal(stats.statCalls, 2);
});

test('adding one asset hashes only its new image and thumbnail', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    api.clearAvatarImageVerificationCache();
    const initial = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: initial }, f.filePath, f.imagesDir);

    const changed = JSON.parse(JSON.stringify(initial));
    const added = JSON.parse(JSON.stringify(changed.assets[0]));
    added.id = 'avatar-b';
    added.name = 'Avatar B';
    added.image = await imageRef(f.imagesDir, 'second-main-image');
    added.thumbnail = await imageRef(f.imagesDir, 'second-thumbnail-image');
    changed.assets.push(added);
    api.resetAvatarImageVerificationStats();
    await api.commitAvatarManifest({ expectedRevision: 1, datasetId: 'dataset-test-a', manifest: changed }, f.filePath, f.imagesDir);

    const stats = api.getAvatarImageVerificationStats();
    assert.equal(stats.hashCalls, 2);
    assert.equal(stats.bytesHashed, added.image.bytes + added.thumbnail.bytes);
});

test('external image modification and deletion invalidate trusted cache entries', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    api.clearAvatarImageVerificationCache();
    const current = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: current }, f.filePath, f.imagesDir);

    const imagePath = path.join(f.imagesDir, current.assets[0].image.name);
    await fs.writeFile(imagePath, Buffer.from('evil-image'));
    const changedTime = new Date(Date.now() + 60_000);
    await fs.utimes(imagePath, changedTime, changedTime);
    await assert.rejects(
        api.readAvatarDataset(f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_IMAGE_INVALID'
    );

    await fs.writeFile(imagePath, Buffer.from('main-image'));
    await fs.utimes(imagePath, new Date(), new Date());
    await api.readAvatarDataset(f.filePath, f.imagesDir);
    await fs.unlink(path.join(f.imagesDir, current.assets[0].thumbnail.name));
    await assert.rejects(
        api.readAvatarDataset(f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_IMAGE_MISSING'
    );
});

test('server restart cache miss fully verifies once and later reads avoid rehashing', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    api.clearAvatarImageVerificationCache();
    const current = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: current }, f.filePath, f.imagesDir);

    api.clearAvatarImageVerificationCache();
    api.resetAvatarImageVerificationStats();
    await api.readAvatarDataset(f.filePath, f.imagesDir);
    assert.equal(api.getAvatarImageVerificationStats().hashCalls, 2);

    api.resetAvatarImageVerificationStats();
    await api.readAvatarDataset(f.filePath, f.imagesDir);
    assert.equal(api.getAvatarImageVerificationStats().hashCalls, 0);
    assert.equal(api.getAvatarImageVerificationStats().statCalls, 2);
});

test('CAS conflict is rejected before any image stat or hash work', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    api.clearAvatarImageVerificationCache();
    const current = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: current }, f.filePath, f.imagesDir);

    api.clearAvatarImageVerificationCache();
    api.resetAvatarImageVerificationStats();
    await assert.rejects(
        api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: current }, f.filePath, f.imagesDir),
        error => error.code === 'AVATAR_REVISION_CONFLICT' && error.status === 409
    );
    assert.deepEqual(api.getAvatarImageVerificationStats(), {
        statCalls: 0,
        hashCalls: 0,
        bytesHashed: 0,
        cacheEntries: 0,
    });
});

test('GC remains blocked when a referenced avatar image changes externally', async t => {
    const f = await fixture();
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    api.clearAvatarImageVerificationCache();
    const current = await manifest(f.imagesDir);
    await api.commitAvatarManifest({ expectedRevision: 0, datasetId: 'dataset-test-a', manifest: current }, f.filePath, f.imagesDir);
    const imagePath = path.join(f.imagesDir, current.assets[0].image.name);
    await fs.writeFile(imagePath, Buffer.from('evil-image'));
    const changedTime = new Date(Date.now() + 60_000);
    await fs.utimes(imagePath, changedTime, changedTime);

    await assert.rejects(
        api.gcImages(true, {
            dataFile: path.join(f.root, 'theme-manager.json'),
            avatarDataFile: f.filePath,
            imagesDir: f.imagesDir,
        }),
        error => error.code === 'AVATAR_GC_BLOCKED' && error.status === 409
    );
});
