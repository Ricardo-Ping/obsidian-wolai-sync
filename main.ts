import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { WolaiSyncSettings } from './src/types';
import { SyncManager } from './src/SyncManager';
import { FileWatcher } from './src/FileWatcher';
import { WolaiSyncSettingTab } from './src/SettingsTab';

const DEFAULT_SETTINGS: WolaiSyncSettings = {
	obsidianFolder: '',
	wolaiDatabaseId: '',
	wolaiAppId: '',
	wolaiAppSecret: '',
	wolaiPages: '',
	safeCleanup: true,
	slowSync: true,
	hourlyApiLimit: 10,
	detailedLogging: false,
	syncInterval: 20,
	autoSync: false,
	enableFileWatcher: false,
	lastSyncTime: 0
}

export default class WolaiSyncPlugin extends Plugin {
	settings: WolaiSyncSettings;
	syncManager: SyncManager;
	fileWatcher: FileWatcher;
	statusBarItemEl: HTMLElement;
	syncIntervalId: number | null = null;
	private pendingFileSyncs = new Set<string>();
	private fileQueueRunning = false;
	private fileQueueStopped = false;
	private fileQueuePath = '';
	private fileQueueWrite: Promise<void> = Promise.resolve();
	private fileQueueRetryTimer: number | null = null;

	async onload() {
		this.fileQueueStopped = false;
		console.log('Plugin: Obsidian Wolai Sync loaded');
		new Notice('Wolai Sync plugin loaded');
		await this.loadSettings();

		// 初始化同步管理器
		const pluginDirectory = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
		this.fileQueuePath = `${pluginDirectory}/wolai-file-queue.json`;
		this.syncManager = new SyncManager(this.app.vault, this.settings, pluginDirectory);
		await this.loadFileSyncQueue();
		this.syncManager.addProgressListener((percent, message) => {
			this.updateStatusBar(`${percent}% ${message}`);
		});

		// 初始化文件监听器
		this.initializeFileWatcher();
		if (this.settings.enableFileWatcher) void this.processFileSyncQueue();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('refresh-ccw-dot', 'Wolai Sync', async () => {
			// 执行手动同步
			await this.performManualSync();
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar('Ready');

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WolaiSyncSettingTab(this.app, this));

		// 添加强制同步当前文件的Command
		this.addCommand({
			id: 'force-sync-current-file',
			name: '强制同步当前文件',
			checkCallback: (checking: boolean) => {
				// 检查是否有活动的Markdown文件
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file) {
					if (!checking) {
						this.forceSyncCurrentFile();
					}
					return true;
				}
				return false;
			}
		});

		// // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// // Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	console.log('click', evt);
		// });

		// 启动定时同步
		this.setupScheduledSync();

		console.log('Wolai Sync plugin initialization completed');
	}

	onunload() {
		this.fileQueueStopped = true;
		this.pendingFileSyncs.clear();
		if (this.fileQueueRetryTimer !== null) {
			window.clearTimeout(this.fileQueueRetryTimer);
			this.fileQueueRetryTimer = null;
		}
		console.log('Plugin: Obsidian Wolai Sync unloaded. Bye bye~');
		this.syncManager?.cancelSync('插件已卸载');

		// 清理文件监听器
		if (this.fileWatcher) {
			this.fileWatcher.stopWatching();
		}

		// 清理定时同步
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// 更新同步管理器设置
		if (this.syncManager) {
			this.syncManager.updateSettings(this.settings);
		}

		// 重新初始化文件监听器（根据新的设置）
		if (this.fileWatcher) {
			this.fileWatcher.stopWatching();
		}
		this.initializeFileWatcher();
		if (this.settings.enableFileWatcher) {
			void this.processFileSyncQueue();
		} else if (this.fileQueueRetryTimer !== null) {
			window.clearTimeout(this.fileQueueRetryTimer);
			this.fileQueueRetryTimer = null;
		}

		// 重新设置定时同步
		this.setupScheduledSync();
	}

	private initializeFileWatcher(): void {
		this.fileWatcher = new FileWatcher(
			this.app.vault,
			this.settings.obsidianFolder,
			{
				onFileChange: (filePath: string) => {
					console.log(`File changed: ${filePath}`);
					this.enqueueFileSync(filePath);
				},
				onFileCreate: (filePath: string) => {
					console.log(`File created: ${filePath}`);
					this.enqueueFileSync(filePath);
				},
				onFileDelete: async (filePath: string) => {
					console.log(`File deleted: ${filePath}`);
					// 从同步记录中移除
					await this.syncManager.removeSyncRecord(filePath);
				}
			}
		);

		// 只有在启用文件监听器且设置了文件夹时才开始监听
		if (this.settings.enableFileWatcher && this.settings.obsidianFolder) {
			this.fileWatcher.startWatching();
			console.log('File watcher enabled and started');
		} else {
			console.log('File watcher disabled or no folder specified');
		}
	}

