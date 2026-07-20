/**
 * YouTube 取込サービス - 秋好ナレッジシステム
 *
 * 1 サイクルの流れ:
 *   YouTube チャンネルの最新動画を取得
 *     → Notion に既にあるものを除外（動画 ID＋正規化タイトルで重複防止）
 *     → 字幕を取得して文字起こし
 *     → Haiku でキーポイントを抽出（任意・失敗しても動画本体は書き込む）
 *     → Notion へ 1 ページずつ書き込み（キーポイント＋文字起こし）
 *
 * 1 本の失敗で全体を止めない:
 *   - 字幕なしの動画は skipped に記録して次へ進む
 *   - キーポイント抽出の失敗は keypointFailed に記録し、動画本体は書き込む
 *   - Notion 書き込みは一時的失敗（429/5xx）に対してのみリトライする
 */

import pino from 'pino';
import { VideoSource } from './clients/VideoSource';
import { TranscriptClient } from './clients/TranscriptClient';
import { NotionKnowledgeWriter } from './writers/NotionKnowledgeWriter';
import { KeyPointExtractor } from './extractors/HaikuKeyPointExtractor';
import { IngestResult } from './types/video';
import { withRetry, isTransientError } from './utils/retry';

export interface YouTubeIngestOptions {
  /** 取得対象のチャンネル ID（UC で始まる 24 文字） */
  channelId: string;

  /** 1 サイクルで見る動画数（既定 10） */
  fetchLimit?: number;

  /** 1 サイクルで書き込む最大件数（既定 5・API 負荷の上限） */
  maxWritesPerCycle?: number;

  /** Notion 書き込みのリトライ最大試行回数（既定 3） */
  writeMaxAttempts?: number;

  /** リトライ待ちの sleep 実装（テストで潰すため差し替え可） */
  sleep?: (ms: number) => Promise<void>;
}

export class YouTubeIngestService {
  private logger: pino.Logger;

  constructor(
    private readonly youtube: VideoSource,
    private readonly transcriber: TranscriptClient,
    private readonly writer: NotionKnowledgeWriter,
    private readonly options: YouTubeIngestOptions,
    logger?: pino.Logger,
    /** キーポイント抽出器（省略時はキーポイント抽出を行わず、従来どおり文字起こしのみ書き込む） */
    private readonly extractor?: KeyPointExtractor
  ) {
    this.logger = logger || pino({ name: 'YouTubeIngestService' });
  }

  /**
   * 取込を 1 サイクル実行する。
   */
  async run(): Promise<IngestResult> {
    const fetchLimit = this.options.fetchLimit ?? 10;
    const maxWrites = this.options.maxWritesPerCycle ?? 5;
    const writeMaxAttempts = this.options.writeMaxAttempts ?? 3;

    const result: IngestResult = {
      fetched: 0,
      newVideos: 0,
      written: 0,
      keypointsExtracted: 0,
      keypointFailed: 0,
      skipped: [],
    };

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
        // 1) 字幕 → 文字起こし（取れなければ TranscriptUnavailableError で skip 扱い）
        const transcribed = await this.transcriber.transcribe(video);

        // 2) キーポイント抽出（任意・失敗しても動画本体は書き込む）
        let keypoints: string[] = [];
        if (this.extractor) {
          try {
            keypoints = await this.extractor.extract({
              title: transcribed.title,
              transcript: transcribed.transcript,
            });
            result.keypointsExtracted += 1;
          } catch (error) {
            result.keypointFailed += 1;
            this.logger.warn(
              { videoId: video.videoId, reason: reasonOf(error) },
              'キーポイント抽出に失敗（動画本体はキーポイントなしで書き込む）'
            );
          }
        }

        // 3) Notion 書き込み（一時的失敗のみリトライ）
        await withRetry(() => this.writer.writeVideo(transcribed, keypoints), {
          maxAttempts: writeMaxAttempts,
          isRetryable: isTransientError,
          sleep: this.options.sleep,
          onRetry: ({ attempt, delayMs, error }) =>
            this.logger.warn(
              { videoId: video.videoId, attempt, delayMs, reason: reasonOf(error) },
              'Notion 書き込みを再試行'
            ),
        });

        result.written += 1;
      } catch (error) {
        // 字幕なし・Notion 書き込みの最終失敗はこの動画をスキップして次へ進む
        const reason = reasonOf(error);
        result.skipped.push({ videoId: video.videoId, reason });
        this.logger.warn({ videoId: video.videoId, reason }, 'Video skipped');
      }
    }

    this.logger.info(
      {
        fetched: result.fetched,
        newVideos: result.newVideos,
        written: result.written,
        keypointsExtracted: result.keypointsExtracted,
        keypointFailed: result.keypointFailed,
        skipped: result.skipped.length,
      },
      'YouTube ingest cycle completed'
    );

    return result;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
