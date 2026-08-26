import { Vault, TFile, Notice, TFolder, normalizePath, requestUrl } from 'obsidian';
import { WolaiAPI, WolaiDatabaseRowData, APICallStats } from './WolaiAPI';
import { MarkdownParser } from './MarkdownParser';
import { WolaiSyncSettings, SyncRecord, SyncStatus } from './types';
import matter from 'gray-matter';

type SyncMode = 'full' | 'incremental';
export type SyncResultStatus = 'completed' | 'cancelled' | 'no_changes' | 'busy' | 'failed';
export interface SyncResult {
    obsidianToWolai: number;
    wolaiToObsidian: number;
    status: SyncResultStatus;
}
interface WolaiPageSyncState {
    fingerprint: string;
    filePath: string;
    title: string;
    relativeDir: string;
    remoteVersion: number;
    remoteEditedAt: number;
    converterVersion?: number;
    children: Array<{ pageId: string; title: string; relativeDir: string }>;
    images: Record<string, { version: number; editedAt: number; path: string }>;
}
type WolaiIncrementalState = Record<string, WolaiPageSyncState>;
interface PageProgressContext {
    seen: Set<string>;
    total: number;
    completed: number;
    mode: SyncMode;
    lastPercent: number;
}

export class SyncManager {
    private readonly converterVersion = 2;
    private progressListeners = new Set<(percent: number, message: string) => void>();
    private logListeners = new Set<(line: string) => void>();
    private apiStatsListeners = new Set<(stats: APICallStats) => void>();
    private currentProgress = 0;
    private metadataRequestsActive = 0;
    private metadataRequestWaiters: Array<() => void> = [];
    private readonly generatedManifestPath: string;
    private readonly incrementalStatePath: string;
    private readonly syncLogPath: string;
    private readonly maxLogSize = 2 * 1024 * 1024;
    private readonly apiQuotaPath: string;
    private logWriteQueue: Promise<void> = Promise.resolve();
    private apiQuotaQueue: Promise<void> = Promise.resolve();
    private apiQuotaLoaded = false;
    private apiRequestTimestamps: number[] = [];
    private apiTotalRequests = 0;
    private apiTodayRequests = 0;
    private apiStatsDay = new Date().setHours(0, 0, 0, 0);
    private syncActive = false;
    private syncPaused = false;
    private cancelRequested = false;
    private pauseWaiters: Array<() => void> = [];
    private cancelWaiters: Array<() => void> = [];
    private vault: Vault;
    private wolaiAPI: WolaiAPI;
    public markdownParser: MarkdownParser;
    private settings: WolaiSyncSettings;
    private syncRecords: Map<string, SyncRecord> = new Map();
    private readonly dataFilePath: string;
    private syncingFiles: Set<string> = new Set(); // 正在同步的文件集合

    constructor(
        vault: Vault,
        settings: WolaiSyncSettings,
        pluginDirectory: string
    ) {
        this.vault = vault;
        this.settings = settings;
        const runtimeDirectory = normalizePath(pluginDirectory);
        this.generatedManifestPath = normalizePath(`${runtimeDirectory}/wolai-generated-files.json`);
        this.incrementalStatePath = normalizePath(`${runtimeDirectory}/wolai-incremental-state.json`);
        this.syncLogPath = normalizePath(`${runtimeDirectory}/sync.log`);
        this.apiQuotaPath = normalizePath(`${runtimeDirectory}/wolai-api-quota.json`);
        this.dataFilePath = normalizePath(`${runtimeDirectory}/sync-records.json`);
        this.wolaiAPI = this.createWolaiAPI(settings);
        this.markdownParser = new MarkdownParser();
        void this.loadApiQuota();

        // 加载同步记录
        this.loadSyncRecords();
    }

    addProgressListener(listener: (percent: number, message: string) => void): () => void {
        this.progressListeners.add(listener);
        return () => this.progressListeners.delete(listener);
    }

    addLogListener(listener: (line: string) => void): () => void {
        this.logListeners.add(listener);
        return () => this.logListeners.delete(listener);
    }

    addApiStatsListener(listener: (stats: APICallStats) => void): () => void {
        this.apiStatsListeners.add(listener);
        listener(this.getAPICallStats());
        return () => this.apiStatsListeners.delete(listener);
    }

    private notifyApiStats(): void {
        const stats = this.getAPICallStats();
        for (const listener of this.apiStatsListeners) listener(stats);
    }

    private reportProgress(percent: number, message: string): void {
        const value = Math.max(0, Math.min(100, Math.round(percent)));
        this.currentProgress = value;
        for (const listener of this.progressListeners) listener(value, message);
        void this.writeSyncLog('INFO', `${value}% ${message}`);
    }

    private createWolaiAPI(settings: WolaiSyncSettings): WolaiAPI {
        return new WolaiAPI(settings.wolaiAppId, settings.wolaiAppSecret,
            (level, message) => {
                void this.writeSyncLog(level, message);
                if (level === 'WARN' && message.includes('HTTP 429')) {
                    const seconds = Math.max(1, Math.ceil((Number(message.match(/(\d+)ms/)?.[1]) || 1000) / 1000));
                    for (const listener of this.progressListeners) {
                        listener(this.currentProgress, `Wolai API 限流，等待 ${seconds} 秒后重试`);
                    }
                }
            }, () => this.waitForApiPermission(),
            () => settings.slowSync ? 60 * 60 * 1000 : null);
    }

    private async loadApiQuota(): Promise<void> {
        if (this.apiQuotaLoaded) return;
        this.apiQuotaLoaded = true;
        try {
            if (await this.vault.adapter.exists(this.apiQuotaPath)) {
                const data = JSON.parse(await this.vault.adapter.read(this.apiQuotaPath));
                this.apiRequestTimestamps = Array.isArray(data.timestamps)
                    ? data.timestamps.filter((value: unknown) => typeof value === 'number') : [];
                this.apiTotalRequests = Number(data.total || 0);
                this.apiTodayRequests = Number(data.today || 0);
                this.apiStatsDay = Number(data.day || this.apiStatsDay);
                this.resetDailyApiStatsIfNeeded();
            }
        } catch (error) {
            this.apiRequestTimestamps = [];
            void this.writeSyncLog('WARN', `无法读取 API 额度记录：${String(error)}`);
        } finally {
            this.notifyApiStats();
        }
    }

