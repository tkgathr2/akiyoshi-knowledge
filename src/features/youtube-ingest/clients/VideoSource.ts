/**
 * 動画一覧の取得元インターフェース - 秋好ナレッジシステム
 *
 * 実装は 2 種類ある:
 *   - YouTubeFeedClient : RSS 版（既定・API キー不要・クォータなし・最新 15 件まで）
 *   - YouTubeClient     : Data API v3 版（API キーが必要・15 件より多く遡れる）
 * YouTubeIngestService はこのインターフェースにだけ依存するため、
 * 取得元を差し替えても取込ロジックは変わらない。
 */

import { YouTubeVideo } from '../types/video';

export interface VideoSource {
  /**
   * チャンネルの新着動画を取得する（公開日の新しい順）。
   * @param channelId UC で始まる 24 文字のチャンネル ID
   * @param limit 取得件数
   */
  fetchLatestVideos(channelId: string, limit?: number): Promise<YouTubeVideo[]>;
}
