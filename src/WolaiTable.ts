import { CreateRichText, WolaiPageBlock, WolaiRichText, WolaiTableCell, WolaiTableSetting } from './types';

const richKeys = new Set(['title', 'type', 'bold', 'italic', 'underline', 'highlight',
    'strikethrough', 'inline_code', 'front_color', 'back_color', 'link']);
function supportedContent(content: unknown): boolean {
    if (typeof content === 'string') return true;
    if (Array.isArray(content)) return content.every(supportedContent);
    if (!content || typeof content !== 'object') return false;
    const item = content as WolaiRichText;
    return typeof item.title === 'string' && (!item.type || ['text', 'equation'].includes(item.type)) &&
        (!(item.type === 'equation' || item.inline_code) || !/[\r\n]/.test(item.title)) &&
        !(item.type === 'equation' && /\|/.test(item.title) && /\\(?:text|verb|url|href)\b/.test(item.title)) &&
        Object.keys(item).every(k => richKeys.has(k));
}

/** Only skip descendants when the detail endpoint supplied a complete, supported matrix. */
export function isCompleteTextTable(block: WolaiPageBlock): block is WolaiPageBlock & {
    table_content: WolaiTableCell[][]; table_setting: WolaiTableSetting; children: { ids: string[]; api_url: string }
} {
    const rows = block.table_content;
    if (block.type !== 'table' || !Array.isArray(rows) || !rows.length ||
        typeof block.table_setting?.has_header !== 'boolean') return false;
    const width = Array.isArray(rows[0]) ? rows[0].length : 0;
    if (!width || rows.length * width > 50000 ||
        (block.table_setting.column_widths && block.table_setting.column_widths.length !== width)) return false;
    const ids = block.children?.ids;
    if (!Array.isArray(ids) || ids.length !== rows.length * width ||
        new Set(ids).size !== ids.length || (block.caption && !supportedContent(block.caption))) return false;
    return rows.every(row => Array.isArray(row) && row.length === width && row.every(cell =>
        cell && typeof cell === 'object' && Object.keys(cell).every(k => k === 'content') &&
        supportedContent(cell.content)));
}

function escapeText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/([\\`*_[\]~|$])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>')
        .replace(/^ +| +$/g, spaces => '&#32;'.repeat(spaces.length));
}

function richText(content: CreateRichText): string {
    if (typeof content === 'string') return escapeText(content);
    if (Array.isArray(content)) return content.map(richText).join('');
    if (content.type === 'equation') {
        // Raw pipes split GFM cells; \| denotes a *double* bar in TeX.
        // Use equivalent TeX commands, not Markdown escaping inside a formula.
        const formula = content.title.replace(/(\\*)\|/g, (_match, slashes: string) =>
            slashes.length % 2 ? slashes.slice(0, -1) + '\\Vert{}' : slashes + '\\vert{}');
        return `$${formula}$`;
    }
    let text = escapeText(content.title);
    if (content.inline_code) {
        const ticks = '`'.repeat(Math.max(0, ...(content.title.match(/`+/g) || []).map(x => x.length)) + 1);
        const value = content.title.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
        text = `${ticks} ${value} ${ticks}`;
    } else {
        if (content.bold) text = `**${text}**`;
        if (content.italic) text = `*${text}*`;
        if (content.strikethrough) text = `~~${text}~~`;
        if (content.underline) text = `<u>${text}</u>`;
    }
    if (content.link) {
        const url = content.link.replace(/[\s<>|()]/g, c => encodeURIComponent(c));
        text = `[${text}](${url})`;
    }
    return text;
}

export function renderWolaiTable(block: WolaiPageBlock): string | null {
    if (!isCompleteTextTable(block)) return null;
    const rows = block.table_content.map(row => row.map(cell => richText(cell.content)));
    // Markdown requires a header. An empty header preserves a headerless first data row.
    if (!block.table_setting.has_header) rows.unshift(rows[0].map(() => ''));
    const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
    const result = [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)];
    if (block.caption) result.push('', richText(block.caption));
    return `<!-- wolai-table:${block.id.replace(/[^A-Za-z0-9_-]/g, '')} -->\n${result.join('\n')}`;
}