	private enqueueFileSync(filePath: string): void {
		this.pendingFileSyncs.add(filePath);
		void this.saveFileSyncQueue();
		if (this.settings.enableFileWatcher) void this.processFileSyncQueue();
	}

	private async loadFileSyncQueue(): Promise<void> {
		try {
			if (!this.fileQueuePath) return;
			const backupPath = `${this.fileQueuePath}.bak`;
			const source = await this.app.vault.adapter.exists(this.fileQueuePath) ? this.fileQueuePath :
				await this.app.vault.adapter.exists(backupPath) ? backupPath : '';
			if (!source) return;
			const paths = JSON.parse(await this.app.vault.adapter.read(source));
			if (Array.isArray(paths)) for (const path of paths) if (typeof path === 'string') this.pendingFileSyncs.add(path);
		} catch (error) {
			console.error('Failed to load Wolai file queue:', error);
		}
	}

	private async saveFileSyncQueue(): Promise<void> {
		if (!this.fileQueuePath) return;
		const snapshot = JSON.stringify([...this.pendingFileSyncs], null, 2);
		this.fileQueueWrite = this.fileQueueWrite.catch(() => undefined).then(async () => {
			const temporaryPath = `${this.fileQueuePath}.tmp`;
			const backupPath = `${this.fileQueuePath}.bak`;
			await this.app.vault.adapter.write(temporaryPath, snapshot);
			if (await this.app.vault.adapter.exists(backupPath)) await this.app.vault.adapter.remove(backupPath);
			if (await this.app.vault.adapter.exists(this.fileQueuePath)) {
				await this.app.vault.adapter.rename(this.fileQueuePath, backupPath);
			}
			try {
				await this.app.vault.adapter.rename(temporaryPath, this.fileQueuePath);
				if (await this.app.vault.adapter.exists(backupPath)) await this.app.vault.adapter.remove(backupPath);
			} catch (error) {
				if (!await this.app.vault.adapter.exists(this.fileQueuePath) &&
					await this.app.vault.adapter.exists(backupPath)) {
					await this.app.vault.adapter.rename(backupPath, this.fileQueuePath);
				}
				throw error;
			}
		});
		await this.fileQueueWrite;
	}

	private async processFileSyncQueue(): Promise<void> {
		if (this.fileQueueRunning) return;
		this.fileQueueRunning = true;
		try {
			while (!this.fileQueueStopped && this.settings.enableFileWatcher && this.pendingFileSyncs.size > 0) {
				if (this.syncManager.isSyncActive()) {
					await new Promise(resolve => window.setTimeout(resolve, 1000));
					continue;
				}
				const filePath = this.pendingFileSyncs.values().next().value as string | undefined;
				if (!filePath) break;
				const completed = await this.syncSingleFile(filePath);
				if (!completed) {
					await this.saveFileSyncQueue();
					this.scheduleFileQueueRetry();
					break;
				}
				this.pendingFileSyncs.delete(filePath);
				await this.saveFileSyncQueue();
			}
		} finally {
			this.fileQueueRunning = false;
		}
	}

	private scheduleFileQueueRetry(): void {
		if (this.fileQueueRetryTimer !== null || this.fileQueueStopped || !this.settings.enableFileWatcher) return;
		this.fileQueueRetryTimer = window.setTimeout(() => {
			this.fileQueueRetryTimer = null;
			void this.processFileSyncQueue();
		}, 5 * 60 * 1000);
	}

	private async syncSingleFile(filePath: string): Promise<boolean> {
		try {
			// 检查文件是否需要同步
			const file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
			if (!file || !(file instanceof TFile)) {
				console.log(`File not found or not a markdown file: ${filePath}`);
				return true;
			}

			if (!await this.syncManager.prepareLocalFileForSync(filePath)) {
				console.log(`File ${filePath} doesn't need sync, skipping...`);
				return true;
			}

			this.updateStatusBar('Syncing...');
			const success = await this.syncManager.syncFile(filePath);
			if (success) {
				this.updateStatusBar('Synced');
				console.log(`Successfully synced: ${filePath}`);
			} else {
				this.updateStatusBar('Sync Failed');
				console.error(`Failed to sync: ${filePath}`);
			}
			return success;
		} catch (error) {
			console.error(`Error syncing file ${filePath}:`, error);
			this.updateStatusBar('Sync Error');
			return false;
		}
	}

