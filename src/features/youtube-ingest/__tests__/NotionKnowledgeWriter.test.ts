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

describe('NotionKnowledgeWriter.fetchIngestedKeys', () => {
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

    const ids = await writer.fetchIngestedKeys();

    expect(ids.has('aqutSnAjK9A')).toBe(true);
    expect(ids.has('bbbbbbbbbbb')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('人が書いた「動画ID: xxx」形式からも動画 ID を抽出する', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { queryMock } = stubClient(writer);

    // 実データ（本番 Notion 2026-07-19 実測）の書式
    queryMock.mockResolvedValue({
      results: [
        {
          properties: {
            summary: {
              type: 'rich_text',
              rich_text: [
                {
                  plain_text:
                    '出典：らんさ〜ずチャンネル（動画ID: aqutSnAjK9A / 長さ: 23:17 / アップロード: 2026-07-17）。要点：',
                },
              ],
            },
          },
        },
      ],
      has_more: false,
    });

    const keys = await writer.fetchIngestedKeys();

    expect(keys.has('aqutSnAjK9A')).toBe(true);
  });

  it('手動追記ページのタイトルも鍵にする（実データで重複を防げること）', async () => {
    const writer = new NotionKnowledgeWriter('key', DB_ID, silentLogger);
    const { queryMock } = stubClient(writer);

    // 実データ（本番 Notion 2026-07-19 実測）: 日付接頭辞つき・半角ダブルクォート
    queryMock.mockResolvedValue({
      results: [
        {
          properties: {
            title: {
              type: 'title',
              title: [
                {
                  plain_text:
                    '2026-07-18｜農業AIスタートアップが作った"AI経営システム"を見せてもらったら凄すぎてひいちゃった｜東証上場社長',
                },
              ],
            },
          },
        },
      ],
      has_more: false,
    });

    const keys = await writer.fetchIngestedKeys();

    // 実データ（YouTube RSS 2026-07-19 実測）: カーリークォート
    const fromYouTube = NotionKnowledgeWriter.normalizeTitle(
      '農業AIスタートアップが作った”AI経営システム”を見せてもらったら凄すぎてひいちゃった｜東証上場社長'
    );
    expect(fromYouTube).not.toBeNull();
    expect(keys.has(fromYouTube as string)).toBe(true);
  });
});

describe('NotionKnowledgeWriter.normalizeTitle', () => {
  it('日付接頭辞を取り除く', () => {
    expect(NotionKnowledgeWriter.normalizeTitle('2026-07-18｜地方企業のマイクロM＆Aは伸びる')).toBe(
      NotionKnowledgeWriter.normalizeTitle('地方企業のマイクロM＆Aは伸びる')
    );
  });

  it('引用符・括弧・空白の揺れを吸収する', () => {
    expect(NotionKnowledgeWriter.normalizeTitle('【売上の伸ばし方】伸びない経営者の特徴3選')).toBe(
      NotionKnowledgeWriter.normalizeTitle('売上の伸ばし方 伸びない経営者の特徴3選')
    );
  });

  it('全角と半角の違いを吸収する', () => {
    expect(NotionKnowledgeWriter.normalizeTitle('ＡＩ経営システムの話をします')).toBe(
      NotionKnowledgeWriter.normalizeTitle('AI経営システムの話をします')
    );
  });

  it('別の動画は別の鍵になる', () => {
    expect(NotionKnowledgeWriter.normalizeTitle('起業初心者が見落とす最初のステップ')).not.toBe(
      NotionKnowledgeWriter.normalizeTitle('起業家が絶対にやるべき1つのこと')
    );
  });

  it('短すぎるタイトルは鍵にしない（誤一致を防ぐ）', () => {
    expect(NotionKnowledgeWriter.normalizeTitle('短い')).toBeNull();
    expect(NotionKnowledgeWriter.normalizeTitle(null)).toBeNull();
  });
});
