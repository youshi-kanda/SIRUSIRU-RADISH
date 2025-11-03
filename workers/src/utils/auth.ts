/**
 * Authentication Utilities for Cloudflare Workers
 */

import { Env } from '../types';

/**
 * パスワードをハッシュ化（bcrypt互換の簡易版）
 * 本番環境ではより強力なハッシュアルゴリズムを使用すること
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hashHex}`;
}

/**
 * パスワードを検証
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computedHash = await hashPassword(password);
  return computedHash === hash;
}

/**
 * ランダムなトークンを生成
 */
export function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * UUIDv4を生成
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * ユーザーをメールアドレスで検索
 */
export async function findUserByEmail(env: Env, email: string): Promise<any | null> {
  const result = await env.DB.prepare(
    'SELECT * FROM users WHERE email = ? AND is_active = 1'
  ).bind(email).first();
  
  return result || null;
}

/**
 * セッションを作成
 */
export async function createSession(
  env: Env,
  userId: number,
  expiresInHours: number = 24
): Promise<string> {
  const sessionId = generateUUID();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, token, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(sessionId, userId, token, expiresAt).run();

  return token;
}

/**
 * トークンを検証してユーザー情報を取得
 */
export async function validateToken(env: Env, token: string): Promise<any | null> {
  const result = await env.DB.prepare(
    `SELECT u.*, s.expires_at
     FROM auth_sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1`
  ).bind(token).first();

  return result || null;
}

/**
 * セッションを削除（ログアウト）
 */
export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM auth_sessions WHERE token = ?'
  ).bind(token).run();
}

/**
 * 期限切れセッションをクリーンアップ
 */
export async function cleanupExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM auth_sessions WHERE expires_at < datetime('now')`
  ).run();
}

/**
 * ユーザーの最終ログイン時刻を更新
 */
export async function updateLastLogin(env: Env, userId: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET last_login_at = datetime("now") WHERE id = ?'
  ).bind(userId).run();
}
