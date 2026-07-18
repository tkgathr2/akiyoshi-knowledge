/**
 * 秋好ナレッジシステム - 実行エントリポイント
 *
 * Railway 上で「常駐プロセス（既定）」または「Cron / 単発実行（RUN_ONCE=true）」として起動し、
 * Notion の秋好ナレッジを取得 → キャッシュ → サニタイズ/プロンプト構成 → 監視記録 の
 * 1 サイクルを回す。エラー時は Circuit Breaker を開き、監視ダッシュボード経由で
 * Slack へアラートを送出する。
 *
 * 注: 本リポジトリの実体は「Notion からナレッジを取得して LLM プロンプトへ安全注入する
 * 読み取り/注入パイプライン」であり、YouTube/NotebookLM への書き込み処理は含まない。
 * 本エントリポイントは既存コンポーネント（NotionKnowledgeClient / KnowledgeCache /
 * PromptComposer / KnowledgeSanitizer / MonitoringDashboard）の実 API に対して配線する。
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

const logger = pino({ name: 'akiyoshi-knowledge', level: process.env.LOG_LEVEL || 'info' });

/** 取得件数（既定 10） */
const FETCH_LIMIT = Number(process.env.FETCH_LIMIT || '10');
/** キャッシュキー（Notion ページ単位） */
const CACHE_KEY = 'akiyoshi-knowledge:latest';
/** 単発実行モード（Railway Cron 向け）。既定は常駐（false） */
const RUN_ONCE = process.env.RUN_ONCE === 'true';
/** 常駐時のサイクル間隔（既定 6 時間） */
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || String(6 * 60 * 60 * 1000));

interface AppEnv {
  notionApiKey: string;
  notionPageId: string;
  slackWebhookUrl?: string;
  dryRun: boolean;
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
  };
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
  monitor: MonitoringDashboard
): Promise<void> {
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

  await monitor.start();
  logger.info({ runOnce: RUN_ONCE, cycleIntervalMs: CYCLE_INTERVAL_MS }, 'Akiyoshi knowledge service started');

  if (RUN_ONCE) {
    try {
      await runCycle(client, cache, monitor);
    } finally {
      await monitor.stop();
    }
    return;
  }

  // 常駐モード: 起動直後に 1 回 + 以降はインターバル実行
  await runCycle(client, cache, monitor).catch((err) => {
    logger.error({ err }, 'Initial cycle failed (continuing in daemon mode)');
  });

  const timer = setInterval(() => {
    runCycle(client, cache, monitor).catch((err) => {
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
