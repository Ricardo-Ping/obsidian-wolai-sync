import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

const require = createRequire(import.meta.url);
export const runtimeDir = '.obsidian/plugins/test-wolai';

class TFile {
    constructor(path, content, mtime) {
        this.path = path;
        this.basename = posix.basename(path, posix.extname(path));
        this.extension = posix.extname(path).slice(1);
        this.stat = { size: Buffer.byteLength(content), mtime, ctime: mtime };
    }
}
class TFolder {
    constructor(path) { this.path = path; this.children = []; }
}

export class MemoryVault {
    files = new Map();
    contents = new Map();
    writes = [];
    clock = Date.now();
    constructor() {
        this.adapter = {
            exists: async path => this.files.has(path),
            mkdir: async path => this.folder(path),
            read: async path => this.readPath(path),
            write: async (path, text) => { this.seed(path, text); this.writes.push(path); },
            append: async (path, text) => { this.seed(path, this.readPath(path) + text); this.writes.push(path); },
            stat: async path => this.files.get(path)?.stat,
            remove: async path => { this.files.delete(path); this.contents.delete(path); },
            rename: async (from, to) => {
                if (!this.contents.has(from)) throw new Error(`Missing ${from}`);
                this.seed(to, this.readPath(from));
                this.files.delete(from); this.contents.delete(from);
            }
        };
    }
    seed(path, content) {
        const parent = posix.dirname(path);
        if (parent !== '.' && !this.files.has(parent)) this.folder(parent);
        const file = new TFile(path, content, ++this.clock);
        this.files.set(path, file);
        this.contents.set(path, content);
        this.attach(file);
        return file;
    }
    attach(file) {
        const parent = this.files.get(posix.dirname(file.path));
        if (parent instanceof TFolder) {
            parent.children = parent.children.filter(child => child.path !== file.path);
            parent.children.push(file);
        }
    }
    folder(path) {
        if (this.files.has(path)) return this.files.get(path);
        const parent = posix.dirname(path);
        if (parent !== '.' && !this.files.has(parent)) this.folder(parent);
        const folder = new TFolder(path);
        this.files.set(path, folder);
        this.attach(folder);
        return folder;
    }
    readPath(path) {
        if (!this.contents.has(path)) throw new Error(`Missing ${path}`);
        return this.contents.get(path);
    }
    getAbstractFileByPath(path) { return this.files.get(path) || null; }
    async read(file) { return this.readPath(file.path); }
    async modify(file, content) { this.seed(file.path, content); this.writes.push(file.path); }
    async create(path, content) {
        if (this.files.has(path)) throw new Error(`Already exists ${path}`);
        this.writes.push(path);
        return this.seed(path, content);
    }
    async createFolder(path) { return this.folder(path); }
    async trash() { throw new Error('Unexpected cleanup in regression test'); }
}

const built = buildSync({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: ['src/SyncManager.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent'
}).outputFiles[0].text;
const compiled = { exports: {} };
const silentConsole = { log() {}, warn() {}, error() {}, debug() {} };
const obsidian = {
    TFile, TFolder, Notice: class {}, normalizePath: path => posix.normalize(path),
    requestUrl: async () => { throw new Error('Unexpected image network request in regression test'); }
};
new Function('require', 'module', 'exports', 'console', 'window', built)(
    name => name === 'obsidian' ? obsidian : require(name), compiled, compiled.exports,
    silentConsole, { setTimeout, clearTimeout }
);
export const SyncManager = compiled.exports.SyncManager;

export async function createHarness({ state = {}, records = {}, pages = {}, resume, manifest = {} } = {}) {
    const vault = new MemoryVault();
    vault.folder('Wolai');
    vault.seed(`${runtimeDir}/wolai-incremental-state.json`, JSON.stringify(state));
    vault.seed(`${runtimeDir}/sync-records.json`, JSON.stringify(records));
    vault.seed(`${runtimeDir}/wolai-generated-files.json`, JSON.stringify(manifest));
    if (resume) vault.seed(`${runtimeDir}/wolai-resume-state.json`, JSON.stringify(resume));
    const manager = new SyncManager(vault, {
        obsidianFolder: 'Wolai', wolaiPages: 'Root | root', wolaiDatabaseId: 'database',
        wolaiAppId: '', wolaiAppSecret: '', safeCleanup: false,
        autoSync: false, enableFileWatcher: false, detailedLogging: false
    }, runtimeDir);
    const logs = [];
    manager.writeSyncLog = async (level, message) => { logs.push({ level, message }); };
    manager.waitForSyncDelay = async () => {};
    await manager.syncRecordsReady;
    const requests = [];
    manager.wolaiAPI = {
        validateConnection: async () => true,
        getAllDatabaseContent: async () => [],
        getBlockMetadata: async id => {
            requests.push(`metadata:${id}`);
            if (!pages[id] || pages[id].error) throw new Error(pages[id]?.error || `Unknown page ${id}`);
            return { id, version: 2, edited_at: 200, ...pages[id].metadata };
        },
        getAllPageBlocks: async (id, options = {}) => {
            requests.push(`blocks:${id}`);
            if (!pages[id] || pages[id].error) throw new Error(pages[id]?.error || `Unknown page ${id}`);
            if (pages[id].legacyBlocks) options.onLegacyPagination?.(structuredClone(pages[id].legacyBlocks));
            return structuredClone(pages[id].blocks);
        },
        replacePageContent: async () => { throw new Error('Unexpected Wolai write in regression test'); },
        clearPageReadCheckpoint: async () => {},
        cancelPendingRequests() {}
    };
    return { manager, vault, logs, requests, pages };
}

export function legacyState(overrides = {}) {
    return {
        filePath: 'Wolai/Root.md', title: 'Root', relativeDir: '',
        remoteVersion: 1, remoteEditedAt: 100, fingerprint: 'old',
        children: [], images: {}, ...overrides
    };
}

export async function syncPage(harness, previousState, resume) {
    const nextState = {};
    const changes = new Set();
    const success = await harness.manager.createOrUpdateObsidianFile(
        { page_id: 'root', data: { '标题': { value: 'Root' } } },
        new Set(), '', new Set(), 'incremental', previousState, nextState, changes, undefined, resume
    );
    return { success, nextState, changes };
}
