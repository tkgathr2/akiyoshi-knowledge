/**
 * YouTube Data API v3 クライアント - 秋好ナレッジシステム
 *
 * チャンネルの「アップロード済み動画」プレイリストから最新動画を取得する。
 * search.list ではなく playlistItems.list を使う理由:
 *   - search.list は 1 回 100 クォータ、playlistItems.list は 1 クォータ（100 倍安い）
 *   - search.list は反映が遅く新着を取りこぼすことがある
 * 出典: https://developers.google.com/youtube/v3/determine_quota_cost
 */

import pino from 'pino';
import { YouTubeVideo } from '../types/video';
import { VideoSource } from './VideoSource';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** YouTube チャンネル ID の形式（UC + 22 文字） */
const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

/**
 * YouTube API 呼び出し失敗
 */
export class YouTubeFetchError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(`YouTube API error (${statusCode}): ${message}`);
    this.name = 'YouTubeFetchError';
  }

  /** 401/403 は鍵・権限の問題でリトライしても直らない */
  isStructuralError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

export class YouTubeClient implements VideoSource {
  private readonly TIMEOUT_MS = 10000;
  private logger: pino.Logger;

  constructor(
    private readonly apiKey: string,
    logger?: pino.Logger
  ) {
    this.logger = logger || pino({ name: 'YouTubeClient' });
  }

  /**
   * チャンネル ID の形式を検証する。
   * 動画 ID（11 文字）を誤ってチャンネル ID として渡す事故を検出するため。
   */
  static isValidChannelId(channelId: string): boolean {
    return CHANNEL_ID_PATTERN.test(channelId);
  }

  /**
   * チャンネルの最新動画を取得する。
   * @param channelId UC で始まる 24 文字のチャンネル ID
   * @param limit 取得件数（既定 10・最大 50）
   */
  async fetchLatestVideos(channelId: string, limit = 10): Promise<YouTubeVideo[]> {
    if (!YouTubeClient.isValidChannelId(channelId)) {
      throw new Error(
        `チャンネル ID の形式が不正です: "${channelId}" ` +
          `(UC で始まる 24 文字が必要。動画 ID を渡していませんか?)`
      );
    }

    const uploadsPlaylistId = await this.getUploadsPlaylistId(channelId);
    return this.fetchPlaylistVideos(uploadsPlaylistId, Math.min(limit, 50));
  }

  /**
   * チャンネルの「アップロード済み動画」プレイリスト ID を取得する。
   * channels.list の contentDetails.relatedPlaylists.uploads に入っている。
   */
  private async getUploadsPlaylistId(channelId: string): Promise<string> {
    const data = await this.get('/channels', {
      part: 'contentDetails',
      id: channelId,
    });

    const items = data.items as Array<Record<string, any>> | undefined;
    if (!items || items.length === 0) {
      throw new Error(`チャンネルが見つかりません: ${channelId}`);
    }

    const uploads = items[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (typeof uploads !== 'string' || uploads.length === 0) {
      throw new Error(`アップロードプレイリストが取得できません: ${channelId}`);
    }

    return uploads;
  }

  /**
   * プレイリストから動画一覧を取得する（公開日の新しい順）。
   */
  private async fetchPlaylistVideos(playlistId: string, limit: number): Promise<YouTubeVideo[]> {
    const data = await this.get('/playlistItems', {
      part: 'snippet',
      playlistId,
      maxResults: String(limit),
    });

    const items = (data.items as Array<Record<string, any>> | undefined) ?? [];

    const videos = items
      .map((item) => this.mapItemToVideo(item))
      .filter((v): v is YouTubeVideo => v !== null);

    this.logger.info({ playlistId, count: videos.length }, 'YouTube fetch succeeded');

    return videos;
  }

  /**
   * playlistItems のレスポンスを YouTubeVideo へ変換する。
   * 非公開・削除済み動画は videoId や title が欠けるため null を返して除外する。
   */
  private mapItemToVideo(item: Record<string, any>): YouTubeVideo | null {
    const snippet = item?.snippet;
    const videoId = snippet?.resourceId?.videoId;
    const title = snippet?.title;
    const publishedAt = snippet?.publishedAt;

    if (typeof videoId !== 'string' || videoId.length === 0) return null;
    if (typeof title !== 'string' || title.length === 0) return null;
    // 削除済み・非公開動画はタイトルがこの固定文字列になる
    if (title === 'Private video' || title === 'Deleted video') return null;

    return {
      videoId,
      title,
      publishedAt: publishedAt ? new Date(publishedAt) : new Date(0),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  /**
   * YouTube API へ GET リクエストを投げる（タイムアウト付き）。
   */
  private async get(path: string, params: Record<string, string>): Promise<Record<string, any>> {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('key', this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), { signal: controller.signal });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // API キーがレスポンス経由で漏れないよう、本文は 200 字で切る
        throw new YouTubeFetchError(response.status, body.slice(0, 200));
      }

      return (await response.json()) as Record<string, any>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** API キーをマスキング（ログ用） */
  static maskKey(key: string): string {
    if (key.length < 4) return '****';
    return key.slice(0, 2) + '****' + key.slice(-2);
  }
}
