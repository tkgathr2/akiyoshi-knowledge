/**
 * 秋好ナレッジシステム - YouTube 取込 単独エントリポイント
 *
 * 新着動画を取得 → 字幕から文字起こし → Notion へ保存 を 1 回だけ実行して終了する。
 *
 * 【なぜ Railway ではなくこのエントリポイントを PC 上で回すか】
 * YouTube はデータセンター IP からの字幕取得をブロックする。実測（2026-07-19）:
 *   - Railway 本番       : 15 件中 0 件成功（全件 "Transcript is disabled"）
 *   - 社内 PC（住宅 IP） : 15 件中 15 件成功
 * 同一動画・同一コードで結果が割れるため、原因は動画側ではなく発信元 IP。
 * したがって取込はこのエントリポイントを PC のスケジュールタスクから回し、
 * Railway 側は従来どおり Notion の読み取りパイプラインだけを担当する。
 * 両者は Notion を介して疎結合なので、この分離で機能は損なわれない。
 *
 * 実行: npm run ingest
 * 必要な環境変数: NOTION_API_KEY / NOTION_PAGE_ID / YOUTUBE_CHANNEL_ID
 */

import 'dotenv/config';
import pino from 'pino';

import { YouTubeFeedClient } from './features/youtube-ingest/clients/YouTubeFeedClient';
import { TranscriptClient } from './features/youtube-ingest/clients/TranscriptClient';
import { NotionKnowledgeWriter } from './features/youtube-ingest/writers/NotionKnowledgeWriter';
import { YouTubeIngestService } from './features/youtube-ingest/YouTubeIngestService';

const logger = pino({ name: 'akiyoshi-ingest', level: process.env.LOG_LEVEL || 'info' });

/** 1 サイクルで見る動画数（RSS の上限は 15） */
const FETCH_LIMIT = Number(process.env.YOUTUBE_FETCH_LIMIT || '15');
/** 1 サイクルで書き込む上限 */
const MAX_WRITES = Number(process.env.YOUTUBE_MAX_WRITES || '5');

async function main(): Promise<void> {
  const notionApiKey = process.env.NOTION_API_KEY;
  const notionPageId = process.env.NOTION_PAGE_ID || process.env.AKIYOSHI_KNOWLEDGE_PAGE_ID;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;

  const missing: string[] = [];
  if (!notionApiKey) missing.push('NOTION_API_KEY');
  if (!notionPageId) missing.push('NOTION_PAGE_ID (または AKIYOSHI_KNOWLEDGE_PAGE_ID)');
  if (!channelId) missing.push('YOUTUBE_CHANNEL_ID');
  if (missing.length > 0) {
    throw new Error(`必須の環境変数が未設定です: ${missing.join(', ')}`);
  }

  if (!YouTubeFeedClient.isValidChannelId(channelId as string)) {
    throw new Error(
      `YOUTUBE_CHANNEL_ID の形式が不正です: "${channelId}" (UC で始まる 24 文字が必要)`
    );
  }

  const service = new YouTubeIngestService(
    new YouTubeFeedClient(logger),
    new TranscriptClient(undefined, ['ja', 'en'], logger),
    new NotionKnowledgeWriter(notionApiKey as string, notionPageId as string, logger),
    { channelId: channelId as string, fetchLimit: FETCH_LIMIT, maxWritesPerCycle: MAX_WRITES },
    logger
  );

  const result = await service.run();

  logger.info(
    {
      fetched: result.fetched,
      newVideos: result.newVideos,
      written: result.written,
      skipped: result.skipped.length,
    },
    'Ingest finished'
  );

  // 字幕が取れなかった動画は個別に残す（IP ブロックの再発を検知できるようにする）
  for (const s of result.skipped) {
    logger.warn({ videoId: s.videoId, reason: s.reason }, 'Skipped video');
  }
}

main().catch((err) => {
  logger.error({ err }, 'Ingest failed');
  process.exit(1);
});
