/**
 * TranscriptClient の単体テスト
 * 言語フォールバック / エンティティデコード / 字幕なし を検証する。
 */

import { TranscriptClient, TranscriptUnavailableError } from '../clients/TranscriptClient';
import { YouTubeVideo } from '../types/video';

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const video: YouTubeVideo = {
  videoId: 'aaaaaaaaaaa',
  title: 'テスト動画',
  publishedAt: new Date('2026-07-01'),
  url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
};

describe('TranscriptClient', () => {
  it('字幕セグメントを 1 本のテキストへ連結する', async () => {
    const fetcher = jest.fn().mockResolvedValue([
      { text: 'こんにちは', duration: 1, offset: 0 },
      { text: '秋好です', duration: 1, offset: 1 },
    ]);

    const client = new TranscriptClient(fetcher, ['ja'], silentLogger);
    const result = await client.transcribe(video);

    expect(result.transcript).toBe('こんにちは 秋好です');
    expect(result.videoId).toBe('aaaaaaaaaaa');
  });

  it('HTML エンティティをデコードする（二重エスケープ含む）', async () => {
    const fetcher = jest.fn().mockResolvedValue([
      { text: 'it&amp;#39;s', duration: 1, offset: 0 },
      { text: '&quot;quoted&quot;', duration: 1, offset: 1 },
    ]);

    const client = new TranscriptClient(fetcher, ['en'], silentLogger);
    const result = await client.transcribe(video);

    expect(result.transcript).toBe(`it's "quoted"`);
  });

  it('日本語字幕が無ければ英語へフォールバックする', async () => {
    const fetcher = jest.fn(async (_id: string, config?: { lang?: string }) => {
      if (config?.lang === 'ja') throw new Error('no ja captions');
      return [{ text: 'english caption', duration: 1, offset: 0 }];
    });

    const client = new TranscriptClient(fetcher, ['ja', 'en'], silentLogger);
    const result = await client.transcribe(video);

    expect(result.transcript).toBe('english caption');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('全言語で失敗したら TranscriptUnavailableError を投げる', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('Transcript is disabled'));

    const client = new TranscriptClient(fetcher, ['ja', 'en'], silentLogger);

    await expect(client.transcribe(video)).rejects.toThrow(TranscriptUnavailableError);
    // ja / en / 言語指定なし の 3 回試行する
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('空の字幕は失敗として扱う', async () => {
    const fetcher = jest.fn().mockResolvedValue([]);

    const client = new TranscriptClient(fetcher, ['ja'], silentLogger);

    await expect(client.transcribe(video)).rejects.toThrow(TranscriptUnavailableError);
  });
});
