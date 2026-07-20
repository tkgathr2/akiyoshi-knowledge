/**
 * 単体: AdminConfigStore - 設定の検証 / 正規化 / 永続化
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import { AdminConfigStore } from '../config/AdminConfigStore';
import { DEFAULT_CONFIG } from '../types/admin';

const silent = pino({ level: 'silent' });

describe('AdminConfigStore.validate', () => {
  it('正しい入力を valid=true で受け入れる', () => {
    const r = AdminConfigStore.validate({
      channelId: 'UCabcdefghijklmnopqrstuv',
      pollIntervalMinutes: 360,
      keyPointCount: 7,
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.value.channelId).toBe('UCabcdefghijklmnopqrstuv');
  });

  it('空チャンネル ID は許可する（取込無効化の意図）', () => {
    const r = AdminConfigStore.validate({ channelId: '', pollIntervalMinutes: 60, keyPointCount: 5 });
    expect(r.valid).toBe(true);
  });

  it('動画 ID のような不正チャンネル ID を弾く', () => {
    const r = AdminConfigStore.validate({
      channelId: 'dQw4w9WgXcQ',
      pollIntervalMinutes: 60,
      keyPointCount: 5,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toContain('チャンネル ID');
  });

  it('範囲外のポーリング間隔とキーポイント数を弾く', () => {
    const r = AdminConfigStore.validate({
      channelId: '',
      pollIntervalMinutes: 5, // < 15
      keyPointCount: 11, // > 10
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
  });

  it('小数のキーポイント数を弾く', () => {
    const r = AdminConfigStore.validate({ channelId: '', pollIntervalMinutes: 60, keyPointCount: 5.5 });
    expect(r.valid).toBe(false);
  });
});

describe('AdminConfigStore.sanitize', () => {
  it('範囲外の値を既定側へ丸めて常に valid を返す', () => {
    const r = AdminConfigStore.sanitize({ pollIntervalMinutes: 99999, keyPointCount: 0 });
    expect(r.valid).toBe(true);
    expect(r.value.pollIntervalMinutes).toBe(1440); // max へクランプ
    expect(r.value.keyPointCount).toBe(5); // min へクランプ
  });

  it('壊れた入力（非オブジェクト）でも既定へフォールバックする', () => {
    const r = AdminConfigStore.sanitize('garbage' as unknown);
    expect(r.value.pollIntervalMinutes).toBe(DEFAULT_CONFIG.pollIntervalMinutes);
    expect(r.value.channelId).toBe('');
  });
});

describe('AdminConfigStore save/load（実ファイル I/O）', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akiyoshi-cfg-'));
    file = path.join(dir, 'nested', 'config.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ファイルが無ければ既定値を返す', async () => {
    const store = new AdminConfigStore(file, silent);
    const cfg = await store.load();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('保存すると updatedAt が打刻され、読み戻せる', async () => {
    const store = new AdminConfigStore(file, silent);
    const res = await store.save({
      channelId: 'UCabcdefghijklmnopqrstuv',
      pollIntervalMinutes: 120,
      keyPointCount: 9,
    });
    expect(res.valid).toBe(true);
    expect(res.value.updatedAt).toBeDefined();

    const loaded = await store.load();
    expect(loaded.channelId).toBe('UCabcdefghijklmnopqrstuv');
    expect(loaded.pollIntervalMinutes).toBe(120);
    expect(loaded.keyPointCount).toBe(9);
  });

  it('検証に落ちる入力は書き込まない', async () => {
    const store = new AdminConfigStore(file, silent);
    const res = await store.save({ channelId: 'bad', pollIntervalMinutes: 1, keyPointCount: 1 });
    expect(res.valid).toBe(false);
    await expect(fs.readFile(file, 'utf-8')).rejects.toThrow(); // ファイルは作られていない
  });

  it('壊れた JSON ファイルは既定値へフォールバックする', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ this is not json', 'utf-8');
    const store = new AdminConfigStore(file, silent);
    const cfg = await store.load();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});
