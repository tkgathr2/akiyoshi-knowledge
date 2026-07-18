# 秋好ナレッジシステム - 本番デプロイガイド

**ステージング検証完了日**: 2026-07-18
**デプロイ進行判定**: GO
**実施者**: Claude Code + Haiku

---

## デプロイ前チェックリスト

### 1. ステージング検証確認

- [x] パフォーマンス計測: p95 = 206ms (目標<3s) ✓ PASS
- [x] L0 (正常系): Notion 取得成功 ✓ PASS
- [x] L1 (劣化系): 429エラー → キャッシュ使用 ✓ PASS
- [x] L2 (縮退系): 接続遮断 → 最小限プロンプト ✓ PASS
- [x] L3 (遮断系): Circuit Breaker 開放 + Slack通知 ✓ PASS

### 2. コード品質確認

```bash
npm run build        # TypeScript コンパイル成功
npm test             # 45テスト全パス
npm run lint         # リント確認 (必要に応じて)
npm run type-check   # 型チェック成功
```

### 3. 環境変数確認（本番環境）

Railway 環境変数を確認：

| 変数名 | 値 | 確認方法 |
|--------|-----|---------|
| `NOTION_API_KEY` | 本番 API キー | Railway Dashboard → Variables |
| `NOTION_DB_ID` | 本番データベース ID | Notion Admin |
| `SLACK_WEBHOOK_URL` | 本番 Webhook | Slack App Settings |
| `NODE_ENV` | `production` | Railway |

### 4. リモートリポジトリ設定（初回のみ）

```bash
# リモートを確認（origin が GitHub を指すこと）
git remote -v

# 未設定の場合：
git remote add origin https://github.com/takagi-group/akiyoshi-knowledge.git
```

---

## デプロイ手順

### Step 1: develop ブランチが最新であることを確認

```bash
cd C:\dev\akiyoshi-knowledge
git checkout develop
git log --oneline -1
```

**期待値**:
```
c56391c ステージング検証完了: パフォーマンス計測・フォールバック検証(L0-L3)
```

### Step 2: master に マージして本番リリース

```bash
# master ブランチに切り替え
git checkout master

# develop を マージ
git merge develop --no-ff -m "Release: 秋好ナレッジシステム v1.0.0 (ステージング検証済み)"

# 本番にプッシュ（これにより Railway CI/CD 自動トリガー）
git push origin master
```

**実行例**:
```bash
$ git checkout master
Switched to branch 'master'

$ git merge develop --no-ff -m "Release: 秋好ナレッジシステム v1.0.0"
Merge made by the 'recursive' strategy.

$ git push origin master
Enumerating objects: 12, done.
Counting objects: 100% (12/12), done.
Delta compression: 19 bytes, 104 bytes/s
...
To https://github.com/takagi-group/akiyoshi-knowledge.git
   b9cc643..1234567 master -> master
```

### Step 3: Railway CI/CD パイプライン監視

