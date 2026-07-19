/**
 * YouTubeClient の単体テスト
 * チャンネル ID 検証 / プレイリスト取得 / 非公開動画の除外 を検証する。
 */

import { YouTubeClient, YouTubeFetchError } from '../clients/YouTubeClient';

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const VALID_CHANNEL_ID = 'UC' + 'x'.repeat(22);

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body: any }>): void {
  let call = 0;
  global.fetch = jest.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as any;
}

describe('YouTubeClient.isValidChannelId', () => {
  it('UC で始まる 24 文字を受け入れる', () => {
    expect(YouTubeClient.isValidChannelId(VALID_CHANNEL_ID)).toBe(true);
  });

  it('動画 ID（11 文字）を拒否する', () => {
    expect(YouTubeClient.isValidChannelId('aqutSnAjK9A')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(YouTubeClient.isValidChannelId('')).toBe(false);
  });
});

describe('YouTubeClient.fetchLatestVideos', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('チャンネル ID の形式が不正なら API を呼ばずに例外を投げる', async () => {
    global.fetch = jest.fn() as any;
    const client = new YouTubeClient('dummy-key', silentLogger);

    await expect(client.fetchLatestVideos('aqutSnAjK9A')).rejects.toThrow(
      /チャンネル ID の形式が不正です/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('アップロードプレイリストから動画一覧を取得する', async () => {
    mockFetchSequence([
      {
        ok: true,
        body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUxxxx' } } }] },
      },
      {
        ok: true,
        body: {
          items: [
            {
              snippet: {
                title: '秋好ナレッジ 第1回',
                publishedAt: '2026-07-01T00:00:00Z',
                resourceId: { videoId: 'aaaaaaaaaaa' },
              },
            },
          ],
        },
      },
    ]);

    const client = new YouTubeClient('dummy-key', silentLogger);
    const videos = await client.fetchLatestVideos(VALID_CHANNEL_ID);

    expect(videos).toHaveLength(1);
    expect(videos[0].videoId).toBe('aaaaaaaaaaa');
    expect(videos[0].title).toBe('秋好ナレッジ 第1回');
    expect(videos[0].url).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa');
  });

  it('非公開・削除済み動画を除外する', async () => {
    mockFetchSequence([
      {
        ok: true,
        body: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUxxxx' } } }] },
      },
      {
        ok: true,
        body: {
          items: [
            { snippet: { title: 'Private video', resourceId: { videoId: 'aaaaaaaaaaa' } } },
            { snippet: { title: 'Deleted video', resourceId: { videoId: 'bbbbbbbbbbb' } } },
            { snippet: { title: '公開動画', resourceId: { videoId: 'ccccccccccc' } } },
          ],
        },
      },
    ]);

    const client = new YouTubeClient('dummy-key', silentLogger);
    const videos = await client.fetchLatestVideos(VALID_CHANNEL_ID);

    expect(videos).toHaveLength(1);
    expect(videos[0].videoId).toBe('ccccccccccc');
  });

  it('チャンネルが存在しなければ例外を投げる', async () => {
    mockFetchSequence([{ ok: true, body: { items: [] } }]);

    const client = new YouTubeClient('dummy-key', silentLogger);

    await expect(client.fetchLatestVideos(VALID_CHANNEL_ID)).rejects.toThrow(
      /チャンネルが見つかりません/
    );
  });

  it('403 は構造的エラーとして扱う', async () => {
    mockFetchSequence([{ ok: false, status: 403, body: { error: 'forbidden' } }]);

    const client = new YouTubeClient('dummy-key', silentLogger);

    await expect(client.fetchLatestVideos(VALID_CHANNEL_ID)).rejects.toThrow(YouTubeFetchError);
  });
});

describe('YouTubeClient.maskKey', () => {
  it('API キーをマスキングする', () => {
    expect(YouTubeClient.maskKey('AIzaSyABCDEFG')).toBe('AI****FG');
  });
});
