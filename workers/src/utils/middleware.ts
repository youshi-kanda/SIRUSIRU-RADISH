/**
 * Authentication Middleware for Cloudflare Workers
 */

import { Env, User } from '../types';
import { validateToken } from './auth';

/**
 * リクエストから認証トークンを抽出
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}

/**
 * 認証ミドルウェア: トークンを検証してユーザー情報を返す
 */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<{ user: User; token: string } | null> {
  const token = extractToken(request);
  
  if (!token) {
    return null;
  }

  const user = await validateToken(env, token);
  
  if (!user) {
    return null;
  }

  return { user, token };
}

/**
 * 認証必須ミドルウェア: 認証されていない場合は401エラーを返す
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<Response | { user: User; token: string }> {
  const auth = await authenticateRequest(request, env);
  
  if (!auth) {
    return new Response(
      JSON.stringify({
        error: '認証が必要です。ログインしてください。',
        code: 'UNAUTHORIZED',
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return auth;
}

/**
 * オプショナル認証: 認証情報があれば返す、なければnull
 */
export async function optionalAuth(
  request: Request,
  env: Env
): Promise<{ user: User; token: string } | null> {
  return await authenticateRequest(request, env);
}
