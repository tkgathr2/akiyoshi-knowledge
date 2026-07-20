/**
 * 秋好ナレッジ YouTube 取込システム - 管理画面 エントリポイント
 *
 * 取込の設定・ステータス・動画一覧・デバッグを 1 つの Web 管理画面から扱う。
 * 実行: npm run admin（既定ポート 8080 / PORT で変更可）。
 *
 * 【配置の考え方】
 * 取込本体は住宅 IP の社内 PC で回す必要がある（YouTube の字幕がデータセンター IP から
 * ブロックされるため）。本管理画面は設定ファイルと履歴ファイル、Notion を参照するだけなので
 * どこで動かしてもよいが、デバッグ画面の「手動再実行」を字幕取得ごと成功させたい場合は
 * 取込本体と同じ社内 PC 上で動かすこと。設定・履歴は取込本体と同じファイルを共有する。
 *
 * 必要な環境変数:
 *   ADMIN_PASSWORD  … 管理画面ログインのパスワード（必須）
 *   NOTION_API_KEY  … 動画一覧の取得に使用
 *   NOTION_PAGE_ID  … 同上（データベース ID）
 * 任意:
 *   PORT / ADMIN_SESSION_SECRET / ADMIN_CONFIG_PATH / ADMIN_HISTORY_PATH /
 *   ADMIN_SECURE_COOKIE(=true) / YOUTUBE_API_KEY / YOUTUBE_CHANNEL_ID（設定ファイル未設定時の既定）
 */

import 'dotenv/config';
import * as path from 'path';
import pino from 'pino';

import { AdminConfigStore } from './features/admin/config/AdminConfigStore';
import { CycleHistoryStore } from './features/admin/history/CycleHistoryStore';
import { StatusService } from './features/admin/status/StatusService';
import { SessionManager } from './features/admin/auth/SessionManager';
import { NotionVideoLister } from './features/admin/video/NotionVideoLister';
import { AdminServer } from './features/admin/server/AdminServer';
import { runIngestCycle } from './features/admin/ingest/runIngestCycle';
import { NotionKnowledgeClient } from './features/akiyoshi-knowledge/clients/NotionKnowledgeClient';
import { NotionKnowledgeWriter } from './features/youtube-ingest/writers/NotionKnowledgeWriter';
import { TranscriptClient } from './features/youtube-ingest/clients/TranscriptClient';
import { YouTubeFeedClient } from './features/youtube-ingest/clients/YouTubeFeedClient';
import { YouTubeClient } from './features/youtube-ingest/clients/YouTubeClient';
import type { VideoSource } from './features/youtube-ingest/clients/VideoSource';
import { YouTubeIngestService } from './features/youtube-ingest/YouTubeIngestService';
import { CycleRecord } from './features/admin/types/admin';

const logger = pino({ name: 'akiyoshi-admin', level: process.env.LOG_LEVEL || 'info' });

const DATA_DIR = process.env.ADMIN_DATA_DIR || path.resolve(process.cwd(), 'data');
const CONFIG_PATH = process.env.ADMIN_CONFIG_PATH || path.join(DATA_DIR, 'admin-config.json');
const HISTORY_PATH = process.env.ADMIN_HISTORY_PATH || path.join(DATA_DIR, 'cycle-history.json');
const PORT = Number(process.env.PORT || '8080');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`必須の環境変数が未設定です: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const adminPassword = requireEnv('ADMIN_PASSWORD');
  const notionApiKey = requireEnv('NOTION_API_KEY');
  const notionPageId = process.env.NOTION_PAGE_ID || process.env.AKIYOSHI_KNOWLEDGE_PAGE_ID;
  if (!notionPageId) throw new Error('必須の環境変数が未設定です: NOTION_PAGE_ID');

  const configStore = new AdminConfigStore(CONFIG_PATH, logger);
  const historyStore = new CycleHistoryStore(HISTORY_PATH, 50, logger);
  const statusService = new StatusService(historyStore, configStore);

  const sessionManager = new SessionManager({
    password: adminPassword,
    secret: process.env.ADMIN_SESSION_SECRET,
    secure: process.env.ADMIN_SECURE_COOKIE === 'true',
  });

  const readClient = new NotionKnowledgeClient(notionApiKey, notionPageId, logger);
  const videoLister = new NotionVideoLister(readClient, logger);

  // 手動再実行: 保存済み設定のチャンネル ID で取込サービスを都度組み立てる。
  const reingest = async (): Promise<CycleRecord> => {
    const cfg = await configStore.load();
    const channelId = cfg.channelId || process.env.YOUTUBE_CHANNEL_ID || '';
    if (!YouTubeFeedClient.isValidChannelId(channelId)) {
      throw new Error(
        'チャンネル ID が未設定または不正です。設定ページで UC 形式のチャンネル ID を保存してください。'
      );
    }
    const source: VideoSource = process.env.YOUTUBE_API_KEY
      ? new YouTubeClient(process.env.YOUTUBE_API_KEY, logger)
      : new YouTubeFeedClient(logger);
    const service = new YouTubeIngestService(
      source,
      new TranscriptClient(undefined, ['ja', 'en'], logger),
      new NotionKnowledgeWriter(notionApiKey, notionPageId, logger),
      {
        channelId,
        fetchLimit: Number(process.env.YOUTUBE_FETCH_LIMIT || '15'),
        maxWritesPerCycle: Number(process.env.YOUTUBE_MAX_WRITES || '5'),
      },
      logger
    );
    return runIngestCycle({ service, history: historyStore, trigger: 'manual' });
  };

  const server = new AdminServer({
    configStore,
    historyStore,
    statusService,
    sessionManager,
    videoLister,
    reingest,
    logger,
  });

  await server.listen(PORT);
  logger.info({ port: PORT, configPath: CONFIG_PATH, historyPath: HISTORY_PATH }, 'Admin ready');
}

main().catch((err) => {
  logger.error({ err }, 'Fatal (admin)');
  process.exit(1);
});
