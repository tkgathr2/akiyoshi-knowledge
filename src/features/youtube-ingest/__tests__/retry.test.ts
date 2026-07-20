/**
 * リトライユーティリティの単体テスト
 * - 一時的失敗の再試行 / 恒久的失敗の即時中断 / 最大試行回数
 * - isTransientError の分類（429・5xx=再試行 / 4xx=中断 / 不明=再試行）
 */

import { withRetry, isTransientError } from '../utils/retry';

const noSleep = async (): Promise<void> => undefined;

describe('withRetry', () => {
  it('一時的失敗のあと成功すれば結果を返す（再試行される）', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 2) throw { status: 503 };
      return 'ok';
    });

    const result = await withRetry(fn, { maxAttempts: 3, isRetryable: isTransientError, sleep: noSleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('恒久的失敗（isRetryable=false）は再試行せず即 throw する', async () => {
    const fn = jest.fn(async () => {
      throw { status: 400 };
    });

    await expect(
      withRetry(fn, { maxAttempts: 5, isRetryable: isTransientError, sleep: noSleep })
    ).rejects.toEqual({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('maxAttempts 回すべて失敗したら最後の誤りを throw する', async () => {
    const fn = jest.fn(async () => {
      throw new Error('boom');
    });

    await expect(withRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('onRetry が再試行の直前に呼ばれる', async () => {
    let calls = 0;
    const onRetry = jest.fn();
    const fn = async () => {
      calls += 1;
      if (calls < 3) throw new Error('temp');
      return 42;
    };

    const result = await withRetry(fn, { maxAttempts: 3, sleep: noSleep, onRetry });

    expect(result).toBe(42);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1 });
  });

  it('初回で成功すれば再試行しない', async () => {
    const fn = jest.fn(async () => 'done');
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('isTransientError', () => {
  it('429（レート制限）は一時的とみなす', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
  });

  it('5xx（サーバ障害）は一時的とみなす', () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ statusCode: 503 })).toBe(true);
  });

  it('4xx（認証・入力検証など）は恒久的とみなす', () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  it('ステータス不明（ネットワーク断・タイムアウト）は一時的とみなす', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError(null)).toBe(true);
    expect(isTransientError('文字列エラー')).toBe(true);
  });
});
