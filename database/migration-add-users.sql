-- ユーザー認証テーブルの追加
-- Migration: Add users table for authentication

-- ユーザーテーブル
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'user', -- 'admin', 'user', 'operator'
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME
);

-- セッショントークンテーブル
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY, -- UUID
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);

-- テストユーザーを作成（パスワード: aqmbJuU9^rK*Z#2J）
-- SHA-256ハッシュ値
INSERT INTO users (email, password_hash, name, role, is_active)
VALUES (
  'radish-test@test.com',
  'sha256:acb90e803efb0422f0dd2ef1b806f5b667c14ebe5e8d31e330b3683962d5661f',
  'テストユーザー',
  'admin',
  1
) ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  updated_at = datetime('now');
