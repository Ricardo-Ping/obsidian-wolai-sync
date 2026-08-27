import { WolaiPageBlock } from './types';
import { isCompleteTextTable } from './WolaiTable';

export interface PageRevision { version: number; edited_at: number }
export interface ChildrenBatch { blocks: WolaiPageBlock[]; hasMore: boolean; nextCursor?: string }
export interface PageReadStore {
    read(pageId: string): Promise<string | null>;
    reset(pageId: string, text: string): Promise<void>;
    append(pageId: string, text: string): Promise<void>;
    remove(pageId: string): Promise<void>;
}
export interface PageReadOptions {
    metadata?: PageRevision;
    resume?: boolean;
    onProgress?: (message: string) => void;
}
interface Header extends PageRevision {
    kind: 'header'; schema: 1; pageId: string; scope: string; startedAt: number;
}
interface CachedBatch extends ChildrenBatch {
    kind: 'batch'; blockId: string; cursor: string | null; version: number; edited_at: number;
}
interface CachedTable extends PageRevision {
    kind: 'table'; blockId: string; block: WolaiPageBlock;
}

/** A short-lived, per-page read journal. Never used for outbound conflict checks. */
export class PageBlockReader {
    private readonly maxAgeMs = 24 * 60 * 60 * 1000;
    private readonly maxBatches = 5000;
    private readonly maxBlocks = 50000;
    private readonly maxDepth = 128;

    constructor(
        private fetchBatch: (blockId: string, cursor?: string) => Promise<ChildrenBatch>,
        private log: (level: 'INFO' | 'WARN', message: string) => void,
        private checkCancelled: () => void,
        private store?: PageReadStore,
        private scope = '',
        private verifyRevision?: (pageId: string) => Promise<PageRevision>,
        private fetchTable?: (blockId: string) => Promise<WolaiPageBlock>
    ) {}