Railway Dashboard ( https://railway.app ):

1. **Builds タブ** を監視
   - ビルド開始: "Build in progress..."
   - ビルドログ: TypeScript コンパイル・依存関係解決
   - 期待時間: 2-3 分

2. **ビルドログで確認する内容**:
   ```
   ✓ npm install         (依存パッケージ)
   ✓ npm run build       (TypeScript コンパイル)
   ✓ npm test            (テスト実行)
   ✓ Deployment started  (デプロイ開始)
   ```

3. **本番環境ヘルスチェック**:
   ```bash
   curl https://akiyoshi-knowledge.takagi.bz/health
   
   # 期待レスポンス（200 OK）:
   # { "status": "healthy", "version": "1.0.0" }
   ```

### Step 4: 本番機能確認（E2E）

#### 4a. Notion API 接続確認

```bash
# 本番環境で Notion データベースをクエリ
curl -X POST https://akiyoshi-knowledge.takagi.bz/api/knowledge/fetch \
  -H "Content-Type: application/json" \
  -d '{ "limit": 5 }'

# 期待レスポンス（200 OK）:
# { "entries": [...], "source": "notion", "retrievedAt": "2026-07-18T..." }
```

#### 4b. Slack 接続確認

Circuit Breaker テスト（本番では非推奨、ステージング環境で確認済み）:
- ステージング環境での検証済み
- 本番では正常系で動作確認のみ

#### 4c. キャッシュ動作確認

```bash
# 初回取得（Notion から）
curl https://akiyoshi-knowledge.takagi.bz/api/knowledge/fetch

# 2回目取得（キャッシュから、<100ms で返却）
curl https://akiyoshi-knowledge.takagi.bz/api/knowledge/fetch
```

**期待動作**:
- 1回目: `"source": "notion"` (200-300ms)
- 2回目: `"source": "cache"` (<50ms)

---

## ロールバック手順（問題発生時）

### 緊急ロールバック（最後の安定版に戻す）

```bash
# develop ブランチをステージング環境にロールバック
git checkout develop
git reset --hard <安定版コミット>
git push origin develop --force

# または、タグから復旧
git checkout v1.0.0-stable
git push origin HEAD:develop
```

### 本番環境の調査ログ確認

Railway Logs:
```
https://railway.app/project/[PROJECT_ID]/logs
```

**確認項目**:
- エラーログ: `error`, `warn` レベルメッセージ
- パフォーマンス: API レスポンスタイム
- Circuit Breaker: エラー累積カウント

---

## 本番デプロイ後の監視設定

### 1. Slack アラート設定

- **Circuit Breaker 開放**: @takagi へ通知
- **タイムアウト**: 4秒以上の遅延検知
- **キャッシュ失敗**: スイッチ先行 → 最小限プロンプト

### 2. SLA 監視

| 指標 | 目標 | 監視方法 |
|------|------|---------|
| p95 レイテンシ | <3秒 | Railway Monitoring |
| キャッシュヒット率 | >70% | アプリケーションメトリクス |
| エラー率 | <0.1% | Railway Logs |
| Circuit Breaker | 開放なし | Slack 通知 |

### 3. 定期ヘルスチェック

```bash
# 毎日 09:00 (JST) に自動実行
0 0 * * * curl https://akiyoshi-knowledge.takagi.bz/health
```

---

## トラブルシューティング

### 症状: ビルド失敗

**原因**: TypeScript コンパイルエラー

```bash
# Railway ログを確認
railway log --tail 50

# ローカルで再現
npm run build
npm run type-check
```

**対策**:
1. develop ブランチで修正
2. テスト実行 (`npm test`)
3. 再度 master に マージ・プッシュ

---

### 症状: Notion API 接続エラー

**原因**: API キーまたは DB ID が間違っている

```bash
# Railway 環境変数を確認
railway env

# ローカルで .env.test で検証
NOTION_API_KEY=<test_key> npm test
```

**対策**:
1. Railway Dashboard で環境変数を確認
2. Notion Admin から DB ID を確認
3. API キーの有効期限を確認

---

### 症状: Circuit Breaker が開きっぱなし

**原因**: 連続エラー（5回以上）が続いている

```bash
# Notion サービス状態確認
curl https://www.notion.so/api/v1/health

# Railway ログでエラー詳細確認
railway log --level error
```

**対策**:
1. Notion サービスの復帰を待つ
2. エラーが解消したら自動リセット（次の成功で）
3. 手動リセット: アプリケーション再起動

---

## ロールアウト計画（段階的リリース）

### Phase 1: ステージング環境（完了）
- [x] develop ブランチで検証
- [x] パフォーマンス計測・フォールバック検証
- [x] ステージング GO 判定

### Phase 2: 本番環境 (今から実施)
- [ ] Step 1-2: develop → master マージ・プッシュ
- [ ] Step 3: Railway ビルド・デプロイ監視
- [ ] Step 4: 本番機能確認（E2E）

### Phase 3: 本番運用
- [ ] 24 時間の監視体制
- [ ] SLA 達成確認
- [ ] ユーザーフィードバック収集

---

## デプロイ完了チェックリスト

- [ ] develop → master マージ完了
- [ ] git push origin master 実行
- [ ] Railway ビルド成功
- [ ] /health エンドポイント 200 OK
- [ ] Notion データベース接続確認
- [ ] Slack 通知機能確認
- [ ] キャッシュ動作確認
- [ ] パフォーマンス (p95) <3秒確認
- [ ] エラーログ確認（異常なし）

---

**デプロイ進行判定**: **GO - 本番環境デプロイ開始可**

次ステップ: `git push origin master` を実行して、Railway 自動デプロイを開始してください。

