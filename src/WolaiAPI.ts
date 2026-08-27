import { Notice } from 'obsidian';
import {
    WolaiTokenResponse,
    WolaiCreateBlocksResponse,
    WolaiInsertRowsResponse,
    WolaiDatabaseRow,
    WolaiBlock,
    WolaiPageResponse,
    WolaiPageBlock
} from './types';

export interface WolaiDatabaseContent {
    column_order: string[];
    rows: WolaiDatabaseRowData[];
    has_more?: boolean;
    next_cursor?: string;
}

export interface WolaiDatabaseRowData {
    page_id: string;
    data: { [key: string]: any };
}

export interface WolaiDatabaseResponse {
    data?: WolaiDatabaseContent;
    has_more?: boolean;
    next_cursor?: string;
    message?: string;
    error_code?: number;
    status_code?: number;
}

export interface APICallStats {
    total: number;
    today: number;
    lastReset: number;
    hourly: number;
    hourlyLimit: number;
}

export interface WolaiBlockMetadata {
    id: string;
    type: string;
    version: number;
    edited_at: number;
    parent_id?: string;
}

export class WolaiAPI {
    private baseUrl = 'https://openapi.wolai.com/v1';
    private token: string | null = null;
    private tokenExpireTime = 0;
    private requestQueue: Promise<void> = Promise.resolve();
    private lastRequestAt = 0;
    private rateLimitUntil = 0;
    private readonly minimumRequestInterval = 1000;
    private readonly maxRateLimitRetries = 5;
    private cancellationVersion = 0;
    private activeControllers = new Set<AbortController>();
    private cancellationWaiters = new Set<() => void>();

    constructor(
        private appId: string,
        private appSecret: string,
        private logCallback?: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void,
        private beforeRequest?: () => Promise<void>,
        private slowRateLimitDelay?: () => number | null
    ) {}

