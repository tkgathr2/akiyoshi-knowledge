/**
 * 秋好ナレッジシステム - 実行エントリポイント
 *
 * Railway 上で「常駐プロセス（既定）」または「Cron / 単発実行（RUN_ONCE=true）」として起動し、
 * Notion の秋好ナレッジを取得 → キャッシュ → サニタイズ/プロンプト構成 → 監視記録 の
 * 1 サイクルを回す。エラー時は Circuit Breaker を開き、監視ダッシュボード経由で
 * Slack へアラートを送出する。
 *
 * 本エントリポイントは既存コンポーネント（NotionKnowledgeClient / KnowledgeCache /
 * PromptComposer / KnowledgeSanitizer / MonitoringDashboard）の実 API に対して配線する。
 *
 * 加えて YOUTUBE_CHANNEL_ID が設定されている場合、各サイクルの先頭で YouTube 取込
 * （新着動画 → 字幕で文字起こし → Notion 書き込み）を実行する。
 * 新着の取得は既定で YouTube の公開 RSS を使うため API キーは不要。
 * YOUTUBE_API_KEY を設定した場合のみ Data API v3 版に切り替わる（15 件より多く遡れる）。
 * YOUTUBE_CHANNEL_ID 未設定なら従来どおり読み取りパイプラインだけが動く（後方互換）。
 */

import 'dotenv/config';
import pino from 'pino';

import { NotionKnowledgeClient } from './features/akiyoshi-knowledge/clients/NotionKnowledgeClient';
import { KnowledgeCache } from './features/akiyoshi-knowledge/cache/KnowledgeCache';
import { PromptComposer } from './features/akiyoshi-knowledge/composer/PromptComposer';
import { KnowledgeSanitizer } from './features/akiyoshi-knowledge/sanitizer/KnowledgeSanitizer';
import { MonitoringDashboard } from './features/monitoring/MonitoringDashboard';
import type { OperationRecord } from './features/monitoring/MetricsCollector';
import type { KnowledgeLog } from './features/akiyoshi-knowledge/types/knowledge';
import { YouTubeClient } from './features/youtube-ingest/clients/YouTubeClient';
import { YouTubeFeedClient } from './features/youtube-ingest/clients/YouTubeFeedClient';
import type { VideoSource } from './features/youtube-ingest/clients/VideoSource';
import { TranscriptClient } from './features/youtube-ingest/clients/TranscriptClient';
import { NotionKnowledgeWriter } from './features/youtube-ingest/writers/NotionKnowledgeWriter';
import { HaikuKeyPointExtractor } from './features/youtube-ingest/extractors/HaikuKeyPointExtractor';
import type { KeyPointExtractor } from './features/youtube-ingest/extractors/HaikuKeyPointExtractor';
import { YouTubeIngestService } from './features/youtube-ingest/YouTubeIngestService';

const logger = pino({ name: 'akiyoshi-knowledge', level: process.env.LOG_LEVEL || 'info' });

/** 取得件数（既定 10） */
const FETCH_LIMIT = Number(process.env.FETCH_LIMIT || '10');
/** キャッシュキー（Notion ページ単位） */
const CACHE_KEY = 'akiyoshi-knowledge:latest';
/** 単発実行モード（Railway Cron 向け）。既定は常駐（false） */
const RUN_ONCE = process.env.RUN_ONCE === 'true';
/** 常駐時のサイクル間隔（既定 6 時間） */
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || String(6 * 60 * 60 * 1000));

/** YouTube 取込で 1 サイクルに見る動画数 */
const YOUTUBE_FETCH_LIMIT = Number(process.env.YOUTUBE_FETCH_LIMIT || '10');
/** YouTube 取込で 1 サイクルに書き込む上限 */
const YOUTUBE_MAX_WRITES = Number(process.env.YOUTUBE_MAX_WRITES || '5');

interface AppEnv {
  notionApiKey: string;
  notionPageId: string;
  slackWebhookUrl?: string;
  dryRun: boolean;
  youtubeApiKey?: string;
  youtubeChannelId?: string;
  anthropicApiKey?: string;
  keypointsProperty?: string;
}

/**
 * 環境変数を検証して取り出す。必須項目が欠けている場合は例外を投げる。
 */
function loadEnv(): AppEnv {
  const notionApiKey = process.env.NOTION_API_KEY;
  const notionPageId = process.env.NOTION_PAGE_ID || process.env.AKIYOSHI_KNOWLEDGE_PAGE_ID;

  const missing: string[] = [];
  if (!notionApiKey) missing.push('NOTION_API_KEY');
  if (!notionPageId) missing.push('NOTION_PAGE_ID (または AKIYOSHI_KNOWLEDGE_PAGE_ID)');
  if (missing.length > 0) {
    throw new Error(`必須の環境変数が未設定です: ${missing.join(', ')}`);
  }

  return {
    notionApiKey: notionApiKey as string,
    notionPageId: notionPageId as string,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    dryRun: process.env.DRY_RUN === 'true',
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID,
  };
}

/**
 * YouTube 取込サービスを組み立てる。
 * YOUTUBE_CHANNEL_ID が未設定・不正な場合は null を返し、取込を行わない。
 */
