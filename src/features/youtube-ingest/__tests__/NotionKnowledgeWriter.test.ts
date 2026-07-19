/**
 * NotionKnowledgeWriter の単体テスト
 *
 * 特に重要なのが status='完了' の検証。読み取り側 NotionKnowledgeClient は
 * status='完了' で絞り込むため、書き込み時にこれを入れ忘れると
 * 取り込んだ動画が読み取りパイプラインに一切乗らない（サイレント欠落）。
 */

import { NotionKnowledgeWriter } from '../writers/NotionKnowledgeWriter';
import { TranscribedVideo } from '../types/video';

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const DB_ID = 'db-1234';

function makeVideo(overrides: Partial<TranscribedVideo> = {}): TranscribedVideo {
  return {
    videoId: 'aqutSnAjK9A',
    title: 'テスト動画',
    publishedAt: new Date('2026-07-01'),
    url: 'https://www.youtube.com/watch?v=aqutSnAjK9A',
    transcript: 'これは文字起こしです。',
    ...overrides,
  };
}

/** Writer 内部の Notion クライアントを差し替える */
function stubClient(writer: NotionKnowledgeWriter) {
  const createMock = jest.fn().mockResolvedValue({ id: 'page-1' });
  const appendMock = jest.fn().mockResolvedValue({});
  const queryMock = jest.fn().mockResolvedValue({ results: [], has_more: false });

  (writer as any).client = {
    pages: { create: createMock },
    blocks: { children: { append: appendMock } },
    databases: { query: queryMock },
  };

  return { createMock, appendMock, queryMock };
}

describe('NotionKnowledgeWriter.writeVideo', () => {
  it("status='完了' を設定する（読み取り側のフィルタ条件と一致させる）", async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { createMock } = stubClient(writer);

    await writer.writeVideo(makeVideo());

    const arg = createMock.mock.calls[0][0];
    expect(arg.properties.status).toEqual({ status: { name: '完了' } });
  });

  it('title と summary を設定し、summary 先頭に出典 URL を入れる', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { createMock } = stubClient(writer);

    await writer.writeVideo(makeVideo({ title: '秋好ナレッジ 第1回' }));

    const arg = createMock.mock.calls[0][0];
    expect(arg.properties.title.title[0].text.content).toBe('秋好ナレッジ 第1回');

    const summary = arg.properties.summary.rich_text[0].text.content;
    expect(summary.startsWith('出典: https://www.youtube.com/watch?v=aqutSnAjK9A')).toBe(true);
    expect(summary).toContain('これは文字起こしです。');
  });

  it('summary は Notion の 2000 字上限を超えない', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { createMock } = stubClient(writer);

    await writer.writeVideo(makeVideo({ transcript: 'あ'.repeat(5000) }));

    const summary = createMock.mock.calls[0][0].properties.summary.rich_text[0].text.content;
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(summary.endsWith('...')).toBe(true);
  });

  it('長い文字起こしを 2000 字ごとの段落ブロックへ分割する', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { createMock } = stubClient(writer);

    await writer.writeVideo(makeVideo({ transcript: 'あ'.repeat(4500) }));

    const children = createMock.mock.calls[0][0].children;
    expect(children).toHaveLength(3); // 2000 + 2000 + 500
    expect(children[0].paragraph.rich_text[0].text.content).toHaveLength(2000);
    expect(children[2].paragraph.rich_text[0].text.content).toHaveLength(500);
  });

  it('100 ブロックを超える分は append で追記する（1 リクエスト上限対策）', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { createMock, appendMock } = stubClient(writer);

    // 2000 字 x 101 ブロック分
    await writer.writeVideo(makeVideo({ transcript: 'あ'.repeat(2000 * 101) }));

    expect(createMock.mock.calls[0][0].children).toHaveLength(100);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock.mock.calls[0][0].children).toHaveLength(1);
  });
});

describe('NotionKnowledgeWriter.fetchIngestedVideoIds', () => {
  it('summary の出典 URL から取込済み動画 ID を抽出する', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { queryMock } = stubClient(writer);

    queryMock.mockResolvedValue({
      results: [
        {
          properties: {
            summary: {
              type: 'rich_text',
              rich_text: [{ plain_text: '出典: https://www.youtube.com/watch?v=aqutSnAjK9A\n本文' }],
            },
          },
        },
        {
          properties: {
            summary: {
              type: 'rich_text',
              rich_text: [{ plain_text: '出典: https://www.youtube.com/watch?v=bbbbbbbbbbb' }],
            },
          },
        },
      ],
      has_more: false,
    });

    const ids = await writer.fetchIngestedVideoIds();

    expect(ids.has('aqutSnAjK9A')).toBe(true);
    expect(ids.has('bbbbbbbbbbb')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('出典 URL を持たない既存ページ（手動追記分）は無視する', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { queryMock } = stubClient(writer);

    queryMock.mockResolvedValue({
      results: [
        { properties: { summary: { type: 'rich_text', rich_text: [{ plain_text: '手動メモ' }] } } },
        { properties: {} },
      ],
      has_more: false,
    });

    const ids = await writer.fetchIngestedVideoIds();

    expect(ids.size).toBe(0);
  });
});