	private async performManualSync(): Promise<void> {
		try {
			this.updateStatusBar('Manual Sync...');
			new Notice('开始手动同步...');

			const result = await this.syncManager.fullSync();
			const totalSynced = result.obsidianToWolai + result.wolaiToObsidian;

			this.updateStatusBar(result.status === 'failed' ? 'Sync Failed' :
				result.status === 'busy' ? 'Sync Busy' : result.status === 'cancelled' ? 'Sync Cancelled' : 'Synced');

			if (result.status === 'cancelled') {
				new Notice('手动同步已取消');
			} else if (result.status === 'busy') {
				new Notice('已有同步任务在运行');
			} else if (result.status === 'failed') {
				new Notice('手动同步失败，请查看同步日志');
			} else if (totalSynced > 0) {
				new Notice(`手动同步完成: Obsidian→Wolai ${result.obsidianToWolai}个文件, Wolai→Obsidian ${result.wolaiToObsidian}个文件`);
			} else {
				new Notice('没有需要同步的文件');
			}

			// 更新最后同步时间
			if (result.status === 'completed' || result.status === 'no_changes') {
				this.settings.lastSyncTime = Date.now();
				await this.saveSettings();
			}

		} catch (error) {
			console.error('Manual sync failed:', error);
			this.updateStatusBar('Sync Failed');
			new Notice('手动同步失败，请查看控制台日志');
		}
	}

	private setupScheduledSync(): void {
		// 清理现有的定时器
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}

		// 如果启用了自动同步，设置新的定时器
		if (this.settings.autoSync && this.settings.syncInterval > 0) {
			const intervalMs = this.settings.syncInterval * 60 * 1000; // 转换为毫秒

			this.syncIntervalId = window.setInterval(async () => {
				try {
					console.log('Starting scheduled sync...');
					this.updateStatusBar('Auto Sync...');

					const result = await this.syncManager.scheduledSync();
					if (result.status === 'completed' || result.status === 'no_changes') await this.saveData(this.settings);

					this.updateStatusBar(result.status === 'failed' ? 'Sync Failed' :
						result.status === 'busy' ? 'Sync Busy' : result.status === 'cancelled' ? 'Sync Cancelled' : 'Synced');
					console.log(`Scheduled sync finished with status: ${result.status}`);
				} catch (error) {
					console.error('Scheduled sync failed:', error);
					this.updateStatusBar('Sync Failed');
				}
			}, intervalMs);

			console.log(`Scheduled sync enabled: every ${this.settings.syncInterval} minutes`);
		}
	}

	private updateStatusBar(status: string): void {
		if (this.statusBarItemEl) {
			this.statusBarItemEl.setText(`Wolai: ${status}`);
		}
	}

	// 公共方法供设置页面调用
	async testConnection(): Promise<boolean> {
		if (!this.syncManager) {
			return false;
		}
		return await this.syncManager.validateSync();
	}

	async manualSyncFromSettings(): Promise<void> {
		await this.performManualSync();
	}

	getSyncStats(): { total: number; synced: number; pending: number } {
		if (!this.syncManager) {
			return { total: 0, synced: 0, pending: 0 };
		}
		return this.syncManager.getSyncStats();
	}

	updateSyncManager(): void {
		if (this.syncManager) {
			this.syncManager.updateSettings(this.settings);
		}
	}

	startScheduledSync(): void {
		this.stopScheduledSync(); // 先停止现有的定时器

		if (this.settings.autoSync && this.settings.syncInterval > 0) {
			const intervalMs = this.settings.syncInterval * 60 * 1000; // 转换为毫秒
			this.syncIntervalId = window.setInterval(async () => {
				try {
					console.log('Executing scheduled sync...');
					const result = await this.syncManager.scheduledSync();
					if (result.status === 'completed' || result.status === 'no_changes') await this.saveData(this.settings);
					this.updateStatusBar(result.status === 'completed' || result.status === 'no_changes' ? 'Synced' : `Sync ${result.status}`);
				} catch (error) {
					console.error('Scheduled sync failed:', error);
				}
			}, intervalMs);

			console.log(`Scheduled sync started with interval: ${this.settings.syncInterval} minutes`);
		}
	}

	stopScheduledSync(): void {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
			console.log('Scheduled sync stopped');
		}
	}

	async forceSyncCurrentFile(): Promise<void> {
		try {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView || !activeView.file) {
				new Notice('没有打开的Markdown文件');
				return;
			}

			const filePath = activeView.file.path;
			console.log(`强制同步当前文件: ${filePath}`);

			// 显示开始同步通知
			new Notice(`开始强制同步: ${activeView.file.basename}`);
			this.updateStatusBar('Force Syncing...');

			// 使用强制同步方法，绕过所有检查
			const success = await this.syncManager.forceSyncObsidianToWolai(filePath);

			if (success) {
				this.updateStatusBar('Force Synced');
				new Notice(`✅ 强制同步成功: ${activeView.file.basename}`);
				console.log(`Successfully force synced: ${filePath}`);
			} else {
				this.updateStatusBar('Force Sync Failed');
				new Notice(`❌ 强制同步失败: ${activeView.file.basename}`);
				console.error(`Failed to force sync: ${filePath}`);
			}

		} catch (error) {
			console.error('Error force syncing current file:', error);
			this.updateStatusBar('Force Sync Error');
			new Notice(`❌ 强制同步出错，请查看控制台日志`);
		}
	}
}
