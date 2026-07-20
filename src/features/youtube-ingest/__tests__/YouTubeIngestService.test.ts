/**
 * YouTubeIngestService の単体テスト
 * 正常系 / 重複除外 / 字幕なしスキップ / 上限 を検証する。
 */

import { YouTubeIngestService } from '../YouTubeIngestService';
import { TranscriptUnavailableError } from '../clients/TranscriptClient';
import { YouTubeVideo, TranscribedVideo } from '../types/video';

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

function makeVideo(id: string, daysAgo = 0): YouTubeVideo {
  return {
    videoId: id,
    title: `動画 ${id}`,
    publishedAt: new Date(Date.now() - daysAgo * 86400000),
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function makeDeps(videos: YouTubeVideo[], ingested: string[] = []) {
  const written: TranscribedVideo[] = [];

  const youtube = {
    fetchLatestVideos: jest.fn().mockResolvedValue(videos),
  } as any;

  const transcriber = {
    transcribe: jest.fn(async (v: YouTubeVideo) => ({ ...v, transcript: `${v.videoId} の文字起こし` })),
  } as any;

  const writer = {
    fetchIngestedKeys: jest.fn().mockResolvedValue(new Set(ingested)),
    writeVideo: jest.fn(async (v: TranscribedVideo) => {
      written.push(v);
      return `page-${v.videoId}`;
    }),
  } as any;

  return { youtube, transcriber, writer, written };
}

describe('YouTubeIngestService', () => {
  it('新規動画を文字起こしして Notion に書き込む', async () => {
    const { youtube, transcriber, writer, written } = makeDeps([
      makeVideo('aaaaaaaaaaa'),
      makeVideo('bbbbbbbbbbb'),
    ]);

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22) },
      silentLogger
    );

    const result = await service.run();

    expect(result.fetched).toBe(2);
    expect(result.newVideos).toBe(2);
    expect(result.written).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(written.map((v) => v.videoId).sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(written[0].transcript).toContain('文字起こし');
  });

  it('Notion に既にある動画は再度書き込まない（重複防止）', async () => {
    const { youtube, transcriber, writer } = makeDeps(
      [makeVideo('aaaaaaaaaaa'), makeVideo('bbbbbbbbbbb')],
      ['aaaaaaaaaaa']
    );

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22) },
      silentLogger
    );

    const result = await service.run();

    expect(result.newVideos).toBe(1);
    expect(result.written).toBe(1);
    expect(writer.writeVideo).toHaveBeenCalledTimes(1);
  });

  it('字幕が無い動画はスキップして他の動画の処理を続ける', async () => {
    const { youtube, transcriber, writer } = makeDeps([
      makeVideo('aaaaaaaaaaa', 2),
      makeVideo('bbbbbbbbbbb', 1),
    ]);

    transcriber.transcribe = jest.fn(async (v: YouTubeVideo) => {
      if (v.videoId === 'aaaaaaaaaaa') {
        throw new TranscriptUnavailableError(v.videoId, 'no captions');
      }
      return { ...v, transcript: 'ok' };
    });

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22) },
      silentLogger
    );

    const result = await service.run();

    expect(result.written).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].videoId).toBe('aaaaaaaaaaa');
    expect(result.skipped[0].reason).toContain('字幕を取得できません');
  });

  it('新規動画が無ければ何も書き込まない', async () => {
    const { youtube, transcriber, writer } = makeDeps([makeVideo('aaaaaaaaaaa')], ['aaaaaaaaaaa']);

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22) },
      silentLogger
    );

    const result = await service.run();

    expect(result.newVideos).toBe(0);
    expect(result.written).toBe(0);
    expect(writer.writeVideo).not.toHaveBeenCalled();
  });

  it('maxWritesPerCycle を超えて書き込まない（公開が古い順に処理）', async () => {
    const { youtube, transcriber, writer, written } = makeDeps([
      makeVideo('newnewnewne', 1),
      makeVideo('oldoldoldol', 5),
      makeVideo('midmidmidmi', 3),
    ]);

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22), maxWritesPerCycle: 2 },
      silentLogger
    );

    const result = await service.run();

    expect(result.newVideos).toBe(3);
    expect(result.written).toBe(2);
    // 古い順 = oldoldoldol → midmidmidmi
    expect(written.map((v) => v.videoId)).toEqual(['oldoldoldol', 'midmidmidmi']);
  });
});

describe('YouTubeIngestService（キーポイント抽出の統合）', () => {
  it('extractor があればキーポイントを抽出して writeVideo に渡す（keypointsExtracted 加算）', async () => {
    const { youtube, transcriber, writer } = makeDeps([makeVideo('aaaaaaaaaaa')]);
    const extractor = { extract: jest.fn(async () => ['要点1', '要点2', '要点3']) } as any;

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22) },
      silentLogger,
      extractor
    );

    const result = await service.run();

    expect(result.written).toBe(1);
    expect(result.keypointsExtracted).toBe(1);
    expect(result.keypointFailed).toBe(0);
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    // writeVideo の第2引数にキーポイントが渡る
    expect(writer.writeVideo.mock.calls[0][1]).toEqual(['要点1', '要点2', '要点3']);
  });

  it('キーポイント抽出が失敗しても動画本体は書き込む（keypointFailed 加算・keypoints は空）', async () => {
    const { youtube, transcriber, writer } = makeDeps([makeVideo('aaaaaaaaaaa')]);
    const extractor = {
      extract: jest.fn(async () => {
        throw new Error('Haiku 落ちた');
      }),
    } as any;

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22) },
      silentLogger,
      extractor
    );

    const result = await service.run();

    expect(result.written).toBe(1); // 動画本体は書き込まれる
    expect(result.keypointsExtracted).toBe(0);
    expect(result.keypointFailed).toBe(1);
    expect(writer.writeVideo.mock.calls[0][1]).toEqual([]); // キーポイントなしで書く
  });

  it('Notion 書き込みの一時的失敗はリトライし、回復すれば written に数える', async () => {
    const { youtube, transcriber, writer } = makeDeps([makeVideo('aaaaaaaaaaa')]);
    let attempts = 0;
    writer.writeVideo = jest.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw { status: 503 };
      return 'page-ok';
    });

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22), sleep: async () => undefined },
      silentLogger
    );

    const result = await service.run();

    expect(result.written).toBe(1);
    expect(writer.writeVideo).toHaveBeenCalledTimes(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('Notion 書き込みが恒久的失敗(4xx)なら再試行せずスキップに落とす', async () => {
    const { youtube, transcriber, writer } = makeDeps([makeVideo('aaaaaaaaaaa')]);
    writer.writeVideo = jest.fn(async () => {
      throw { status: 400, message: 'invalid property' };
    });

    const service = new YouTubeIngestService(
      youtube,
      transcriber,
      writer,
      { channelId: 'UC' + 'x'.repeat(22), sleep: async () => undefined },
      silentLogger
    );

    const result = await service.run();

    expect(result.written).toBe(0);
    expect(writer.writeVideo).toHaveBeenCalledTimes(1); // 4xx は即中断
    expect(result.skipped).toHaveLength(1);
  });
});