    private async waitForApiPermission(): Promise<void> {
        await this.waitIfPaused();

        let release!: () => void;
        const previous = this.apiQuotaQueue;
        this.apiQuotaQueue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            await this.loadApiQuota();
            const limit = Math.max(1, Number(this.settings.hourlyApiLimit) || 10);
            for (;;) {
                await this.waitIfPaused();
                const now = Date.now();
                this.apiRequestTimestamps = this.apiRequestTimestamps.filter(timestamp => now - timestamp < 60 * 60 * 1000);
                if (!this.settings.slowSync || this.apiRequestTimestamps.length < limit) {
                    this.apiRequestTimestamps.push(now);
                    this.resetDailyApiStatsIfNeeded();
                this.apiTotalRequests++;
                this.apiTodayRequests++;
                await this.saveApiQuota();
                this.notifyApiStats();
                return;
                }

                const resumeAt = this.apiRequestTimestamps[0] + 60 * 60 * 1000 + 1000;
                const remaining = Math.max(1000, resumeAt - now);
                const minutes = Math.max(1, Math.ceil(remaining / 60000));
                const message = `慢速同步：已达每小时 ${limit} 次 API 额度，约 ${minutes} 分钟后继续`;
                this.reportProgress(this.currentProgress, message);
                await this.waitForSyncDelay(Math.min(remaining, 60000));
            }
        } finally {
            release();
        }
    }

    private resetDailyApiStatsIfNeeded(): void {
        const today = new Date().setHours(0, 0, 0, 0);
        if (today > this.apiStatsDay) {
            this.apiTodayRequests = 0;
            this.apiStatsDay = today;
        }
    }

    private async saveApiQuota(): Promise<void> {
        await this.vault.adapter.write(this.apiQuotaPath, JSON.stringify({
            timestamps: this.apiRequestTimestamps,
            total: this.apiTotalRequests,
            today: this.apiTodayRequests,
            day: this.apiStatsDay
        }, null, 2));
    }

    isSyncActive(): boolean {
        return this.syncActive;
    }

    isSyncPaused(): boolean {
        return this.syncPaused;
    }

    pauseSync(): boolean {
        if (!this.syncActive || this.syncPaused) return false;
        this.syncPaused = true;
        this.reportProgress(this.currentProgress, '同步已暂停，等待继续');
        return true;
    }

    resumeSync(): boolean {
        if (!this.syncPaused) return false;
        this.syncPaused = false;
        const waiters = this.pauseWaiters.splice(0);
        for (const resolve of waiters) resolve();
        this.reportProgress(this.currentProgress, '同步已继续');
        return true;
    }

    cancelSync(reason = '用户取消'): boolean {
        const wasActive = this.syncActive;
        this.cancelRequested = wasActive;
        this.syncPaused = false;
        for (const resolve of this.pauseWaiters.splice(0)) resolve();
        for (const cancel of this.cancelWaiters.splice(0)) cancel();
        this.wolaiAPI.cancelPendingRequests();
        if (wasActive) this.reportProgress(this.currentProgress, `同步已取消：${reason}`);
        return wasActive;
    }

    private async waitIfPaused(): Promise<void> {
        if (this.cancelRequested) throw new Error('WOLAI_SYNC_CANCELLED');
        if (!this.syncPaused) return;
        await new Promise<void>(resolve => this.pauseWaiters.push(resolve));
        if (this.cancelRequested) throw new Error('WOLAI_SYNC_CANCELLED');
    }

    private async waitForSyncDelay(delay: number): Promise<void> {
        if (this.cancelRequested) throw new Error('WOLAI_SYNC_CANCELLED');
        await new Promise<void>((resolve, reject) => {
            const cancel = (): void => {
                window.clearTimeout(timer);
                reject(new Error('WOLAI_SYNC_CANCELLED'));
            };
            const timer = window.setTimeout(() => {
                const index = this.cancelWaiters.indexOf(cancel);
                if (index >= 0) this.cancelWaiters.splice(index, 1);
                resolve();
            }, delay);
            this.cancelWaiters.push(cancel);
        });
    }

    private isCancellationError(error: unknown): boolean {
        return String(error).includes('WOLAI_SYNC_CANCELLED') ||
            (error instanceof DOMException && error.name === 'AbortError');
    }

    private writeSyncLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
        const safeMessage = message.replace(/[\r\n]+/g, ' ');
        const line = `[${new Date().toISOString()}] [${level}] ${safeMessage}\n`;
        for (const listener of this.logListeners) listener(line);
        this.logWriteQueue = this.logWriteQueue
            .catch(() => undefined)
            .then(async () => {
                if (await this.vault.adapter.exists(this.syncLogPath)) {
                    const stat = await this.vault.adapter.stat(this.syncLogPath);
                    if (stat && stat.size >= this.maxLogSize) await this.rotateSyncLogs();
                }
                if (await this.vault.adapter.exists(this.syncLogPath)) {
                    await this.vault.adapter.append(this.syncLogPath, line);
                } else {
                    await this.vault.adapter.write(this.syncLogPath, line);
                }
            })
            .catch(error => console.error('Failed to write Wolai sync log:', error));
        return this.logWriteQueue;
    }

    private async rotateSyncLogs(): Promise<void> {
        for (let index = 3; index >= 1; index--) {
            const source = index === 1 ? this.syncLogPath : `${this.syncLogPath}.${index - 1}`;
            const target = `${this.syncLogPath}.${index}`;
            if (!await this.vault.adapter.exists(source)) continue;
            if (await this.vault.adapter.exists(target)) await this.vault.adapter.remove(target);
            await this.vault.adapter.rename(source, target);
        }
    }

    private debugLog(message: string, value?: unknown): void {
        if (!this.settings.detailedLogging) return;
        value === undefined ? console.debug(message) : console.debug(message, value);
    }

    async getSyncLog(): Promise<string> {
        await this.logWriteQueue.catch(() => undefined);
        if (!await this.vault.adapter.exists(this.syncLogPath)) return '';
        return await this.vault.adapter.read(this.syncLogPath);
    }

    async clearSyncLog(): Promise<void> {
        await this.logWriteQueue.catch(() => undefined);
        await this.vault.adapter.write(this.syncLogPath, '');
        await this.writeSyncLog('INFO', '同步日志已清空');
    }

    getSyncLogPath(): string {
        return this.syncLogPath;
    }

    private async loadIncrementalState(): Promise<WolaiIncrementalState> {
        try {
            if (await this.vault.adapter.exists(this.incrementalStatePath)) {
                return JSON.parse(await this.vault.adapter.read(this.incrementalStatePath));
            }
        } catch (error) {
            console.error('Failed to read Wolai incremental state:', error);
        }
        return {};
    }

    private async saveIncrementalState(state: WolaiIncrementalState): Promise<void> {
        await this.vault.adapter.write(this.incrementalStatePath, JSON.stringify(state, null, 2));
    }

    /**
     * Persist successfully completed pages without committing deletions from an
     * unfinished tree.  If the run is paused or fails, the next incremental run
     * can reuse these entries; a fully successful run later replaces this merged
     * checkpoint with the authoritative nextState.
     */
    private async saveIncrementalCheckpoint(
        previousState: WolaiIncrementalState,
        nextState: WolaiIncrementalState
    ): Promise<void> {
        await this.saveIncrementalState({ ...previousState, ...nextState });
    }

    private createPageFingerprint(blocks: any[]): string {
        const snapshot = blocks.map(block => ({
            id: block.id,
            type: block.type,
            version: block.version || 0,
            editedAt: block.edited_at || 0,
            content: block.content,
            level: block.level,
            parentBlockId: block.parentBlockId
        }));
        return this.markdownParser.createHash(JSON.stringify(snapshot));
    }

    private registerPageProgress(context: PageProgressContext | undefined, pageId: string): void {
        if (!context || context.seen.has(pageId)) return;
        context.seen.add(pageId);
        context.total++;
    }

    private reportPageProgress(context: PageProgressContext | undefined, pageName: string, relativeDir: string): void {
        if (!context) return;
        const current = Math.min(context.completed + 1, Math.max(1, context.total));
        const percent = Math.max(context.lastPercent,
            70 + (context.completed / Math.max(1, context.total)) * 25);
        context.lastPercent = percent;
        const pagePath = [relativeDir, pageName].filter(Boolean).join(' / ');
        this.reportProgress(percent,
            `${context.mode === 'incremental' ? '正在快速检查' : '正在同步'}页面 ${current}/${context.total}：${pagePath}`);
    }

    private completePageProgress(context: PageProgressContext | undefined): void {
        if (!context) return;
        context.completed++;
    }

    private async getPageMetadataLimited(pageId: string): Promise<any> {
        if (this.metadataRequestsActive >= 3) {
            await new Promise<void>(resolve => this.metadataRequestWaiters.push(resolve));
        }
        this.metadataRequestsActive++;
        try {
            return await this.wolaiAPI.getBlockMetadata(pageId);
        } finally {
            this.metadataRequestsActive--;
            this.metadataRequestWaiters.shift()?.();
        }
    }

    updateSettings(settings: WolaiSyncSettings): void {
        // Never leave the previous API instance's retry timers or fetches alive
        // after settings are saved.
        this.wolaiAPI.cancelPendingRequests();
        this.settings = settings;
        this.wolaiAPI = this.createWolaiAPI(settings);
    }

    getAPICallStats(): APICallStats {
        this.resetDailyApiStatsIfNeeded();
        const now = Date.now();
        this.apiRequestTimestamps = this.apiRequestTimestamps
            .filter(timestamp => now - timestamp < 60 * 60 * 1000);
        return {
            total: this.apiTotalRequests,
            today: this.apiTodayRequests,
            lastReset: this.apiStatsDay,
            hourly: this.apiRequestTimestamps.length,
            hourlyLimit: Math.max(1, Number(this.settings.hourlyApiLimit) || 10)
        };
    }

    resetAPICallStats(): void {
        this.apiTotalRequests = 0;
        this.apiTodayRequests = 0;
        this.apiStatsDay = new Date().setHours(0, 0, 0, 0);
        void this.saveApiQuota();
        this.notifyApiStats();
    }

    private async findImportedFileByWolaiId(pageId: string): Promise<{ file: TFile; lastSync: number } | null> {
        const paths = await this.getAllFilesInFolder();
        for (const path of paths) {
            const file = this.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;
            const parsed = this.markdownParser.parseMarkdown(await this.vault.read(file));
            if (parsed.frontMatter.wolai_id === pageId) {
                return { file, lastSync: Date.parse(parsed.frontMatter.last_sync || '') || 0 };
            }
        }
        return null;
    }

    private async loadSyncRecords(): Promise<void> {
        try {
            // 检查数据文件是否存在
            const dataFile = this.vault.getAbstractFileByPath(this.dataFilePath);
            if (!dataFile || !(dataFile instanceof TFile)) {
                console.log('Sync records file not found, starting with empty records');
                return;
            }

            // 读取并解析同步记录
            const content = await this.vault.read(dataFile);
            const recordsData = JSON.parse(content);

            // 将数据转换为Map
            this.syncRecords = new Map();
            for (const [filePath, record] of Object.entries(recordsData)) {
                this.syncRecords.set(filePath, record as SyncRecord);
            }

            console.log(`Loaded ${this.syncRecords.size} sync records`);
        } catch (error) {
            console.error('Error loading sync records:', error);
            this.syncRecords = new Map();
        }
    }

    private async saveSyncRecords(): Promise<void> {
        try {
            // 将Map转换为普通对象
            const recordsData: { [key: string]: SyncRecord } = {};
            for (const [filePath, record] of this.syncRecords) {
                recordsData[filePath] = record;
            }

            // 序列化为JSON
            const content = JSON.stringify(recordsData, null, 2);

            // 检查数据文件是否存在
            const dataFile = this.vault.getAbstractFileByPath(this.dataFilePath);
            if (dataFile && dataFile instanceof TFile) {
                // 更新现有文件
                await this.vault.modify(dataFile, content);
            } else {
                // 创建新文件
                await this.vault.create(this.dataFilePath, content);
            }

            console.log(`Saved ${this.syncRecords.size} sync records`);
        } catch (error) {
            console.error('Error saving sync records:', error);
        }
    }

    private async syncObsidianToWolai(filePath: string): Promise<boolean> {
        try {
            // 检查文件是否正在同步中
            if (this.syncingFiles.has(filePath)) {
                console.log(`File ${filePath} is already being synced, skipping...`);
                return true;
            }

            // 添加到正在同步的文件集合
            this.syncingFiles.add(filePath);

            console.log(`Starting Obsidian→Wolai sync for file: ${filePath}`);

            // 获取文件
            const file = this.vault.getAbstractFileByPath(filePath) as TFile;
            if (!file || !(file instanceof TFile)) {
                console.error(`File not found: ${filePath}`);
                return false;
            }

            // 读取文件内容
            const content = await this.vault.read(file);
            const parsedMarkdown = this.markdownParser.parseMarkdown(content);

            // 检查同步状态
            if (!this.markdownParser.needsSync(parsedMarkdown.frontMatter)) {
                console.log(`File ${filePath} doesn't need sync (status: ${parsedMarkdown.frontMatter.sync_status})`);
                return true;
            }

            console.log(`Parsing markdown content, found ${parsedMarkdown.blocks.length} blocks`);
            this.debugLog('Blocks to be created:', parsedMarkdown.blocks);

            // 解析并准备数据
            const fileName = file.basename;
            const title = this.markdownParser.extractTitle(parsedMarkdown.frontMatter, fileName);

            const rowData = {
                ...parsedMarkdown.frontMatter,
                '标题': title,
                '文件名': fileName,
                '文件路径': filePath,
                '同步时间': new Date().toISOString(),
                '同步状态': 'Synced'
            };

            this.debugLog('Row data to be inserted:', rowData);

            // 插入数据库行并获取页面ID
            const pageId = await this.wolaiAPI.insertDatabaseRowAndGetPageId(
                this.settings.wolaiDatabaseId,
                rowData
            );

            if (!pageId) {
                console.error(`Failed to insert database row for file: ${filePath}`);
                return false;
            }

            console.log(`Database row inserted successfully, got page ID: ${pageId}`);

            // 创建块内容
            if (parsedMarkdown.blocks.length > 0) {
                console.log(`Creating ${parsedMarkdown.blocks.length} blocks for page ${pageId}`);
                const blocksResult = await this.wolaiAPI.createBlocks(pageId, parsedMarkdown.blocks);
                if (!blocksResult) {
                    console.error(`Failed to create blocks for file: ${filePath}`);
                    new Notice(`文件 ${filePath} 同步失败：无法创建块内容`);
                    return false;
                } else {
                    console.log('Blocks created successfully');
                }
            } else {
                console.log('No blocks to create (empty content)');
            }

            // 更新文件的同步状态
            const updatedContent = this.markdownParser.updateSyncStatus(content, 'Synced', pageId);
            await this.vault.modify(file, updatedContent);

            // 更新同步记录
            const syncRecord: SyncRecord = {
                filePath: filePath,
                lastModified: file.stat.mtime,
                wolaiRowId: pageId,
                synced: true,
                hash: this.markdownParser.createHash(updatedContent)
            };

            this.syncRecords.set(filePath, syncRecord);
            await this.saveSyncRecords();

            console.log(`Successfully synced Obsidian→Wolai: ${filePath}`);
            return true;

        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error(`Error syncing Obsidian→Wolai ${filePath}:`, error);
            void this.writeSyncLog('ERROR', `Obsidian→Wolai 失败：${filePath}；${String(error)}`);
            new Notice(`同步文件失败: ${filePath}`);
            return false;
        } finally {
            // 无论成功还是失败，都要从正在同步的文件集合中移除
            this.syncingFiles.delete(filePath);
        }
    }

    async syncWolaiToObsidian(mode: SyncMode = 'full'): Promise<number> {
        try {
            console.log('Starting Wolai→Obsidian sync...');

            // 获取Wolai数据库中标记为"Wait For Syncing"的行
            const databaseRows = await this.wolaiAPI.getAllDatabaseContent(this.settings.wolaiDatabaseId);

            const waitingRows = databaseRows.filter(row => {
                const syncStatus = row.data['同步状态']?.value;
                return syncStatus === 'Pending';
            });

            console.log(`Found ${waitingRows.length} rows waiting for sync from Wolai`);

            let successCount = 0;
            for (let index = 0; index < waitingRows.length; index++) {
                const row = waitingRows[index];
                this.reportProgress(50 + (index / Math.max(1, waitingRows.length)) * 20,
                    `正在导入数据库页面 ${index + 1}/${waitingRows.length}`);
                if (mode === 'incremental') {
                    const imported = await this.findImportedFileByWolaiId(row.page_id);
                    if (imported) {
                        const metadata = await this.getPageMetadataLimited(row.page_id);
                        if (Number(metadata.edited_at || 0) <= imported.lastSync) {
                            console.log(`Skipped unchanged Pending database row: ${row.page_id}`);
                            continue;
                        }
                    }
                }
                const success = await this.createOrUpdateObsidianFile(row);
                if (success) {
                    successCount++;
                }
            }

            // Database scanning and configured-page recursion deliberately run
            // sequentially so they cannot create two independent request bursts.
            successCount += await this.syncConfiguredWolaiPages(mode);
            return successCount;

        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error syncing Wolai→Obsidian:', error);
            void this.writeSyncLog('ERROR', `Wolai→Obsidian 失败：${String(error)}`);
            new Notice('从 Wolai 同步失败');
            throw error;
        }
    }

    private parseConfiguredWolaiPages(): Array<{ title: string; pageId: string }> {
        return (this.settings.wolaiPages || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const separator = line.indexOf('|');
                const title = separator >= 0 ? line.slice(0, separator).trim() : '';
                const source = (separator >= 0 ? line.slice(separator + 1) : line).trim();
                const match = source.match(/(?:wolai\.com\/)?([A-Za-z0-9_-]+)(?:[?#].*)?$/);
                const pageId = match ? match[1] : '';
                return { title: title || `Wolai_${pageId}`, pageId };
            })
            .filter(page => Boolean(page.pageId));
    }

    private async syncConfiguredWolaiPages(mode: SyncMode): Promise<number> {
        const pages = this.parseConfiguredWolaiPages();
        let successCount = 0;
        const generatedFiles = new Set<string>();
        const previousState = await this.loadIncrementalState();
        const nextState: WolaiIncrementalState = {};
        const changedPages = new Set<string>();
        const progressContext: PageProgressContext = {
            seen: new Set<string>(),
            total: 0,
            completed: 0,
            mode,
            lastPercent: 70
        };
        for (const page of pages) this.registerPageProgress(progressContext, page.pageId);

        const syncPage = async (page: { title: string; pageId: string }): Promise<boolean> => {
            return await this.createOrUpdateObsidianFile({
                page_id: page.pageId,
                data: { '标题': { value: page.title } }
            }, new Set(), '', generatedFiles, mode, previousState, nextState, changedPages, progressContext);
        };

        // Keep page trees serial. Shared descendants, output paths and state maps
        // must never be mutated by two root traversals at the same time.
        for (let index = 0; index < pages.length; index++) {
            if (await syncPage(pages[index])) successCount++;
            await this.waitForSyncDelay(300);
        }

        if (pages.length > 0 && successCount === pages.length) {
            this.reportProgress(95,
                `页面同步完成 ${progressContext.completed}/${progressContext.total}`);
        }

        if (pages.length > 0 && successCount === pages.length) {
            for (const pageId of Object.keys(previousState)) {
                if (!nextState[pageId]) changedPages.add(pageId);
            }
        }
        if (pages.length > 0 && successCount === pages.length && this.settings.safeCleanup !== false) {
            await this.safelyCleanupGeneratedFiles(generatedFiles);
        }
        if (pages.length > 0 && successCount === pages.length) {
            await this.saveIncrementalState(nextState);
        }

        if (pages.length > 0) {
            console.log(`Synced ${successCount}/${pages.length} configured Wolai pages`);
        }
        if (successCount !== pages.length) {
            throw new Error(`Configured Wolai page sync failed: ${successCount}/${pages.length} roots completed`);
        }
        return changedPages.size;
    }

    private async safelyCleanupGeneratedFiles(currentPaths: Set<string>): Promise<void> {
        type Entry = { size: number; mtime: number };
        let previous: Record<string, Entry> = {};
        try {
            if (await this.vault.adapter.exists(this.generatedManifestPath)) {
                previous = JSON.parse(await this.vault.adapter.read(this.generatedManifestPath));
            }
        } catch (error) {
            console.error('Failed to read Wolai generated-file manifest:', error);
            return;
        }

        for (const [path, entry] of Object.entries(previous)) {
            if (currentPaths.has(path)) continue;
            const file = this.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;
            const unchanged = file.stat.size === entry.size && file.stat.mtime === entry.mtime;
            if (unchanged) {
                await this.vault.trash(file, true);
                console.log(`Moved obsolete Wolai-generated file to system trash: ${path}`);
            } else {
                console.log(`Kept manually modified obsolete file: ${path}`);
            }
        }

        const syncRoot = normalizePath(this.settings.obsidianFolder || 'Wolai');
        const candidateDirs = new Set<string>();
        for (const path of Object.keys(previous)) {
            let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            while (dir && dir !== syncRoot && dir.startsWith(`${syncRoot}/`)) {
                candidateDirs.add(dir);
                dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
            }
        }
        for (const dir of [...candidateDirs].sort((a, b) => b.length - a.length)) {
            const folder = this.vault.getAbstractFileByPath(dir);
            if (folder instanceof TFolder && folder.children.length === 0) {
                await this.vault.trash(folder, true);
                console.log(`Moved empty obsolete Wolai-generated folder to system trash: ${dir}`);
            }
        }

        const next: Record<string, Entry> = {};
        for (const path of currentPaths) {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                next[path] = { size: file.stat.size, mtime: file.stat.mtime };
            }
        }
        await this.vault.adapter.write(this.generatedManifestPath, JSON.stringify(next, null, 2));
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const normalized = normalizePath(folderPath);
        const parts = normalized.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.vault.getAbstractFileByPath(current)) {
                await this.vault.createFolder(current);
            }
        }
    }

    private async downloadPageImages(
        blocks: any[],
        pageName: string,
        relativeDir: string,
        generatedFiles: Set<string> | undefined,
        mode: SyncMode,
        previousImages: WolaiPageSyncState['images'] = {}
    ): Promise<{ images: WolaiPageSyncState['images']; changed: boolean }> {
        const syncFolder = this.settings.obsidianFolder || 'Wolai';
        const safePageName = pageName.replace(/[<>:"/\\|?*]/g, '_');
        const attachmentFolder = normalizePath(
            [syncFolder, relativeDir, safePageName, 'pictures'].filter(Boolean).join('/')
        );
        if (!this.vault.getAbstractFileByPath(attachmentFolder)) {
            await this.ensureFolder(attachmentFolder);
        }

        let failed = false;
        let changed = false;
        const nextImages: WolaiPageSyncState['images'] = {};
        for (const block of blocks) {
            if (block.type !== 'image') continue;
            const downloadUrl = block.media?.download_url || block.url;
            if (!downloadUrl) continue;

            try {
                const urlWithoutQuery = downloadUrl.split('?')[0];
                const extensionMatch = urlWithoutQuery.match(/\.([A-Za-z0-9]{2,5})$/);
                const extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'png';
                const localPath = normalizePath(`${attachmentFolder}/${block.id}.${extension}`);
                const existing = this.vault.getAbstractFileByPath(localPath);
                const version = Number(block.version || 0);
                const editedAt = Number(block.edited_at || 0);
                const previous = previousImages[block.id];
                const needsDownload = mode === 'full' || !(existing instanceof TFile) ||
                    !previous || previous.version !== version || previous.editedAt !== editedAt || previous.path !== localPath;
                if (needsDownload) {
                    changed = true;
                    const response = await requestUrl({ url: downloadUrl });
                    if (existing instanceof TFile) {
                        await this.vault.modifyBinary(existing, response.arrayBuffer);
                    } else {
                        await this.vault.createBinary(localPath, response.arrayBuffer);
                    }
                    console.log(`Downloaded changed Wolai image: ${block.id}`);
                }
                generatedFiles?.add(localPath);
                block.localPath = localPath;
                nextImages[block.id] = { version, editedAt, path: localPath };
            } catch (error) {
                failed = true;
                console.error(`Failed to download Wolai image ${block.id}:`, error);
            }
        }
        if (failed) {
            throw new Error(`One or more images failed to download for ${pageName}`);
        }
        if (Object.keys(previousImages).some(id => !nextImages[id])) changed = true;
        return { images: nextImages, changed };
    }

    private async createOrUpdateObsidianFile(
        row: WolaiDatabaseRowData,
        visitedPageIds: Set<string> = new Set(),
        relativeDir = '',
        generatedFiles?: Set<string>,
        mode: SyncMode = 'full',
        previousState: WolaiIncrementalState = {},
        nextState: WolaiIncrementalState = {},
        changedPages?: Set<string>,
        progressContext?: PageProgressContext
    ): Promise<boolean> {
        try {
            await this.waitIfPaused();
            if (visitedPageIds.has(row.page_id)) return true;
            visitedPageIds.add(row.page_id);
            // 提取文件信息
            const data = row.data;
            const pageName = data['名称']?.value || data['标题']?.value || data['文件名']?.value || `Page_${row.page_id}`;
            this.registerPageProgress(progressContext, row.page_id);
            this.reportPageProgress(progressContext, pageName, relativeDir);
            const fileName = `${pageName.replace(/[<>:"/\\|?*]/g, '_')}.md`;
            const filePath = fileName; // 强制使用根据页面名称生成的文件名，不使用数据库中的"文件路径"字段

            // 确保文件路径在指定的同步文件夹内
            const syncFolder = this.settings.obsidianFolder;
            const fullFilePath = normalizePath(
                [syncFolder, relativeDir, filePath].filter(Boolean).join('/')
            );
            const previousPage = previousState[row.page_id];
            const metadata = await this.getPageMetadataLimited(row.page_id);

            const canFastSkip = mode === 'incremental' && previousPage &&
                previousPage.converterVersion === this.converterVersion &&
                previousPage.remoteVersion === Number(metadata.version || 0) &&
                previousPage.remoteEditedAt === Number(metadata.edited_at || 0) &&
                previousPage.filePath === fullFilePath &&
                this.vault.getAbstractFileByPath(fullFilePath) instanceof TFile &&
                Object.values(previousPage.images || {}).every(image =>
                    this.vault.getAbstractFileByPath(image.path) instanceof TFile) &&
                Array.isArray(previousPage.children);
            if (canFastSkip) {
                generatedFiles?.add(previousPage.filePath);
                for (const image of Object.values(previousPage.images || {})) {
                    if (this.vault.getAbstractFileByPath(image.path) instanceof TFile) generatedFiles?.add(image.path);
                }
                nextState[row.page_id] = previousPage;
                for (const child of previousPage.children) {
                    this.registerPageProgress(progressContext, child.pageId);
                }
                this.completePageProgress(progressContext);
                for (const child of previousPage.children) {
                    const childSuccess = await this.createOrUpdateObsidianFile({
                        page_id: child.pageId,
                        data: { '标题': { value: child.title } }
                    }, visitedPageIds, child.relativeDir, generatedFiles, mode, previousState, nextState, changedPages, progressContext);
                    if (!childSuccess) throw new Error(`Failed to check child page ${child.pageId} of ${row.page_id}`);
                }
                console.log(`Fast-skipped unchanged Wolai page: ${pageName}`);
                void this.writeSyncLog('INFO', `跳过未变更页面：${fullFilePath}`);
                return true;
            }

            // 创建基础的FrontMatter
            const frontMatter: { [key: string]: any } = {
                sync_status: 'Synced',
                wolai_id: row.page_id,
                last_sync: new Date().toISOString()
            };

            // 添加其他属性
            for (const [key, value] of Object.entries(data)) {
                if (!['标题', '文件名', '文件路径', '同步时间', '同步状态'].includes(key)) {
                    frontMatter[key] = value.value;
                }
            }

            // 获取页面内容
            console.log(`Getting content for page: ${row.page_id}`);
            const pageBlocks = await this.wolaiAPI.getAllPageBlocks(row.page_id);
            const childPages = (pageBlocks as any[]).filter(block => block.type === 'page');
            const childPageIds = new Set(childPages.map(block => block.id));
            const parentPageBlocks = (pageBlocks as any[]).filter(block =>
                !block.parentBlockId || !childPageIds.has(block.parentBlockId)
            );
            const fingerprint = this.createPageFingerprint(parentPageBlocks);
            const pageChanged = mode === 'full' || !previousPage || previousPage.fingerprint !== fingerprint ||
                previousPage.converterVersion !== this.converterVersion ||
                previousPage.filePath !== fullFilePath || !(this.vault.getAbstractFileByPath(fullFilePath) instanceof TFile);
            const imageResult = await this.downloadPageImages(
                parentPageBlocks as any[], pageName, relativeDir, generatedFiles,
                mode, previousPage?.images || {}
            );
            if (pageChanged || imageResult.changed) changedPages?.add(row.page_id);

            let markdownContent = '';
            if (pageChanged && parentPageBlocks.length > 0) {
                // 转换Wolai页面内容为Markdown
                markdownContent = this.markdownParser.convertWolaiPageToMarkdown(parentPageBlocks, pageName);
                console.log(`Converted ${pageBlocks.length} blocks to markdown for ${pageName}`);
            } else if (pageChanged) {
                // 如果没有内容，创建基础内容
                markdownContent = `# ${pageName}\n\n*此页面从 Wolai 同步，页面ID: ${row.page_id}*\n\n`;
                console.log(`No blocks found for page ${row.page_id}, using placeholder content`);
            }

            if (pageChanged) {
                const fullContent = matter.stringify(markdownContent, frontMatter);
                const existingFile = this.vault.getAbstractFileByPath(fullFilePath);
                if (existingFile && existingFile instanceof TFile) {
                // 更新现有文件
                    await this.vault.modify(existingFile, fullContent);
                    console.log(`Updated changed file: ${fullFilePath}`);
                } else {
                // 创建新文件（确保目录存在）
                const dirPath = fullFilePath.substring(0, fullFilePath.lastIndexOf('/'));
                if (dirPath && dirPath !== '' && !this.vault.getAbstractFileByPath(dirPath)) {
                    try {
                        await this.ensureFolder(dirPath);
                        console.log(`Created directory: ${dirPath}`);
                    } catch (error) {
                        console.error(`Failed to create directory ${dirPath}:`, error);
                        // 如果目录创建失败，尝试在根目录创建文件
                    }
                }

                    try {
                        await this.vault.create(fullFilePath, fullContent);
                        console.log(`Created new file: ${fullFilePath}`);
                    } catch (error) {
                        console.error(`Failed to create file ${fullFilePath}:`, error);
                        throw error;
                    }
                }
            }
            generatedFiles?.add(fullFilePath);

            const childDescriptors: Array<{ pageId: string; title: string; relativeDir: string }> = [];
            for (const childPage of childPages) {
                const parts = Array.isArray(childPage.content) ? childPage.content : [childPage.content];
                const childTitle = parts.filter(Boolean)
                    .map((part: any) => typeof part === 'string' ? part : part.title || '')
                    .join('') || `Wolai_${childPage.id}`;
                const childDir = normalizePath(
                    [relativeDir, pageName.replace(/[<>:"/\\|?*]/g, '_')].filter(Boolean).join('/')
                );
                childDescriptors.push({ pageId: childPage.id, title: childTitle, relativeDir: childDir });
                this.registerPageProgress(progressContext, childPage.id);
            }

            this.completePageProgress(progressContext);
            for (const child of childDescriptors) {
                const childSuccess = await this.createOrUpdateObsidianFile({
                    page_id: child.pageId,
                    data: { '标题': { value: child.title } }
                }, visitedPageIds, child.relativeDir, generatedFiles, mode, previousState, nextState, changedPages, progressContext);
                if (!childSuccess) throw new Error(`Failed to sync child page ${child.pageId} of ${row.page_id}`);
            }

            nextState[row.page_id] = {
                fingerprint,
                filePath: fullFilePath,
                title: pageName,
                relativeDir,
                remoteVersion: Number(metadata.version || 0),
                remoteEditedAt: Number(metadata.edited_at || 0),
                converterVersion: this.converterVersion,
                children: childDescriptors,
                images: imageResult.images
            };

            // A page is checkpointed only after its Markdown, images and all
            // descendants completed.  Preserve older entries until the whole
            // configured tree succeeds so an interrupted run cannot imply that
            // unseen pages were deleted.
            await this.saveIncrementalCheckpoint(previousState, nextState);

            void this.writeSyncLog('INFO',
                `页面处理完成：${fullFilePath}；页面=${pageChanged ? '已更新' : '未变更'}；图片=${Object.keys(imageResult.images).length}；子页面=${childDescriptors.length}`);

            return true;

        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error creating/updating Obsidian file:', error);
            void this.writeSyncLog('ERROR', `页面同步失败：${row.page_id}；${String(error)}`);
            return false;
        }
    }

    async fullSync(): Promise<SyncResult> {
        return await this.runSync('full');
    }

    async incrementalSync(): Promise<SyncResult> {
        return await this.runSync('incremental');
    }

    async syncOnlyToWolai(): Promise<number> {
        return await this.runStandaloneTask('仅同步到 Wolai', 0, () => this.executeSyncOnlyToWolai());
    }

    private async executeSyncOnlyToWolai(): Promise<number> {
        this.reportProgress(0, '正在扫描需要上传的 Obsidian 文件');
        const obsidianFiles = await this.getAllFilesInFolder();
        const filesToSync: string[] = [];
        for (const filePath of obsidianFiles) {
            const file = this.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const content = await this.vault.read(file);
                const parsed = this.markdownParser.parseMarkdown(content);
                if (this.markdownParser.needsSync(parsed.frontMatter)) filesToSync.push(filePath);
            }
        }

        let synced = 0;
        for (let index = 0; index < filesToSync.length; index++) {
            const filePath = filesToSync[index];
            this.reportProgress((index / Math.max(1, filesToSync.length)) * 95,
                `正在上传 ${index + 1}/${filesToSync.length}：${filePath}`);
            if (await this.syncObsidianToWolai(filePath)) synced++;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        this.reportProgress(100, '仅同步到 Wolai 完成');
        return synced;
    }

    private async runStandaloneTask<T>(label: string, cancelledValue: T, operation: () => Promise<T>): Promise<T> {
        if (this.syncActive) {
            void this.writeSyncLog('WARN', `已有同步任务在运行，忽略：${label}`);
            return cancelledValue;
        }
        this.syncActive = true;
        this.cancelRequested = false;
        try {
            return await operation();
        } catch (error) {
            if (this.isCancellationError(error)) {
                void this.writeSyncLog('INFO', `${label}已取消`);
                return cancelledValue;
            }
            throw error;
        } finally {
            this.syncActive = false;
            this.syncPaused = false;
            for (const resolve of this.pauseWaiters.splice(0)) resolve();
            this.cancelWaiters.splice(0);
        }
    }

    private async runSync(mode: SyncMode): Promise<SyncResult> {
        if (this.syncActive) {
            void this.writeSyncLog('WARN', `已有同步任务在运行，忽略新的${mode === 'full' ? '完整' : '增量'}同步请求`);
            return { obsidianToWolai: 0, wolaiToObsidian: 0, status: 'busy' };
        }
        this.syncActive = true;
        this.cancelRequested = false;
        if (this.syncPaused) this.resumeSync();
        try {
            return await this.executeSync(mode);
        } catch (error) {
            if (this.isCancellationError(error)) {
                void this.writeSyncLog('INFO', '同步任务已终止，不再发送 API 请求');
                return { obsidianToWolai: 0, wolaiToObsidian: 0, status: 'cancelled' };
            }
            const message = `同步失败：${String(error)}`;
            this.reportProgress(this.currentProgress, message);
            return { obsidianToWolai: 0, wolaiToObsidian: 0, status: 'failed' };
        } finally {
            this.syncActive = false;
            this.syncPaused = false;
            for (const resolve of this.pauseWaiters.splice(0)) resolve();
            this.cancelWaiters.splice(0);
        }
    }

    private async executeSync(mode: SyncMode): Promise<SyncResult> {
        console.log(`Starting ${mode} bidirectional sync...`);
        this.reportProgress(0, '正在验证同步配置');

        // 验证同步前置条件
        const isValid = await this.validateSync();
        if (!isValid) {
            this.reportProgress(100, '同步配置无效');
            return { obsidianToWolai: 0, wolaiToObsidian: 0, status: 'failed' };
        }

        this.reportProgress(5, '正在扫描 Obsidian 文件');

        // 1. 同步 Obsidian → Wolai（状态为Pending或Modified的文件）
        const obsidianFiles = await this.getAllFilesInFolder();
        const filesToSyncToWolai: string[] = [];

        for (const filePath of obsidianFiles) {
            const file = this.vault.getAbstractFileByPath(filePath) as TFile;
            if (file && file instanceof TFile) {
                const content = await this.vault.read(file);
                const parsed = this.markdownParser.parseMarkdown(content);
                if (this.markdownParser.needsSync(parsed.frontMatter)) {
                    filesToSyncToWolai.push(filePath);
                }
            }
        }

        console.log(`Found ${filesToSyncToWolai.length} Obsidian files to sync to Wolai`);

        let obsidianToWolaiCount = 0;
        for (let index = 0; index < filesToSyncToWolai.length; index++) {
            const filePath = filesToSyncToWolai[index];
            this.reportProgress(10 + (index / Math.max(1, filesToSyncToWolai.length)) * 35,
                `正在上传 ${index + 1}/${filesToSyncToWolai.length}：${filePath}`);
            const success = await this.syncObsidianToWolai(filePath);
            if (success) {
                obsidianToWolaiCount++;
            }
            // 添加延迟避免API限制
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 2. 同步 Wolai → Obsidian（状态为Wait For Syncing的行）
        this.reportProgress(48, '正在读取 Wolai 页面');
        const wolaiToObsidianCount = await this.syncWolaiToObsidian(mode);

        const result: SyncResult = {
            obsidianToWolai: obsidianToWolaiCount,
            wolaiToObsidian: wolaiToObsidianCount,
            status: obsidianToWolaiCount === 0 && wolaiToObsidianCount === 0 ? 'no_changes' : 'completed'
        };

        if (mode === 'incremental' && result.obsidianToWolai === 0 && result.wolaiToObsidian === 0) {
            new Notice('没有检测到增量内容，所有页面和图片均为最新状态');
        } else {
            new Notice(`${mode === 'full' ? '完整' : '增量'}同步完成: Obsidian→Wolai ${result.obsidianToWolai}个文件, Wolai→Obsidian ${result.wolaiToObsidian}个文件`);
        }
        this.reportProgress(100, '同步完成');

        return result;
    }

    private async getAllFilesInFolder(): Promise<string[]> {
        const files: string[] = [];

        if (!this.settings.obsidianFolder) {
            return files;
        }

        const folder = this.vault.getAbstractFileByPath(this.settings.obsidianFolder);
        if (!folder || !(folder instanceof TFolder)) {
            console.error(`Folder not found: ${this.settings.obsidianFolder}`);
            return files;
        }

        // 递归收集所有 Markdown 文件
        const collectFiles = (currentFolder: TFolder) => {
            for (const child of currentFolder.children) {
                if (child instanceof TFile && child.extension === 'md') {
                    files.push(child.path);
                } else if (child instanceof TFolder) {
                    collectFiles(child);
                }
            }
        };

        collectFiles(folder);
        return files;
    }

    async scheduledSync(): Promise<void> {
        console.log('Starting scheduled bidirectional sync...');

        const result = await this.incrementalSync();

        // 更新最后同步时间
        this.settings.lastSyncTime = Date.now();

        console.log(`Scheduled sync completed: ${result.obsidianToWolai + result.wolaiToObsidian} files synced`);
    }

    async validateSync(): Promise<boolean> {
        // 验证Wolai连接
        const isConnected = await this.wolaiAPI.validateConnection();
        if (!isConnected) {
            new Notice('Wolai 连接失败，请检查 API 配置');
            return false;
        }

        // 验证设置
        if (!this.settings.obsidianFolder || !this.settings.wolaiDatabaseId) {
            new Notice('请先配置同步文件夹和数据库ID');
            return false;
        }

        return true;
    }

    getSyncRecord(filePath: string): SyncRecord | undefined {
        return this.syncRecords.get(filePath);
    }

    getAllSyncRecords(): Map<string, SyncRecord> {
        return new Map(this.syncRecords);
    }

    async removeSyncRecord(filePath: string): Promise<void> {
        this.syncRecords.delete(filePath);
        await this.saveSyncRecords();
        console.log(`Removed sync record for: ${filePath}`);
    }

    getSyncStats(): { total: number; synced: number; pending: number } {
        const total = this.syncRecords.size;
        const synced = Array.from(this.syncRecords.values()).filter(record => record.synced).length;
        const pending = total - synced;

        return { total, synced, pending };
    }

    async clearSyncRecords(): Promise<void> {
        this.syncRecords.clear();
        await this.saveSyncRecords();
        console.log('All sync records cleared');
    }

    // 兼容性方法，保持向后兼容
    async syncFile(filePath: string): Promise<boolean> {
        return await this.runStandaloneTask(`单文件同步：${filePath}`, false,
            () => this.syncObsidianToWolai(filePath));
    }

    async batchSync(filePaths: string[]): Promise<number> {
        return await this.runStandaloneTask('批量文件同步', 0,
            () => this.executeBatchSync(filePaths));
    }

    private async executeBatchSync(filePaths: string[]): Promise<number> {
        let successCount = 0;
        for (const filePath of filePaths) {
            const success = await this.syncObsidianToWolai(filePath);
            if (success) {
                successCount++;
            }
            // 添加延迟避免API限制
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return successCount;
    }

    async forceUpdateFileStatus(filePath: string, status: SyncStatus): Promise<string> {
        try {
            const file = this.vault.getAbstractFileByPath(filePath) as TFile;
            if (!file || !(file instanceof TFile)) {
                throw new Error(`File not found: ${filePath}`);
            }

            const content = await this.vault.read(file);
            const updatedContent = this.markdownParser.updateSyncStatus(content, status);

            await this.vault.modify(file, updatedContent);
            console.log(`Updated file ${filePath} sync status to ${status}`);

            return updatedContent;
        } catch (error) {
            console.error(`Error updating file status for ${filePath}:`, error);
            throw error;
        }
    }

    async forceSyncObsidianToWolai(filePath: string): Promise<boolean> {
        return await this.runStandaloneTask(`强制同步：${filePath}`, false,
            () => this.executeForceSyncObsidianToWolai(filePath));
    }

    private async executeForceSyncObsidianToWolai(filePath: string): Promise<boolean> {
        try {
            // 强制同步，绕过同步锁和状态检查
            console.log(`Starting FORCE sync Obsidian→Wolai for file: ${filePath}`);

            // 获取文件
            const file = this.vault.getAbstractFileByPath(filePath) as TFile;
            if (!file || !(file instanceof TFile)) {
                console.error(`File not found: ${filePath}`);
                return false;
            }

            // 读取文件内容
            const content = await this.vault.read(file);
            const parsedMarkdown = this.markdownParser.parseMarkdown(content);

            console.log(`Parsing markdown content, found ${parsedMarkdown.blocks.length} blocks`);
            this.debugLog('Blocks to be created:', parsedMarkdown.blocks);

            // 解析并准备数据
            const fileName = file.basename;
            const title = this.markdownParser.extractTitle(parsedMarkdown.frontMatter, fileName);

            const rowData = {
                ...parsedMarkdown.frontMatter,
                '标题': title,
                '文件名': fileName,
                '文件路径': filePath,
                '同步时间': new Date().toISOString(),
                '同步状态': 'Synced'
            };

            this.debugLog('Row data to be inserted:', rowData);

            // 插入数据库行并获取页面ID
            const pageId = await this.wolaiAPI.insertDatabaseRowAndGetPageId(
                this.settings.wolaiDatabaseId,
                rowData
            );

            if (!pageId) {
                console.error(`Failed to insert database row for file: ${filePath}`);
                return false;
            }

            console.log(`Database row inserted successfully, got page ID: ${pageId}`);

            // 创建块内容
            if (parsedMarkdown.blocks.length > 0) {
                console.log(`Creating ${parsedMarkdown.blocks.length} blocks for page ${pageId}`);
                const blocksResult = await this.wolaiAPI.createBlocks(pageId, parsedMarkdown.blocks);
                if (!blocksResult) {
                    console.error(`Failed to create blocks for file: ${filePath}`);
                    new Notice(`文件 ${filePath} 强制同步失败：无法创建块内容`);
                    return false;
                } else {
                    console.log('Blocks created successfully');
                }
            } else {
                console.log('No blocks to create (empty content)');
            }

            // 更新文件的同步状态
            const updatedContent = this.markdownParser.updateSyncStatus(content, 'Synced', pageId);
            await this.vault.modify(file, updatedContent);

            // 更新同步记录
            const syncRecord: SyncRecord = {
                filePath: filePath,
                lastModified: file.stat.mtime,
                wolaiRowId: pageId,
                synced: true,
                hash: this.markdownParser.createHash(updatedContent)
            };

            this.syncRecords.set(filePath, syncRecord);
            await this.saveSyncRecords();

            console.log(`Successfully FORCE synced Obsidian→Wolai: ${filePath}`);
            return true;

        } catch (error) {
            console.error(`Error force syncing Obsidian→Wolai ${filePath}:`, error);
            new Notice(`强制同步文件失败: ${filePath}`);
            return false;
        }
    }
}
