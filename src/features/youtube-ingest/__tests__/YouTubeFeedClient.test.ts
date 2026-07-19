/**
 * YouTubeFeedClient の単体テスト
 *
 * サンプル XML は実際の
 * https://www.youtube.com/feeds/videos.xml?channel_id=UCEO389HqxYFp7WhfmXV-5WQ
 * のレスポンス構造をそのまま縮小したもの（2026-07-19 実測）。
 * 実フィードで使われるエンティティは &amp; と &quot; の単一エスケープのみ（実測で確認）。
 */

import { YouTubeFeedClient, YouTubeFeedError } from '../clients/YouTubeFeedClient';

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const CHANNEL_ID = 'UCEO389HqxYFp7WhfmXV-5WQ';

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>EO389HqxYFp7WhfmXV-5WQ</yt:channelId>
 <title>らんさ〜ず</title>
 <entry>
  <id>yt:video:oTlVIkNiKbQ</id>
  <yt:videoId>oTlVIkNiKbQ</yt:videoId>
  <title>【AI経営システム】会社の動きが手に取るようにわかる</title>
  <published>2026-07-18T10:00:29+00:00</published>
 </entry>
 <entry>
  <id>yt:video:aqutSnAjK9A</id>
  <yt:videoId>aqutSnAjK9A</yt:videoId>
  <title>AI &amp; 経営 &quot;対談&quot;</title>
  <published>2026-07-10T09:00:00+00:00</published>
 </entry>
</feed>`;

function mockFetch(body: string, ok = true, status = 200): void {
  global.fetch = jest.fn(async () => ({
    ok,
    status,
    text: async () => body,
  })) as any;
}

describe('YouTubeFeedClient.isValidChannelId', () => {
  it('UC で始まる 24 文字を受け入れる', () => {
    expect(YouTubeFeedClient.isValidChannelId(CHANNEL_ID)).toBe(true);
  });

  it('動画 ID（11 文字）を拒否する', () => {
    expect(YouTubeFeedClient.isValidChannelId('aqutSnAjK9A')).toBe(false);
  });
});

describe('YouTubeFeedClient.fetchLatestVideos', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API キーなしでフィードから動画一覧を取得する', async () => {
    mockFetch(SAMPLE_FEED);
    const client = new YouTubeFeedClient(silentLogger);

    const videos = await client.fetchLatestVideos(CHANNEL_ID);

    expect(videos).toHaveLength(2);
    expect(videos[0].videoId).toBe('oTlVIkNiKbQ');
    expect(videos[0].url).toBe('https://www.youtube.com/watch?v=oTlVIkNiKbQ');
    expect(videos[0].publishedAt.toISOString()).toBe('2026-07-18T10:00:29.000Z');

    // リクエスト URL に API キーが含まれないこと
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('feeds/videos.xml');
    expect(calledUrl).not.toContain('key=');
  });

  it('タイトルの XML エンティティをデコードする', async () => {
    mockFetch(SAMPLE_FEED);
    const client = new YouTubeFeedClient(silentLogger);

    const videos = await client.fetchLatestVideos(CHANNEL_ID);

    expect(videos[1].title).toBe('AI & 経営 "対談"');
  });

  it('公開日の新しい順に並べる', async () => {
    mockFetch(SAMPLE_FEED);
    const client = new YouTubeFeedClient(silentLogger);

    const videos = await client.fetchLatestVideos(CHANNEL_ID);

    expect(videos.map((v) => v.videoId)).toEqual(['oTlVIkNiKbQ', 'aqutSnAjK9A']);
  });

  it('limit で件数を絞る', async () => {
    mockFetch(SAMPLE_FEED);
    const client = new YouTubeFeedClient(silentLogger);

    const videos = await client.fetchLatestVideos(CHANNEL_ID, 1);

    expect(videos).toHaveLength(1);
    expect(videos[0].videoId).toBe('oTlVIkNiKbQ');
  });

  it('チャンネル ID の形式が不正なら取得せず例外を投げる', async () => {
    global.fetch = jest.fn() as any;
    const client = new YouTubeFeedClient(silentLogger);

    await expect(client.fetchLatestVideos('aqutSnAjK9A')).rejects.toThrow(
      /チャンネル ID の形式が不正です/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('404 は YouTubeFeedError を投げる', async () => {
    mockFetch('not found', false, 404);
    const client = new YouTubeFeedClient(silentLogger);

    await expect(client.fetchLatestVideos(CHANNEL_ID)).rejects.toThrow(YouTubeFeedError);
  });

  it('entry が無いフィードは空配列を返す', async () => {
    mockFetch('<?xml version="1.0"?><feed><title>空</title></feed>');
    const client = new YouTubeFeedClient(silentLogger);

    const videos = await client.fetchLatestVideos(CHANNEL_ID);

    expect(videos).toEqual([]);
  });
});
