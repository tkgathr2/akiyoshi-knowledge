/**
 * 単体: NotionVideoLister - KnowledgeEntry → 表示用 VideoView 変換
 */
import { NotionVideoLister } from '../video/NotionVideoLister';
import { KnowledgeEntry } from '../../akiyoshi-knowledge/types/knowledge';

function entry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'page-1',
    title: 'タイトル',
    summary: '本文の要約',
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    ...over,
  } as KnowledgeEntry;
}

describe('NotionVideoLister.buildKeyPointSummary', () => {
  it('先頭の「出典: URL」行を落として本文を返す', () => {
    const s = NotionVideoLister.buildKeyPointSummary('出典: https://youtu.be/x\n要点1。要点2。');
    expect(s).toBe('要点1。要点2。');
  });

  it('240 文字を超える本文は末尾を省略記号にする', () => {
    const long = 'あ'.repeat(300);
    const s = NotionVideoLister.buildKeyPointSummary(long);
    expect(s.length).toBe(241); // 240 + …
    expect(s.endsWith('…')).toBe(true);
  });

  it('空文字は空文字を返す', () => {
    expect(NotionVideoLister.buildKeyPointSummary('')).toBe('');
  });
});

describe('NotionVideoLister.extractSourceUrl', () => {
  it('出典行から URL を取り出す', () => {
    expect(NotionVideoLister.extractSourceUrl('出典: https://youtu.be/abc\n本文')).toBe(
      'https://youtu.be/abc'
    );
  });
  it('出典が無ければ undefined', () => {
    expect(NotionVideoLister.extractSourceUrl('ただの本文')).toBeUndefined();
  });
});

describe('NotionVideoLister.toView', () => {
  it('entry.sourceUrl を優先し、無ければ summary から抽出する', () => {
    const withField = NotionVideoLister.toView(
      entry({ sourceUrl: 'https://example.com/v', summary: '出典: https://other\n本文' })
    );
    expect(withField.sourceUrl).toBe('https://example.com/v');

    const fromSummary = NotionVideoLister.toView(
      entry({ sourceUrl: undefined, summary: '出典: https://from-summary\n本文' })
    );
    expect(fromSummary.sourceUrl).toBe('https://from-summary');
  });

  it('createdAt を ISO 文字列へ変換する', () => {
    const v = NotionVideoLister.toView(entry());
    expect(v.createdAt).toBe('2026-07-20T00:00:00.000Z');
    expect(v.id).toBe('page-1');
    expect(v.title).toBe('タイトル');
  });
});

describe('NotionVideoLister.listVideos', () => {
  it('client.fetchLatest の結果を VideoView[] にして返す', async () => {
    const client = { fetchLatest: jest.fn(async () => [entry(), entry({ id: 'page-2' })]) };
    const lister = new NotionVideoLister(client as never);
    const views = await lister.listVideos(2);
    expect(client.fetchLatest).toHaveBeenCalledWith(2);
    expect(views.map((v) => v.id)).toEqual(['page-1', 'page-2']);
  });
});
