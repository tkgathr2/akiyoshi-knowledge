/**
 * YouTube 取込サービス - 秋好ナレッジシステム
 *
 * 1 サイクルの流れ:
 *   YouTube チャンネルの最新動画を取得
 *     → Notion に既にあるものを除外（重複防止）
 *     → 字幕を取得して文字起こし
 *     → Notion へ 1 ページずつ書き込み
 *
 * 1 本の失敗で全体を止めない（字幕なしの動画は skipped に記録して次へ進む）。
 */

import pino from 'pino';
import { VideoSource } from './clients/VideoSource';
import { TranscriptClient } from './clients/TranscriptClient';
import { NotionKnowledgeWriter } from './writers/NotionKnowledgeWriter';
import { IngestResult } from './types/video';

export interface YouTubeIngestOptions {
  /** 取得対象のチャンネル ID（UC で始まる 24 文字） */
  channelId: string;

  /** 1 サイクルで見る動画数（既定 10） */
  fetchLimit?: number;

  /** 1 サイクルで書き込む最大件数（既定 5・API 負荷の上限） */
  maxWritesPerCycle?: number;
}

export class YouTubeIngestService {
  private logger: pino.Logger;

  constructor(
    private readonly youtube: VideoSource,
    private readonly transcriber: TranscriptClient,
    private readonly writer: NotionKnowledgeWriter,
    private readonly options: YouTubeIngestOptions,
    logger?: pino.Logger
  ) {
    this.logger = logger || pino({ name: 'YouTubeIngestService' });
  }

  /**
   * 取込を 1 サイクル実行する。
   */
  async run(): Promise<IngestResult> {
    const fetchLimit = this.options.fetchLimit ?? 10;
    const maxWrites = this.options.maxWritesPerCycle ?? 5;

    const result: IngestResult = { fetched: 0, newVideos: 0, written: 0, skipped: [] };

    const videos = await this.youtube.fetchLatestVideos(this.options.channelId, fetchLimit);
    result.fetched = videos.length;

    // 動画 ID と正規化タイトルの両方で既存を判定する
    // （本機能が書いたページは ID、人手で追記されたページはタイトルで一致する）
    const ingested = await this.writer.fetchIngestedKeys();
    const newVideos = videos.filter((v) => {
      if (ingested.has(v.videoId)) return false;
      const titleKey = NotionKnowledgeWriter.normalizeTitle(v.title);
      return !(titleKey && ingested.has(titleKey));
    });
    result.newVideos = newVideos.length;

    if (newVideos.length === 0) {
      this.logger.info({ fetched: result.fetched }, 'No new videos to ingest');
      return result;
    }

    // 公開が古い順に処理する（時系列どおりに Notion へ並べるため）
    const targets = newVideos
      .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())
      .slice(0, maxWrites);

    for (const video of targets) {
      try {
        const transcribed = await this.transcriber.transcribe(video);
        await this.writer.writeVideo(transcribed);
        result.written += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.skipped.push({ videoId: video.videoId, reason });
        this.logger.warn({ videoId: video.videoId, reason }, 'Video skipped');
      }
    }

    this.logger.info(
      {
        fetched: result.fetched,
        newVideos: result.newVideos,
        written: result.written,
        skipped: result.skipped.length,
      },
      'YouTube ingest cycle completed'
    );

    return result;
  }
}