function buildIngestService(env: AppEnv, logger: pino.Logger): YouTubeIngestService | null {
  if (!env.youtubeChannelId) {
    logger.info('YouTube ingest disabled (YOUTUBE_CHANNEL_ID not set)');
    return null;
  }

  if (!YouTubeFeedClient.isValidChannelId(env.youtubeChannelId)) {
    // 起動時に落とさず警告に留める（読み取りパイプラインは動かし続ける）
    logger.error(
      { channelId: env.youtubeChannelId },
      'YOUTUBE_CHANNEL_ID の形式が不正です (UC で始まる 24 文字が必要)。YouTube 取込を無効化します'
    );
    return null;
  }

  // 既定は RSS（API キー不要・クォータなし）。キーがある場合のみ Data API 版を使う。
  const source: VideoSource = env.youtubeApiKey
    ? new YouTubeClient(env.youtubeApiKey, logger)
    : new YouTubeFeedClient(logger);

  logger.info(
    { source: env.youtubeApiKey ? 'data-api' : 'rss-feed', channelId: env.youtubeChannelId },
    'YouTube ingest enabled'
  );

  return new YouTubeIngestService(
    source,
    new TranscriptClient(undefined, ['ja', 'en'], logger),
    new NotionKnowledgeWriter(env.notionApiKey, env.notionPageId, logger),
    {
      channelId: env.youtubeChannelId,
      fetchLimit: YOUTUBE_FETCH_LIMIT,
      maxWritesPerCycle: YOUTUBE_MAX_WRITES,
    },
    logger
  );
}

/**
 * KnowledgeLog.source を監視用の OperationRecord にマッピングする。
 */
function toOperationRecord(source: KnowledgeLog['source'], latency: number): OperationRecord {
  switch (source) {
    case 'notion':
      return { timestamp: new Date(), operation: 'fetch', latency, sourceType: 'notion' };
    case 'cache':
      return { timestamp: new Date(), operation: 'cache_hit', latency, sourceType: 'cache' };
    case 'stale-cache':
      return { timestamp: new Date(), operation: 'fallback', latency, sourceType: 'fallback' };
  }
}

/**
 * 1 サイクル: 取得 → キャッシュ → サニタイズ/構成 → 監視記録。
 */
async function runCycle(
  client: NotionKnowledgeClient,
  cache: KnowledgeCache,
  monitor: MonitoringDashboard,
  ingest: YouTubeIngestService | null
): Promise<void> {
  // YouTube 取込を先に実行する（新着が Notion に入ってから読み取る順序にするため）。
  // 取込の失敗は読み取りパイプラインを止めない（別系統として切り離す）。
  if (ingest) {
    try {
      const result = await ingest.run();
      // 新規を書き込んだらキャッシュを捨てて Notion から取り直す
      if (result.written > 0) cache.clear(CACHE_KEY);
    } catch (error) {
      logger.error({ error }, 'YouTube ingest failed (continuing with read pipeline)');
    }
  }

  // 計測開始は取込の「後」。取込は外部 API を何度も叩くため、ここより前に置くと
  // 取込の所要時間が Notion のレスポンスタイムとして記録され、
  // 実際には正常なのに「Notion API Degraded」アラートが誤発報する。
  const startedAt = Date.now();

  try {
    const log = await cache.get(CACHE_KEY, () => client.fetchLatest(FETCH_LIMIT));
    const latency = Date.now() - startedAt;

    // インジェクション検出（検出のみ・監視ログ用）
    const suspicious = log.entries.flatMap((e) => [
      ...KnowledgeSanitizer.detectInjectionPatterns(e.title),
      ...KnowledgeSanitizer.detectInjectionPatterns(e.summary),
    ]);

    // プロンプト構成（内部でサニタイズ実施）
    const prompt = PromptComposer.compose(log.entries);

    monitor.recordOperation(toOperationRecord(log.source, latency));

    // stale-cache に落ちた = Notion 取得に失敗しているため Circuit Breaker を開く
    monitor.setCircuitBreakerOpen(log.source === 'stale-cache');

    logger.info(
      {
        source: log.source,
        cacheAge: log.cacheAge,
        entries: log.entries.length,
        latencyMs: latency,
        tokenEstimate: prompt.tokenEstimate,
        suspiciousPatternCount: suspicious.length,
      },
      'Knowledge cycle completed'
    );

    if (suspicious.length > 0) {
      logger.warn({ suspicious }, 'Injection patterns detected in knowledge (masked on compose)');
    }
  } catch (error) {
    const latency = Date.now() - startedAt;
    monitor.recordOperation({
      timestamp: new Date(),
      operation: 'error',
      latency,
      sourceType: 'fallback',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    monitor.setCircuitBreakerOpen(true);
    logger.error({ error }, 'Knowledge cycle failed');
    throw error;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  const monitor = new MonitoringDashboard(
    {
      notificationConfig: {
        slackWebhookUrl: env.slackWebhookUrl,
        dryRun: env.dryRun || !env.slackWebhookUrl,
      },
    },
    logger
  );

  const client = new NotionKnowledgeClient(env.notionApiKey, env.notionPageId, logger);
  const cache = new KnowledgeCache(logger);
  const ingest = buildIngestService(env, logger);

  await monitor.start();
  logger.info({ runOnce: RUN_ONCE, cycleIntervalMs: CYCLE_INTERVAL_MS }, 'Akiyoshi knowledge service started');

  if (RUN_ONCE) {
    try {
      await runCycle(client, cache, monitor, ingest);
    } finally {
      await monitor.stop();
    }
    return;
  }

  // 常駐モード: 起動直後に 1 回 + 以降はインターバル実行
  await runCycle(client, cache, monitor, ingest).catch((err) => {
    logger.error({ err }, 'Initial cycle failed (continuing in daemon mode)');
  });

  const timer = setInterval(() => {
    runCycle(client, cache, monitor, ingest).catch((err) => {
      logger.error({ err }, 'Scheduled cycle failed');
    });
  }, CYCLE_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    clearInterval(timer);
    await monitor.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal');
  process.exit(1);
});
