import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import WolaiSyncPlugin from '../main';

export class WolaiSyncSettingTab extends PluginSettingTab {
    plugin: WolaiSyncPlugin;
    private removeLogListener?: () => void;
    private removeApiStatsListener?: () => void;
    private apiStatsTimer?: number;

    constructor(app: App, plugin: WolaiSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        this.removeLogListener?.();
        this.removeApiStatsListener?.();
        if (this.apiStatsTimer) window.clearInterval(this.apiStatsTimer);

        containerEl.empty();
        containerEl.createEl('h2', { text: 'Wolai 同步设置' });

        // API调用统计区域
        this.createAPIStatsSection();

        // 分隔线
        containerEl.createEl('hr');

        // Obsidian 设置区域
        this.createObsidianSection();

        // 分隔线
        containerEl.createEl('hr');

        // Wolai API 设置区域
        this.createWolaiSection();

        // 分隔线
        containerEl.createEl('hr');

        // 同步设置区域
        this.createSyncSection();

        // 分隔线
        containerEl.createEl('hr');

        // 操作按钮区域
        this.createActionSection();

        containerEl.createEl('hr');
        this.createLogSection();
    }

    hide(): void {
        this.removeLogListener?.();
        this.removeLogListener = undefined;
        this.removeApiStatsListener?.();
        this.removeApiStatsListener = undefined;
        if (this.apiStatsTimer) window.clearInterval(this.apiStatsTimer);
        this.apiStatsTimer = undefined;
    }

    private createAPIStatsSection(): void {
        const { containerEl } = this;

        containerEl.createEl('h3', { text: 'API 调用统计' });

        // 获取API统计数据
        const stats = this.plugin.syncManager?.getAPICallStats() || {
            total: 0, today: 0, lastReset: 0, hourly: 0, hourlyLimit: 0
        };

        const statsContainer = containerEl.createDiv({ cls: 'wolai-sync-stats' });

        const hourlyEl = statsContainer.createDiv({ cls: 'stat-item' });
        hourlyEl.createEl('span', { text: '最近一小时API调用: ', cls: 'stat-label' });
        const hourlyValueEl = hourlyEl.createEl('span', {
            text: `${stats.hourly} / ${stats.hourlyLimit}`,
            cls: 'stat-value'
        });

        // 今日调用次数
        const todayEl = statsContainer.createDiv({ cls: 'stat-item' });
        todayEl.createEl('span', { text: '今日API调用: ', cls: 'stat-label' });
        const todayValueEl = todayEl.createEl('span', { text: stats.today.toString(), cls: 'stat-value' });

        // 总调用次数
        const totalEl = statsContainer.createDiv({ cls: 'stat-item' });
        totalEl.createEl('span', { text: '总API调用: ', cls: 'stat-label' });
        const totalValueEl = totalEl.createEl('span', { text: stats.total.toString(), cls: 'stat-value' });

        const updateStats = (current: typeof stats): void => {
                hourlyValueEl.setText(`${current.hourly} / ${current.hourlyLimit}`);
                todayValueEl.setText(current.today.toString());
                totalValueEl.setText(current.total.toString());
        };
        if (this.plugin.syncManager) {
            this.removeApiStatsListener = this.plugin.syncManager.addApiStatsListener(updateStats);
            this.apiStatsTimer = window.setInterval(() => {
                if (this.plugin.syncManager) updateStats(this.plugin.syncManager.getAPICallStats());
            }, 10000);
        }

        // 重置按钮
        new Setting(containerEl)
            .setName('重置本地累计统计')
            .setDesc('只清零今日和累计显示；不会、也不能清除 Wolai 最近一小时额度')
            .addButton(button => {
                button
                    .setButtonText('清零累计')
                    .setCta()
                    .onClick(async () => {
                        if (this.plugin.syncManager) {
                            this.plugin.syncManager.resetAPICallStats();
                            new Notice('本地累计已清零，最近一小时额度保留');
                        }
                    });
            });

        // 添加样式
        if (!document.querySelector('.wolai-sync-stats-style')) {
            const style = document.createElement('style');
            style.className = 'wolai-sync-stats-style';
            style.textContent = `
                .wolai-sync-stats {
                    background: var(--background-secondary);
                    padding: 16px;
                    border-radius: 8px;
                    margin: 12px 0;
                }
                .stat-item {
                    display: flex;
                    justify-content: space-between;
                    margin: 8px 0;
                }
                .stat-label {
                    font-weight: 500;
                }
                .stat-value {
                    font-weight: bold;
                    color: var(--text-accent);
                }
            `;
            document.head.appendChild(style);
        }
    }

