-- SIRUSIRU Radish Knowledge Database Schema
-- Cloudflare D1 (SQLite)

-- ===================================
-- 1. Knowledge Table (ナレッジ管理)
-- ===================================
CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    disease_code TEXT NOT NULL UNIQUE,        -- 疾病コード（例: U001）
    disease_name TEXT NOT NULL,               -- 疾病名（例: 胃がん）
    condition TEXT,                           -- 状態（例: 治療中、寛解）
    main_contract TEXT,                       -- 主契約判定
    medical_rider TEXT,                       -- 医療特約判定
    cancer_rider TEXT,                        -- がん特約判定
    income_rider TEXT,                        -- 収入保障特約判定
    remarks TEXT,                             -- 備考
    content_full TEXT NOT NULL,               -- 完全なコンテンツ（検索用）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===================================
-- 2. FTS5 Virtual Table (全文検索)
-- ===================================
-- 日本語全文検索用の仮想テーブル
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    disease_code,
    disease_name,
    condition,
    content_full,
    content='knowledge',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS5テーブルを最新に保つトリガー
CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, disease_code, disease_name, condition, content_full)
  VALUES (new.id, new.disease_code, new.disease_name, new.condition, new.content_full);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, disease_code, disease_name, condition, content_full)
  VALUES('delete', old.id, old.disease_code, old.disease_name, old.condition, old.content_full);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, disease_code, disease_name, condition, content_full)
  VALUES('delete', old.id, old.disease_code, old.disease_name, old.condition, old.content_full);
  INSERT INTO knowledge_fts(rowid, disease_code, disease_name, condition, content_full)
  VALUES (new.id, new.disease_code, new.disease_name, new.condition, new.content_full);
END;

-- ===================================
-- 3. Conversation History (会話履歴)
-- ===================================
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,            -- 会話セッションID
    user_id TEXT,                             -- ユーザーID（Django連携）
    user_message TEXT NOT NULL,               -- ユーザーの質問
    ai_response TEXT NOT NULL,                -- AIの回答
    disease_detected TEXT,                    -- 検出された疾病名
    confidence_score REAL,                    -- 信頼度スコア（0.0-1.0）
    sources TEXT,                             -- 引用元（JSON配列）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===================================
-- 4. Indexes (パフォーマンス最適化)
-- ===================================
CREATE INDEX IF NOT EXISTS idx_disease_name ON knowledge(disease_name);
CREATE INDEX IF NOT EXISTS idx_disease_code ON knowledge(disease_code);
CREATE INDEX IF NOT EXISTS idx_conversation_id ON conversations(conversation_id);
CREATE INDEX IF NOT EXISTS idx_created_at ON conversations(created_at);

-- ===================================
-- 5. System Metadata (システム情報)
-- ===================================
CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- バージョン情報を記録
INSERT OR REPLACE INTO system_metadata (key, value) VALUES ('schema_version', '2.0.0');
INSERT OR REPLACE INTO system_metadata (key, value) VALUES ('last_migration', datetime('now'));
