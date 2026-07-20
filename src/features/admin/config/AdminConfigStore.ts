/**
 * 設定ストア - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * 取込の動作設定（チャンネル ID / 巡回間隔 / キーポイント数）を JSON ファイルへ
 * 永続化する。設定ページからの保存と、取込エントリポイントからの読み出しの両方が使う。
 *
 * 設計方針:
 *   - 破損・欠損に強くする（ファイル無し・壊れた JSON は既定値へフォールバック）。
 *   - 保存前に必ず検証する（不正値をディスクへ書かない）。読み出し時も範囲を丸める。
 *   - 書き込みは一時ファイル → rename でアトミックにし、途中クラッシュでの破損を避ける。
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import pino from 'pino';
import { AdminConfig, CONFIG_LIMITS, DEFAULT_CONFIG } from '../types/admin';

/** YouTube チャンネル ID の形式（UC + 22 文字）。空文字は「未設定」として許可する。 */
const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

/** 設定検証の結果 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** 検証を通った（範囲へ丸めた）設定 */
  value: AdminConfig;
}

export class AdminConfigStore {
  private logger: pino.Logger;

  constructor(
    private readonly filePath: string,
    logger?: pino.Logger
  ) {
    this.logger = logger || pino({ name: 'AdminConfigStore' });
  }

  /**
   * 設定を読み出す。ファイルが無い／壊れている場合は既定値を返す（例外を投げない）。
   * 範囲外の値はログに残したうえで既定値側へ丸めて返す。
   */
  async load(): Promise<AdminConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (error) {
      // ENOENT（未作成）は正常系。初回起動では既定値を返す。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.info({ filePath: this.filePath }, 'Config file not found, using defaults');
        return { ...DEFAULT_CONFIG };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error({ filePath: this.filePath }, 'Config file is corrupt, using defaults');
      return { ...DEFAULT_CONFIG };
    }

    // 検証で範囲を丸める。壊れた個別項目があっても既定値で埋めて動かし続ける。
    return AdminConfigStore.sanitize(parsed).value;
  }

  /**
   * 設定を保存する。検証に失敗した場合は書き込まず ValidationResult を返す。
   * 成功時は updatedAt を打刻してアトミックに書き込む。
   */
  async save(input: Partial<AdminConfig>): Promise<ValidationResult> {
    const result = AdminConfigStore.validate(input);
    if (!result.valid) {
      this.logger.warn({ errors: result.errors }, 'Config validation failed, not saving');
      return result;
    }

    const toWrite: AdminConfig = { ...result.value, updatedAt: new Date().toISOString() };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(toWrite, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);

    this.logger.info({ filePath: this.filePath }, 'Config saved');
    return { valid: true, errors: [], value: toWrite };
  }

  /**
   * 入力を厳密に検証する（保存前チェック）。
   * - channelId: 空 or UC 形式のみ許可（動画 ID の取り違え事故を弾く）
   * - pollIntervalMinutes: 整数かつ範囲内
   * - keyPointCount: 整数かつ 5〜10
   */
  static validate(input: Partial<AdminConfig>): ValidationResult {
    const errors: string[] = [];

    const channelId = (input.channelId ?? '').trim();
    if (channelId !== '' && !CHANNEL_ID_PATTERN.test(channelId)) {
      errors.push(
        'チャンネル ID は UC で始まる 24 文字で入力してください（動画 ID ではありません）'
      );
    }

    const poll = Number(input.pollIntervalMinutes);
    const { min: pMin, max: pMax } = CONFIG_LIMITS.pollIntervalMinutes;
    if (!Number.isInteger(poll) || poll < pMin || poll > pMax) {
      errors.push(`巡回間隔は ${pMin}〜${pMax} 分の整数で入力してください`);
    }

    const kp = Number(input.keyPointCount);
    const { min: kMin, max: kMax } = CONFIG_LIMITS.keyPointCount;
    if (!Number.isInteger(kp) || kp < kMin || kp > kMax) {
      errors.push(`キーポイント数は ${kMin}〜${kMax} の整数で入力してください`);
    }

    const value: AdminConfig = {
      channelId,
      pollIntervalMinutes: poll,
      keyPointCount: kp,
    };

    return { valid: errors.length === 0, errors, value };
  }

  /**
   * 読み出し時の寛容な正規化。検証に落ちる項目は既定値へ丸める。
   * （保存済みファイルが将来のスキーマ変更などで一部欠けても起動を止めないため）
   */
  static sanitize(input: unknown): ValidationResult {
    const obj = (input && typeof input === 'object' ? input : {}) as Partial<AdminConfig>;

    const channelId =
      typeof obj.channelId === 'string' && CHANNEL_ID_PATTERN.test(obj.channelId.trim())
        ? obj.channelId.trim()
        : DEFAULT_CONFIG.channelId;

    const poll = clampInt(
      obj.pollIntervalMinutes,
      CONFIG_LIMITS.pollIntervalMinutes.min,
      CONFIG_LIMITS.pollIntervalMinutes.max,
      DEFAULT_CONFIG.pollIntervalMinutes
    );

    const kp = clampInt(
      obj.keyPointCount,
      CONFIG_LIMITS.keyPointCount.min,
      CONFIG_LIMITS.keyPointCount.max,
      DEFAULT_CONFIG.keyPointCount
    );

    const value: AdminConfig = {
      channelId,
      pollIntervalMinutes: poll,
      keyPointCount: kp,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
    };

    return { valid: true, errors: [], value };
  }
}

/** 数値を整数化し範囲内へ丸める。非数・NaN は既定値。 */
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
