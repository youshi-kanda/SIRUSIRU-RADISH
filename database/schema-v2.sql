-- SIRUSIRU Radish Knowledge Database - Version 2.0
-- ベクトル検索対応版

-- 保険会社マスタ
CREATE TABLE IF NOT EXISTS insurance_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_code TEXT UNIQUE NOT NULL,
  company_name TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 保険商品マスタ
CREATE TABLE IF NOT EXISTS insurance_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_category TEXT, -- '主契約', '特約'
  display_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES insurance_companies(id),
  UNIQUE(company_id, product_code)
);

-- ナレッジベクトルテーブル（メインストレージ）
CREATE TABLE IF NOT EXISTS knowledge_vectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  source_file TEXT NOT NULL, -- ファイル名
  source_type TEXT NOT NULL, -- 'csv', 'pdf', 'docx', 'txt'
  chunk_index INTEGER NOT NULL, -- チャンク番号
  chunk_text TEXT NOT NULL, -- テキスト内容
  embedding TEXT, -- JSON化したベクトル [0.1, 0.2, ...]
  metadata TEXT, -- JSON形式の追加情報
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES insurance_companies(id)
);

-- インデックス作成（検索高速化）
CREATE INDEX IF NOT EXISTS idx_knowledge_company ON knowledge_vectors(company_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_vectors(source_file);

-- FTS5全文検索テーブル（バックアップ用・高速テキスト検索）
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  chunk_text,
  source_file
);

-- システムメタデータ
CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 会話履歴テーブル（既存のまま保持）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  messages TEXT, -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
