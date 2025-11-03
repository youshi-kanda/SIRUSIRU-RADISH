-- 会話状態管理フィールドを追加
-- 既存のconversationsテーブルを拡張

-- 一時テーブルを作成してデータを移行
CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  state TEXT DEFAULT 'INITIAL', -- 会話の状態
  current_step TEXT, -- 現在のステップ(サブ状態)
  collected_data TEXT, -- 収集したデータ(JSON)
  messages TEXT, -- メッセージ履歴(JSON)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 既存データを移行
INSERT INTO conversations_new (id, user_id, messages, created_at, updated_at)
SELECT id, user_id, messages, created_at, updated_at
FROM conversations;

-- 古いテーブルを削除
DROP TABLE conversations;

-- 新しいテーブルをリネーム
ALTER TABLE conversations_new RENAME TO conversations;

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(state);