    /** Serialize request starts and retry rate limits and transient failures. */
    private async fetchWithRateLimit(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const version = this.cancellationVersion;
        for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
            this.throwIfCancelled(version);
            await this.waitForRequestSlot(version);
            // The user may pause while this request is waiting in the rate-limit
            // queue, so check the gate again immediately before network I/O.
            await this.beforeRequest?.();
            this.throwIfCancelled(version);
            const controller = new AbortController();
            this.activeControllers.add(controller);
            let response: Response;
            try {
                response = await fetch(input, { ...init, signal: controller.signal });
            } catch (error) {
                if (controller.signal.aborted || version !== this.cancellationVersion) {
                    throw new Error('WOLAI_SYNC_CANCELLED');
                }
                if (attempt === this.maxRateLimitRetries) {
                    this.logCallback?.('ERROR',
                        `Wolai API 网络请求失败，已达最大重试次数 ${this.maxRateLimitRetries}：${String(error)}`);
                    throw error;
                }
                const delay = this.getRetryDelay(null, attempt);
                this.logCallback?.('WARN',
                    `Wolai API 网络请求失败，${delay}ms 后重试 (${attempt + 1}/${this.maxRateLimitRetries})：${String(error)}`);
                await this.waitCancellable(delay, version);
                continue;
            } finally {
                this.activeControllers.delete(controller);
            }

            const transientStatus = [408, 425, 500, 502, 503, 504].includes(response.status);
            if (response.status !== 429 && !transientStatus) return response;

            if (attempt === this.maxRateLimitRetries) {
                this.logCallback?.('ERROR',
                    `Wolai API HTTP ${response.status}，已达最大重试次数 ${this.maxRateLimitRetries}`);
                return response;
            }
            const retryAfter = response.headers.get('Retry-After');
            let delay = this.getRetryDelay(retryAfter, attempt);
            if (response.status === 429) {
                const slowDelay = this.slowRateLimitDelay?.();
                if (slowDelay !== null && slowDelay !== undefined) delay = Math.max(delay, slowDelay);
            }
            this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + delay);
            console.warn(`Wolai API HTTP ${response.status}; retrying in ${delay}ms (${attempt + 1}/${this.maxRateLimitRetries})`);
            this.logCallback?.('WARN',
                `Wolai API HTTP ${response.status}，${delay}ms 后重试 (${attempt + 1}/${this.maxRateLimitRetries})`);
        }
        throw new Error('Unexpected Wolai rate-limit retry state');
    }

    private async waitForRequestSlot(version: number): Promise<void> {
        let release!: () => void;
        const previous = this.requestQueue;
        this.requestQueue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            this.throwIfCancelled(version);
            const intervalWait = this.minimumRequestInterval - (Date.now() - this.lastRequestAt);
            const cooldownWait = this.rateLimitUntil - Date.now();
            const wait = Math.max(0, intervalWait, cooldownWait);
            if (wait > 0) await this.waitCancellable(wait, version);
            this.throwIfCancelled(version);
            this.lastRequestAt = Date.now();
        } finally {
            release();
        }
    }

    private throwIfCancelled(version: number): void {
        if (version !== this.cancellationVersion) throw new Error('WOLAI_SYNC_CANCELLED');
    }

    private async waitCancellable(delay: number, version: number): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.cancellationWaiters.delete(cancel);
                resolve();
            }, delay);
            const cancel = (): void => {
                window.clearTimeout(timer);
                this.cancellationWaiters.delete(cancel);
                reject(new Error('WOLAI_SYNC_CANCELLED'));
            };
            this.cancellationWaiters.add(cancel);
        });
        this.throwIfCancelled(version);
    }

    cancelPendingRequests(): void {
        this.cancellationVersion++;
        this.rateLimitUntil = 0;
        for (const controller of this.activeControllers) controller.abort();
        this.activeControllers.clear();
        const waiters = Array.from(this.cancellationWaiters);
        this.cancellationWaiters.clear();
        for (const cancel of waiters) cancel();
    }

    private isCancellationError(error: unknown): boolean {
        return String(error).includes('WOLAI_SYNC_CANCELLED') ||
            (error instanceof DOMException && error.name === 'AbortError');
    }

    private getRetryDelay(retryAfter: string | null, attempt: number): number {
        if (retryAfter) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
            const retryDate = Date.parse(retryAfter);
            if (Number.isFinite(retryDate)) return Math.max(1000, retryDate - Date.now());
        }
        return Math.min(16000, 1000 * Math.pow(2, attempt));
    }

    async createToken(): Promise<string | null> {
        try {
            const response = await this.fetchWithRateLimit(`${this.baseUrl}/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    appId: this.appId,
                    appSecret: this.appSecret
                })
            });

            const data: WolaiTokenResponse = await response.json();

            if (data.data) {
                this.token = data.data.app_token;
                this.tokenExpireTime = data.data.expire_time;
                console.log('Wolai token created successfully');

                return this.token;
            } else {
                new Notice('获取 Wolai Token 失败，请检查 AppID 和 AppSecret');
                return null;
            }
        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error creating Wolai token:', error);
            new Notice('网络错误：无法连接到 Wolai API');
            return null;
        }
    }

    async getValidToken(): Promise<string | null> {
        // 检查token是否存在且未过期（-1表示永不过期）
        if (this.token && (this.tokenExpireTime === -1 || Date.now() < this.tokenExpireTime)) {
            return this.token;
        }

        // 重新获取token
        return await this.createToken();
    }

    async validateConnection(): Promise<boolean> {
        const token = await this.getValidToken();
        return token !== null;
    }

    async insertDatabaseRow(databaseId: string, rowData: WolaiDatabaseRow): Promise<string | null> {
        const token = await this.getValidToken();
        if (!token) {
            return null;
        }

        try {
            const response = await this.fetchWithRateLimit(`${this.baseUrl}/databases/${databaseId}/rows`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token
                },
                body: JSON.stringify({
                    rows: [rowData]
                })
            });

            const data: WolaiInsertRowsResponse = await response.json();

            if (data.data && data.data.length > 0) {
                console.log('Database row inserted successfully:', data.data[0]);

                return data.data[0]; // 返回新创建行的链接
            } else {
                console.error('Failed to insert database row:', data.message);
                new Notice(`插入数据库行失败: ${data.message}`);
                return null;
            }
        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error inserting database row:', error);
            new Notice('网络错误：无法插入数据库行');
            return null;
        }
    }

    private extractPageIdFromUrl(url: string): string | null {
        // 从Wolai页面URL中提取页面ID
        // URL格式: https://www.wolai.com/{pageId}
        const match = url.match(/wolai\.com\/([a-zA-Z0-9]+)/);
        return match ? match[1] : null;
    }

    async insertDatabaseRowAndGetPageId(databaseId: string, rowData: WolaiDatabaseRow): Promise<string | null> {
        const rowUrl = await this.insertDatabaseRow(databaseId, rowData);
        if (!rowUrl) {
            return null;
        }

        return this.extractPageIdFromUrl(rowUrl);
    }

    async getDatabaseContent(databaseId: string, pageSize = 200, startCursor?: string): Promise<WolaiDatabaseContent | null> {
        const token = await this.getValidToken();
        if (!token) {
            return null;
        }

        try {
            let url = `${this.baseUrl}/databases/${databaseId}?page_size=${pageSize}`;
            if (startCursor) {
                url += `&start_cursor=${startCursor}`;
            }

            const response = await this.fetchWithRateLimit(url, {
                method: 'GET',
                headers: {
                    'Authorization': token
                }
            });

            const responseData: WolaiDatabaseResponse = await response.json();

            if (responseData.data) {
                console.log(`Retrieved ${responseData.data.rows.length} database rows`);

                return {
                    ...responseData.data,
                    has_more: responseData.has_more ?? responseData.data.has_more,
                    next_cursor: responseData.next_cursor ?? responseData.data.next_cursor
                };
            } else {
                console.error('Failed to get database content:', responseData.message);
                new Notice(`获取数据库内容失败: ${responseData.message}`);
                return null;
            }
        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error getting database content:', error);
            new Notice('网络错误：无法获取数据库内容');
            return null;
        }
    }

    async getAllDatabaseContent(databaseId: string): Promise<WolaiDatabaseRowData[]> {
        const allRows: WolaiDatabaseRowData[] = [];
        let startCursor: string | undefined = undefined;
        let hasMore = true;

        while (hasMore) {
            const content: WolaiDatabaseContent | null = await this.getDatabaseContent(databaseId, 200, startCursor);
            if (!content) {
                break;
            }

            allRows.push(...content.rows);

            hasMore = content.has_more === true && Boolean(content.next_cursor);
            startCursor = hasMore ? content.next_cursor : undefined;
        }

        console.log(`Retrieved total ${allRows.length} database rows`);
        return allRows;
    }

    async createBlocks(parentId: string, blocks: WolaiBlock[]): Promise<string | null> {
        const token = await this.getValidToken();
        if (!token) {
            return null;
        }

        try {
            // 分层处理块：先创建顶级块，再创建嵌套块
            const topLevelBlocks = blocks.filter(block => !(block as any).needsParent);
            const nestedBlocks = blocks.filter(block => (block as any).needsParent);

            // 创建顶级块
            if (topLevelBlocks.length > 0) {
                await this.createBlocksBatch(parentId, topLevelBlocks);
            }

            // 对于嵌套块，目前暂时作为顶级块处理
            // TODO: 实现真正的嵌套块创建逻辑
            if (nestedBlocks.length > 0) {
                // 清理临时属性
                const cleanedNestedBlocks = nestedBlocks.map(block => {
                    const cleanBlock = { ...block };
                    delete (cleanBlock as any).depth;
                    delete (cleanBlock as any).needsParent;
                    return cleanBlock;
                });
                await this.createBlocksBatch(parentId, cleanedNestedBlocks);
            }

            return parentId; // 返回父页面ID
        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error creating blocks:', error);
            new Notice('网络错误：无法创建块');
            return null;
        }
    }

    private async createBlocksBatch(parentId: string, blocks: WolaiBlock[]): Promise<boolean> {
        const token = await this.getValidToken();
        if (!token) {
            return false;
        }

            // 分批处理块，每批最多20个
            const batchSize = 20;
            for (let i = 0; i < blocks.length; i += batchSize) {
                const batch = blocks.slice(i, i + batchSize);

                const response = await this.fetchWithRateLimit(`${this.baseUrl}/blocks`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': token
                    },
                    body: JSON.stringify({
                        parent_id: parentId,
                        blocks: batch
                    })
                });

            // 检查HTTP状态码
            if (!response.ok) {
                console.error(`Failed to create batch ${Math.floor(i / batchSize) + 1} blocks: HTTP ${response.status} ${response.statusText}`);

                let errorMessage = `HTTP ${response.status} ${response.statusText}`;
                try {
                    // 尝试解析错误响应
                    const contentType = response.headers.get('content-type');
                    if (contentType && contentType.includes('application/json')) {
                        const errorData = await response.json();
                        errorMessage = errorData.message || errorMessage;
                    } else {
                        // 如果不是JSON响应，获取文本内容
                        const errorText = await response.text();
                        errorMessage = errorText.substring(0, 200) || errorMessage;
                    }
                } catch (parseError) {
                    console.error('Failed to parse error response:', parseError);
                }

                new Notice(`创建块失败: ${errorMessage}`);
                return false;
            }

            // 解析成功响应
            let data: WolaiCreateBlocksResponse;
            try {
                data = await response.json();
            } catch (parseError) {
                console.error(`Failed to parse response JSON for batch ${Math.floor(i / batchSize) + 1}:`, parseError);
                new Notice('创建块失败: 响应格式错误');
                return false;
            }

                if (data.data) {
                    console.log(`Batch ${Math.floor(i / batchSize) + 1} blocks created successfully:`, data.data);

                } else {
                console.error(`Failed to create batch ${Math.floor(i / batchSize) + 1} blocks:`, data.message || 'Unknown error');
                new Notice(`创建块失败: ${data.message || 'Unknown error'}`);
                return false;
                }
            }

        return true;
    }

    async retryWithExponentialBackoff<T>(
        operation: () => Promise<T>,
        maxRetries = 3,
        baseDelay = 1000
    ): Promise<T | null> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (this.isCancellationError(error)) throw error;
                if (attempt === maxRetries) {
                    console.error(`Operation failed after ${maxRetries + 1} attempts:`, error);
                    return null;
                }

                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        return null;
    }

    async getBlockMetadata(blockId: string): Promise<WolaiBlockMetadata> {
        const token = await this.getValidToken();
        if (!token) throw new Error('Unable to obtain Wolai token');
        const response = await this.fetchWithRateLimit(`${this.baseUrl}/blocks/${blockId}`, {
            method: 'GET',
            headers: { 'Authorization': token }
        });
        if (!response.ok) throw new Error(`Failed to get block metadata: HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload.data) throw new Error(payload.message || `Missing metadata for ${blockId}`);
        return payload.data as WolaiBlockMetadata;
    }

    async getPageContent(pageId: string): Promise<WolaiPageBlock[] | null> {
        const token = await this.getValidToken();
        if (!token) {
            return null;
        }

        try {
            const blocks: WolaiPageBlock[] = [];
            let cursor: string | undefined;
            const seenCursors = new Set<string>();
            do {
                const query = cursor ? `?page_size=200&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=200';
                const response = await this.fetchWithRateLimit(`${this.baseUrl}/blocks/${pageId}/children${query}`, {
                    method: 'GET',
                    headers: { 'Authorization': token }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ${response.statusText}`);
                }

                const payload: WolaiPageResponse = await response.json();
                if (!payload.data) throw new Error(payload.message || `Missing page content for ${pageId}`);
                blocks.push(...payload.data);
                if (payload.has_more === true) {
                    const suppliedCursor = typeof payload.next_cursor === 'string' && payload.next_cursor
                        ? payload.next_cursor : undefined;
                    const fallbackCursor = payload.data.length >= 200
                        ? payload.data[payload.data.length - 1]?.id : undefined;
                    const nextCursor = suppliedCursor || fallbackCursor;
                    if (!nextCursor) {
                        // Some Wolai responses incorrectly mark has_more for a
                        // short final page without returning next_cursor.
                        this.logCallback?.('WARN',
                            `页面 ${pageId} 返回 has_more 但无 next_cursor，已按最后一页处理`);
                        cursor = undefined;
                    } else if (seenCursors.has(nextCursor)) {
                        throw new Error(`Repeated pagination cursor for ${pageId}: ${nextCursor}`);
                    } else {
                        seenCursors.add(nextCursor);
                        cursor = nextCursor;
                    }
                } else {
                    cursor = undefined;
                }
            } while (cursor);

            console.log(`Retrieved page content with ${blocks.length} blocks`);
            return blocks;
        } catch (error) {
            if (this.isCancellationError(error)) throw error;
            console.error('Error getting page content:', error);
            new Notice(`获取页面内容失败: ${String(error)}`);
            throw error;
        }
    }

    async getAllPageBlocks(pageId: string): Promise<WolaiPageBlock[]> {
        const pageContent = await this.getPageContent(pageId);
        if (!pageContent) {
            throw new Error(`Unable to read Wolai page ${pageId}`);
        }

        // 递归获取所有子块
        const allBlocks = await this.expandBlocksWithChildren(pageContent);
        return allBlocks;
    }

    private async expandBlocksWithChildren(blocks: WolaiPageBlock[]): Promise<WolaiPageBlock[]> {
        const expandedBlocks: WolaiPageBlock[] = [];

        for (const block of blocks) {
            // 添加当前块
            expandedBlocks.push(block);

            // Page blocks are synchronization boundaries. Their contents are
            // fetched exactly once when the child page is processed separately.
            if (block.type !== 'page' && block.children?.ids?.length) {
                console.log(`Block ${block.id} has ${block.children.ids.length} children, fetching...`);

                try {
                    // 获取子块内容
                    const childBlocks = await this.getPageContent(block.id);
                    if (childBlocks && childBlocks.length > 0) {
                        console.log(`Retrieved ${childBlocks.length} child blocks for ${block.id}`);

                        const directChildren = childBlocks.map(childBlock => ({
                            ...childBlock,
                            isChildBlock: true,
                            parentBlockId: block.id,
                            depth: (block.depth || 0) + 1
                        }));
                        expandedBlocks.push(...await this.expandBlocksWithChildren(directChildren));
                    }
                } catch (error) {
                    if (this.isCancellationError(error)) throw error;
                    console.error(`Error fetching children for block ${block.id}:`, error);
                    throw error;
                }

                // 添加延迟避免API限制
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        return expandedBlocks;
    }
}