    private createObsidianSection(): void {
        const { containerEl } = this;

        containerEl.createEl('h3', { text: 'Obsidian 设置' });

        new Setting(containerEl)
            .setName('同步文件夹')
            .setDesc('选择要同步到 Wolai 的文件夹路径')
            .addText(text => text
                .setPlaceholder('例如: Notes/Wolai')
                .setValue(this.plugin.settings.obsidianFolder)
                .onChange(async (value) => {
                    this.plugin.settings.obsidianFolder = value;
                    await this.plugin.saveSettings();
                }));
    }

    private createWolaiSection(): void {
        const { containerEl } = this;

        containerEl.createEl('h3', { text: 'Wolai API 设置' });

        new Setting(containerEl)
            .setName('数据库 ID')
            .setDesc('Wolai 数据库的唯一标识符')
            .addText(text => text
                .setPlaceholder('请输入数据库 ID')
                .setValue(this.plugin.settings.wolaiDatabaseId)
                .onChange(async (value) => {
                    this.plugin.settings.wolaiDatabaseId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('App ID')
            .setDesc('Wolai 应用程序 ID')
            .addText(text => text
                .setPlaceholder('请输入 App ID')
                .setValue(this.plugin.settings.wolaiAppId)
                .onChange(async (value) => {
                    this.plugin.settings.wolaiAppId = value;
                    await this.plugin.saveSettings();
                    // 更新API实例
                    this.plugin.updateSyncManager();
                }));

        new Setting(containerEl)
            .setName('App Secret')
            .setDesc('Wolai 应用程序密钥（敏感信息，请妥善保管）')
            .addText(text => {
                text.inputEl.type = 'password';
                text
                    .setPlaceholder('请输入 App Secret')
                    .setValue(this.plugin.settings.wolaiAppSecret)
                    .onChange(async (value) => {
                        this.plugin.settings.wolaiAppSecret = value;
                        await this.plugin.saveSettings();
                        // 更新API实例
                        this.plugin.updateSyncManager();
                    });
            });

        new Setting(containerEl)
            .setName('每小时 API 额度')
            .setDesc('请选择 Wolai 当前套餐；每月额度无法通过延迟规避')
            .addDropdown(dropdown => dropdown
                .addOption('10', '个人免费版：10 次/小时')
                .addOption('500', '个人专业版：500 次/小时')
                .addOption('800', '家庭版：800 次/小时')
                .addOption('1000', '小组版：1000 次/小时')
                .addOption('1500', '团队版：1500 次/小时')
                .addOption('3000', '企业版：3000 次/小时')
                .setValue(String(this.plugin.settings.hourlyApiLimit || 10))
                .onChange(async value => {
                    this.plugin.settings.hourlyApiLimit = Number(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Wolai 普通页面')
            .setDesc('直接同步非数据库页面。每行填写：页面标题 | 页面网址或页面ID')
            .addTextArea(text => {
                text.inputEl.rows = 8;
                text.inputEl.style.width = '100%';
                text
                    .setPlaceholder('例如：\nDocker | https://www.wolai.com/xxxxxxxx\nPostgreSQL | yyyyyyyy')
                    .setValue(this.plugin.settings.wolaiPages || '')
                    .onChange(async (value) => {
                        this.plugin.settings.wolaiPages = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('安全清理过期文件')
            .setDesc('仅在完整同步成功后，将插件生成且未被手动修改的过期文件和图片移到系统废纸篓')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.safeCleanup !== false)
                .onChange(async value => {
                    this.plugin.settings.safeCleanup = value;
                    await this.plugin.saveSettings();
                }));

        // 连接测试按钮
        new Setting(containerEl)
            .setName('测试连接')
            .setDesc('验证 Wolai API 配置是否正确')
            .addButton(button => {
                button
                    .setButtonText('测试连接')
                    .setCta()
                    .onClick(async () => {
                        button.setButtonText('测试中...');
                        button.setDisabled(true);

                        try {
                            if (!this.plugin.settings.wolaiAppId || !this.plugin.settings.wolaiAppSecret) {
                                new Notice('请先填写 App ID 和 App Secret');
                                return;
                            }

                            const isValid = await this.plugin.syncManager?.validateSync();
                            if (isValid) {
                                new Notice('Wolai API 连接成功！');
                            } else {
                                new Notice('Wolai API 连接失败，请检查配置');
                            }
                        } catch (error) {
                            console.error('Connection test failed:', error);
                            new Notice('连接测试失败');
                        } finally {
                            button.setButtonText('测试连接');
                            button.setDisabled(false);
                        }
                    });
            });
    }

    private createSyncSection(): void {
        const { containerEl } = this;

        containerEl.createEl('h3', { text: '同步设置' });

        new Setting(containerEl)
            .setName('启用自动同步')
            .setDesc('定时执行增量同步，只处理发生变化的页面和图片')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();

                    // 更新定时器
                    if (value) {
                        this.plugin.startScheduledSync();
                        new Notice('自动同步已启用');
                    } else {
                        this.plugin.stopScheduledSync();
                        this.plugin.syncManager?.cancelSync('已关闭自动同步');
                        new Notice('自动同步已禁用');
                    }
                }));

        new Setting(containerEl)
            .setName('启用慢速同步')
            .setDesc('同时适用于完整和增量同步；到达每小时 API 额度后保留任务，额度释放后自动继续')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.slowSync !== false)
                .onChange(async value => {
                    this.plugin.settings.slowSync = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? '慢速同步已启用' : '慢速同步已关闭');
                }));

        new Setting(containerEl)
            .setName('详细调试日志')
            .setDesc('默认关闭。开启后控制台可能包含笔记块、Front Matter 和文件路径')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.detailedLogging === true)
                .onChange(async value => {
                    this.plugin.settings.detailedLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('启用文件监听')
            .setDesc('监听文件夹变化并自动同步（可能会频繁调用API）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFileWatcher)
                .onChange(async (value) => {
                    this.plugin.settings.enableFileWatcher = value;
                    await this.plugin.saveSettings();

                    if (value) {
                        new Notice('文件监听已启用');
                    } else {
                        new Notice('文件监听已禁用');
                    }
                }));

        new Setting(containerEl)
            .setName('同步间隔')
            .setDesc('自动同步的时间间隔（分钟）')
            .addSlider(slider => slider
                .setLimits(5, 120, 5)
                .setValue(this.plugin.settings.syncInterval)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value;
                    await this.plugin.saveSettings();

                    // 如果自动同步已启用，重新启动定时器
                    if (this.plugin.settings.autoSync) {
                        this.plugin.stopScheduledSync();
                        this.plugin.startScheduledSync();
                    }
                }));

        // 显示上次同步时间
        if (this.plugin.settings.lastSyncTime > 0) {
            const lastSyncDate = new Date(this.plugin.settings.lastSyncTime);
            const lastSyncText = `上次同步: ${lastSyncDate.toLocaleString('zh-CN')}`;

            containerEl.createDiv({
                text: lastSyncText,
                cls: 'setting-item-description'
            });
        }
    }

    private createActionSection(): void {
        const { containerEl } = this;

        containerEl.createEl('h3', { text: '同步操作' });

        const progressContainer = containerEl.createDiv({ cls: 'wolai-sync-progress' });
        progressContainer.style.display = 'none';
        progressContainer.style.margin = '12px 0 20px';
        const progressText = progressContainer.createDiv({ text: '准备同步…' });
        progressText.style.marginBottom = '8px';
        const progressBar = progressContainer.createEl('progress');
        progressBar.max = 100;
        progressBar.value = 0;
        progressBar.style.width = '100%';
        progressBar.style.height = '12px';
        const updateProgress = (percent: number | null, message: string): void => {
            // The total tree size is unknown while discovering child pages.
            if (percent === null) progressBar.removeAttribute('value');
            else progressBar.value = percent;
            progressText.setText(percent === null ? message : `${percent}% · ${message}`);
        };

        new Setting(containerEl)
            .setName('暂停/继续同步')
            .setDesc('安全暂停当前的完整同步或增量同步；继续时从当前位置恢复')
            .addButton(button => {
                const updateButton = (): void => {
                    const paused = this.plugin.syncManager?.isSyncPaused() || false;
                    button.setButtonText(paused ? '继续同步' : '暂停同步');
                };
                updateButton();
                button.onClick(() => {
                    const manager = this.plugin.syncManager;
                    if (!manager?.isSyncActive()) {
                        new Notice('当前没有正在进行的完整或增量同步');
                        return;
                    }
                    if (manager.isSyncPaused()) {
                        manager.resumeSync();
                        new Notice('已继续同步');
                    } else {
                        manager.pauseSync();
                        new Notice('已暂停同步');
                    }
                    updateButton();
                });
            })
            .addButton(button => button
                .setButtonText('停止同步')
                .setWarning()
                .onClick(() => {
                    const stopped = this.plugin.syncManager?.cancelSync('用户点击停止同步') || false;
                    new Notice(stopped ? '已停止同步，不再发送 API 请求' : '当前没有可停止的同步任务');
                }));

        // 手动双向同步按钮
        new Setting(containerEl)
            .setName('完整双向同步')
            .setDesc('重新检查并写入全部配置页面和图片')
            .addButton(button => {
                button
                    .setButtonText('开始完整同步')
                    .setCta()
                    .onClick(async () => {
                        button.setButtonText('同步中...');
                        button.setDisabled(true);
                        progressContainer.style.display = 'block';
                        progressBar.value = 0;
                        progressText.setText('0% · 准备同步…');
                        let removeProgressListener: (() => void) | undefined;

                        try {
                            if (!this.plugin.syncManager) {
                                new Notice('同步管理器未初始化');
                                return;
                            }

                            removeProgressListener = this.plugin.syncManager.addProgressListener(updateProgress);

                            const result = await this.plugin.syncManager.fullSync();
                            const totalSynced = result.obsidianToWolai + result.wolaiToObsidian;

                            if (result.status === 'cancelled') {
                                new Notice('完整同步已取消');
                            } else if (result.status === 'busy') {
                                new Notice('已有同步任务在运行');
                            } else if (result.status === 'failed') {
                                new Notice('完整同步失败，请查看同步日志');
                            } else if (result.status === 'partial') {
                                new Notice(`完整同步部分完成，${result.failedPages} 个页面未完成；断点已保留`);
                            } else if (totalSynced > 0) {
                                new Notice(`同步完成！Obsidian→Wolai: ${result.obsidianToWolai}个文件，Wolai→Obsidian: ${result.wolaiToObsidian}个文件`);
                            } else {
                                new Notice('没有文件需要同步');
                            }

                            // API stats already update live; keep the final summary visible.
                        } catch (error) {
                            console.error('Manual sync failed:', error);
                            new Notice('同步失败，请查看控制台日志');
                        } finally {
                            removeProgressListener?.();
                            button.setButtonText('开始完整同步');
                            button.setDisabled(false);
                        }
                    });
            });

        new Setting(containerEl)
            .setName('增量双向同步')
            .setDesc('只更新发生变化的页面和图片；已有 wolai_id 原位更新，双端同时修改时生成冲突副本')
            .addButton(button => {
                button
                    .setButtonText('开始增量同步')
                    .setCta()
                    .onClick(async () => {
                        button.setButtonText('同步中...');
                        button.setDisabled(true);
                        progressContainer.style.display = 'block';
                        progressBar.value = 0;
                        progressText.setText('0% · 准备增量同步…');
                        let removeProgressListener: (() => void) | undefined;
                        try {
                            if (!this.plugin.syncManager) {
                                new Notice('同步管理器未初始化');
                                return;
                            }
                            removeProgressListener = this.plugin.syncManager.addProgressListener(updateProgress);
                            const result = await this.plugin.syncManager.incrementalSync();
                            if (result.status === 'cancelled') new Notice('增量同步已取消');
                            if (result.status === 'busy') new Notice('已有同步任务在运行');
                            if (result.status === 'failed') new Notice('增量同步失败，请查看同步日志');
                            if (result.status === 'partial') new Notice(`增量同步部分完成，${result.failedPages} 个页面未完成；断点已保留`);
                        } catch (error) {
                            console.error('Incremental sync failed:', error);
                            new Notice('增量同步失败，请查看控制台日志');
                        } finally {
                            removeProgressListener?.();
                            button.setButtonText('开始增量同步');
                            button.setDisabled(false);
                        }
                    });
            });

        new Setting(containerEl)
            .setName('仅同步到 Wolai')
            .setDesc('只上传 Obsidian 中标记为 Pending 或 Modified 的文件，不读取 Wolai 页面')
            .addButton(button => {
                button
                    .setButtonText('同步到 Wolai')
                    .onClick(async () => {
                        button.setButtonText('同步中...');
                        button.setDisabled(true);
                        progressContainer.style.display = 'block';
                        progressBar.value = 0;
                        progressText.setText('0% · 正在扫描 Obsidian 文件…');
                        let removeProgressListener: (() => void) | undefined;
                        try {
                            if (!this.plugin.syncManager) {
                                new Notice('同步管理器未初始化');
                                return;
                            }
                            removeProgressListener = this.plugin.syncManager.addProgressListener(updateProgress);
                            const count = await this.plugin.syncManager.syncOnlyToWolai();
                            new Notice(count > 0 ? `已同步 ${count} 个文件到 Wolai` : '没有文件需要同步到 Wolai');
                            this.display();
                        } catch (error) {
                            console.error('Obsidian to Wolai sync failed:', error);
                            new Notice('同步到 Wolai 失败，请查看控制台日志');
                        } finally {
                            removeProgressListener?.();
                            button.setButtonText('同步到 Wolai');
                            button.setDisabled(false);
                        }
                    });
            });

        // 同步状态信息
        if (this.plugin.syncManager) {
            const stats = this.plugin.syncManager.getSyncStats();
            containerEl.createDiv({
                text: `同步记录统计: 总计 ${stats.total} 个文件，已同步 ${stats.synced} 个，待同步 ${stats.pending} 个`,
                cls: 'setting-item-description'
            });
        }
    }

    private createLogSection(): void {
        const { containerEl } = this;
        containerEl.createEl('h3', { text: '同步日志' });
        containerEl.createDiv({
            text: `日志文件：${this.plugin.syncManager?.getSyncLogPath() || 'sync.log'}`,
            cls: 'setting-item-description'
        });

        const logEl = containerEl.createEl('textarea');
        logEl.readOnly = true;
        logEl.placeholder = '暂无同步日志';
        logEl.style.width = '100%';
        logEl.style.height = '260px';
        logEl.style.marginTop = '12px';
        logEl.style.fontFamily = 'var(--font-monospace)';
        logEl.style.fontSize = '12px';
        logEl.style.resize = 'vertical';

        let loading = true;
        const pendingLines: string[] = [];
        const appendLine = (line: string): void => {
            if (loading) {
                pendingLines.push(line);
                return;
            }
            const shouldFollow = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
            logEl.value = (logEl.value + line).slice(-100000);
            if (shouldFollow) logEl.scrollTop = logEl.scrollHeight;
        };
        if (this.plugin.syncManager) {
            this.removeLogListener = this.plugin.syncManager.addLogListener(appendLine);
        }

        const refreshLog = async (): Promise<void> => {
            if (!this.plugin.syncManager) return;
            const content = await this.plugin.syncManager.getSyncLog();
            // Keep the settings page responsive for very long-running installations.
            logEl.value = (content + pendingLines.splice(0).join('')).slice(-100000);
            loading = false;
            logEl.scrollTop = logEl.scrollHeight;
        };
        void refreshLog();

        new Setting(containerEl)
            .setName('日志操作')
            .setDesc('日志会记录同步进度、成功、失败和 HTTP 429 重试')
            .addButton(button => button
                .setButtonText('刷新日志')
                .onClick(refreshLog))
            .addButton(button => button
                .setButtonText('复制诊断日志')
                .onClick(async () => {
                    await refreshLog();
                    await navigator.clipboard.writeText(logEl.value);
                    new Notice('已复制诊断日志');
                }))
            .addButton(button => button
                .setButtonText('清空日志')
                .setWarning()
                .onClick(async () => {
                    if (!this.plugin.syncManager) return;
                    await this.plugin.syncManager.clearSyncLog();
                    await refreshLog();
                    new Notice('同步日志已清空');
                }));
    }
}
