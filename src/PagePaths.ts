export interface PagePathState { schema: 1; scope: string; pages: Record<string, string> }
export interface PathOccupant { path: string; owner?: string; folder?: boolean }
export const safePageName = (title: string): string => {
    const name = title.replace(/[<>:"/\\|?*]/g, '_');
    return !name || /^\.+$/.test(name) ? 'Page' : name;
};
const key = (path: string): string => path.normalize('NFC').toLowerCase();

/** Persist reservations before writing notes; never infer ownership from a title. */
export class PagePaths {
    constructor(readonly root: string, readonly state: PagePathState,
        private occupant: (path: string) => Promise<PathOccupant | null>,
        private save: (state: PagePathState) => Promise<void>) {}

    valid(path: string): boolean {
        return typeof path === 'string' && path.startsWith(this.root + '/') && path.endsWith('.md') &&
            !path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) &&
            !path.startsWith(this.root + '/_conflicts/');
    }

    async resolve(id: string, title: string, relativeDir: string, previous?: string): Promise<string> {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('INVALID_PAGE_ID');
        const directory = [this.root, relativeDir].filter(Boolean).join('/');
        const requested = `${directory}/${safePageName(title)}.md`;
        if (!this.valid(requested)) throw new Error('UNSAFE_PAGE_PATH');
        const available = async (candidate: string, reserved = false): Promise<string | null> => {
            if (!this.valid(candidate) || (!reserved && candidate.slice(0, candidate.lastIndexOf('/')) !== directory)) return null;
            const stem = candidate.slice(candidate.lastIndexOf('/') + 1, -3);
            if (['pictures', '_conflicts'].includes(key(stem))) return null;
            if (Object.entries(this.state.pages).some(([owner, path]) => owner !== id && key(path) === key(candidate))) return null;
            const entry = await this.occupant(candidate);
            if (entry?.folder || (entry?.owner && entry.owner !== id)) return null;
            // A preexisting unlinked note is still checked by baseline/conflict
            // protection; reserving its name does not authorize overwriting it.
            const companion = await this.occupant(candidate.slice(0, -3));
            if (companion && !companion.folder) return null;
            return entry?.path || candidate;
        };
        const reserved = this.state.pages[id];
        let resolved: string | null = reserved ? await available(reserved, true) : null;
        for (const candidate of [previous, requested]) {
            if (resolved) break;
            if (candidate && (resolved = await available(candidate))) break;
        }
        for (let length = Math.min(8, id.length); !resolved && length <= id.length; length++) {
            resolved = await available(`${directory}/${safePageName(title)}--${id.slice(0, length)}.md`);
        }
        if (!resolved) throw new Error(`SYNC_PATH_CONFLICT: 页面 ${id} 的安全备用路径也被占用`);
        if (this.state.pages[id] !== resolved) {
            const next = { ...this.state, pages: { ...this.state.pages, [id]: resolved } };
            await this.save(next);
            this.state.pages = next.pages;
        }
        return resolved;
    }
}