    async read(pageId: string, options: PageReadOptions = {}, expand = true): Promise<WolaiPageBlock[]> {
        const started = Date.now();
        const revision = options.metadata;
        const persistent = Boolean(options.resume && revision &&
            (Number(revision.version) > 0 || Number(revision.edited_at) > 0) && this.store);
        const cache = new Map<string, CachedBatch>();
        const tables = new Map<string, CachedTable>();
        const key = (id: string, cursor?: string | null): string => JSON.stringify([id, cursor || null]);
        let header: Header = {
            kind: 'header', schema: 1, pageId, scope: this.scope, startedAt: started,
            version: Number(revision?.version || 0), edited_at: Number(revision?.edited_at || 0)
        };
        if (persistent && this.store) {
            const saved = await this.store.read(pageId);
            let usable = false;
            if (saved) {
                const lines = saved.split('\n').filter(Boolean);
                try {
                    const previous: Header = JSON.parse(lines[0]);
                    usable = previous.kind === 'header' && previous.schema === 1 &&
                        previous.pageId === pageId && previous.scope === this.scope &&
                        previous.version === header.version && previous.edited_at === header.edited_at &&
                        previous.startedAt <= started && started - previous.startedAt < this.maxAgeMs;
                    if (usable) {
                        header = previous;
                        for (const line of lines.slice(1)) {
                            try {
                                const entry: CachedBatch | CachedTable = JSON.parse(line);
                                if (entry.kind === 'table' && typeof entry.blockId === 'string' &&
                                    entry.block?.id === entry.blockId && isCompleteTextTable(entry.block)) {
                                    tables.set(entry.blockId, entry);
                                }
                                if (entry.kind === 'batch' && typeof entry.blockId === 'string' &&
                                    (entry.cursor === null || typeof entry.cursor === 'string') &&
                                    Array.isArray(entry.blocks) && typeof entry.hasMore === 'boolean') {
                                    cache.set(key(entry.blockId, entry.cursor), entry);
                                }
                            } catch { /* An interrupted append does not invalidate preceding batches. */ }
                        }
                    }
                } catch { usable = false; }
            }
            if (!usable) {
                await this.store.reset(pageId, JSON.stringify(header) + '\n');
                if (saved) this.log('INFO', `页内断点已失效，重新读取：${pageId}（版本、账号或有效期变化）`);
            } else {
                this.log('INFO', `恢复页内断点：${pageId}；已缓存 ${cache.size} 个分页批次`);
            }
        }

        let networkBatches = 0;
        let cachedBatches = 0;
        let processedBatches = 0;
        const visited = new Set<string>();
        const output: WolaiPageBlock[] = [];
        const fullTable = async (block: WolaiPageBlock): Promise<WolaiPageBlock | null> => {
            if (isCompleteTextTable(block)) return block;
            if (!this.fetchTable) return null;
            this.checkCancelled();
            const cached = tables.get(block.id);
            const valid = cached && cached.version === Number(block.version || 0) &&
                cached.edited_at === Number(block.edited_at || 0);
            if (++processedBatches > this.maxBatches) throw new Error(`PAGE_READ_LIMIT: ${pageId}`);
            options.onProgress?.(`正在整表读取 ${block.id}；网络 ${networkBatches} 批（重试另计），复用 ${cachedBatches} 批`);
            const detail = valid ? cached.block : await this.fetchTable(block.id);
            this.checkCancelled();
            if (valid) cachedBatches++;
            else networkBatches++;
            if (detail.id !== block.id || detail.type !== 'table' ||
                Number(detail.version || 0) !== Number(block.version || 0) ||
                Number(detail.edited_at || 0) !== Number(block.edited_at || 0)) {
                if (persistent) await this.store?.remove(pageId);
                throw new Error(`PAGE_CHANGED_DURING_READ: 表格 ${block.id} 的版本变化，未写入混合版本`);
            }
            if (!isCompleteTextTable(detail)) {
                this.log('WARN', `整表数据不完整或含不支持的单元格，保留逐块读取：${block.id}`);
                return null;
            }
            if (!valid) {
                const entry: CachedTable = { kind: 'table', blockId: block.id, block: detail,
                    version: Number(block.version || 0), edited_at: Number(block.edited_at || 0) };
                tables.set(block.id, entry);
                if (persistent && this.store) await this.store.append(pageId, '\n' + JSON.stringify(entry) + '\n');
            }
            this.log('INFO', `整表读取完成：${block.id}；${detail.table_content.length} 行 × ${detail.table_content[0].length} 列；${valid ? '复用断点，0 次请求' : '1 次详情读取（重试另计）'}，跳过 ${detail.children.ids.length} 个单元格的逐格请求`);
            return { ...block, ...detail, ...(valid ? { fromReadCheckpoint: true } : {}) };
        };
        const children = async (blockId: string, parentRevision: PageRevision): Promise<WolaiPageBlock[]> => {
            const result: WolaiPageBlock[] = [];
            const ids = new Set<string>();
            const cursors = new Set<string>();
            let cursor: string | undefined;
            let page = 0;
            do {
                this.checkCancelled();
                if (++processedBatches > this.maxBatches) throw new Error(`PAGE_READ_LIMIT: ${pageId} exceeds ${this.maxBatches} batches`);
                page++;
                const cached = cache.get(key(blockId, cursor));
                const useCached = cached && cached.version === Number(parentRevision.version || 0) &&
                    cached.edited_at === Number(parentRevision.edited_at || 0);
                options.onProgress?.(`读取内容块 ${blockId}，第 ${page} 批；已收集 ${visited.size} 块，网络 ${networkBatches} 批，复用 ${cachedBatches} 批`);
                const batch = useCached ? cached : await this.fetchBatch(blockId, cursor);
                this.checkCancelled();
                if (!Array.isArray(batch.blocks) || batch.blocks.some(b => !b || typeof b.id !== 'string' || !b.id)) {
                    throw new Error(`INVALID_BLOCK_BATCH: ${blockId}`);
                }
                let added = 0;
                for (const block of batch.blocks) {
                    if (ids.has(block.id)) {
                        this.log('WARN', `去重分页重复块：页面 ${pageId}，块 ${block.id}`);
                        continue;
                    }
                    ids.add(block.id);
                    added++;
                    result.push({ ...block, ...(useCached ? { fromReadCheckpoint: true } : {}) });
                    if (result.length > this.maxBlocks) throw new Error(`PAGE_READ_LIMIT: too many blocks in ${blockId}`);
                }
                let next: string | undefined;
                if (batch.hasMore) {
                    next = batch.nextCursor || (batch.blocks.length >= 200 ? batch.blocks[batch.blocks.length - 1]?.id : undefined);
                    if (!next) {
                        // Fail closed: a short batch can still have another page.
                        throw new Error(`Missing next_cursor for ${blockId}: has_more 但无 next_cursor，保留断点，未将不完整内容视为完成`);
                    }
                    if (!added) throw new Error(`PAGE_PAGINATION_NO_PROGRESS: ${blockId}`);
                    if (next === cursor || cursors.has(next)) throw new Error(`Repeated pagination cursor for ${blockId}: ${next}`);
                    cursors.add(next);
                }
                if (useCached) cachedBatches++;
                else {
                    networkBatches++;
                    const entry: CachedBatch = { ...batch, kind: 'batch', blockId, cursor: cursor || null,
                        version: Number(parentRevision.version || 0), edited_at: Number(parentRevision.edited_at || 0) };
                    if (persistent && this.store) {
                        // Separate a torn final record from the next valid record.
                        await this.store.append(pageId, '\n' + JSON.stringify(entry) + '\n');
                    }
                    cache.set(key(blockId, cursor), entry);
                }
                this.log('INFO', `页内读取：页面 ${pageId}，块 ${blockId}，第 ${page} 批，${batch.blocks.length} 块，${useCached ? '复用断点' : '网络读取'}，${next ? '仍有分页' : '该层完成'}`);
                cursor = next;
            } while (cursor);
            return result;
        };

        const walk = async (blocks: WolaiPageBlock[], ancestors: Set<string>, depth: number, parentId?: string): Promise<void> => {
            if (depth > this.maxDepth) throw new Error(`PAGE_DEPTH_LIMIT: ${pageId}`);
            for (const original of blocks) {
                let block = original;
                this.checkCancelled();
                if (ancestors.has(block.id)) throw new Error(`PAGE_BLOCK_CYCLE: 页面 ${pageId}，块 ${block.id}`);
                if (visited.has(block.id)) {
                    this.log('WARN', `去重重复引用块：页面 ${pageId}，块 ${block.id}`);
                    continue;
                }
                visited.add(block.id);
                if (visited.size > this.maxBlocks) throw new Error(`PAGE_READ_LIMIT: ${pageId} exceeds ${this.maxBlocks} blocks`);
                let tableComplete = false;
                if (expand && block.type === 'table') {
                    const table = await fullTable(block);
                    if (table) { block = table; tableComplete = true; }
                }
                output.push(parentId ? { ...block, isChildBlock: true, parentBlockId: parentId, depth } : block);
                // Child pages are independent synchronization boundaries.
                if (expand && !tableComplete && block.type !== 'page' && block.children?.ids?.length) {
                    const branch = new Set(ancestors);
                    branch.add(block.id);
                    const nested = await children(block.id, {
                        version: Number(block.version || 0), edited_at: Number(block.edited_at || 0)
                    });
                    await walk(nested, branch, depth + 1, block.id);
                }
            }
        };
        try {
            await walk(await children(pageId, header), new Set([pageId]), 0);
            if (persistent && this.verifyRevision && (cachedBatches > 0 || Date.now() - started > 60000)) {
                options.onProgress?.(`页内读取完成，正在复核页面版本；网络 ${networkBatches} 批，复用 ${cachedBatches} 批`);
                const latest = await this.verifyRevision(pageId);
                if (Number(latest.version || 0) !== header.version || Number(latest.edited_at || 0) !== header.edited_at) {
                    await this.store?.remove(pageId);
                    throw new Error(`PAGE_CHANGED_DURING_READ: ${pageId}；未写入混合版本，请重试`);
                }
            }
            this.checkCancelled();
            this.log('INFO', `页内读取完成：${pageId}；${output.length} 块，网络 ${networkBatches} 批，复用 ${cachedBatches} 批`);
            return output;
        } catch (error) {
            // Repeat attempts must not trust a persistently malformed graph.
            if (/PAGE_BLOCK_CYCLE|PAGE_PAGINATION_NO_PROGRESS|Repeated pagination cursor/.test(String(error))) {
                if (persistent) await this.store?.remove(pageId);
            }
            throw error;
        }
    }
}
