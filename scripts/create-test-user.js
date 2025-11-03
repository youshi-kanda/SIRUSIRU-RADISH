/**
 * テストユーザー作成スクリプト
 * Usage: node scripts/create-test-user.js
 */

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hashHex}`;
}

async function main() {
  const email = 'radish-test@test.com';
  const password = 'aqmbJuU9^rK*Z#2J';
  
  const passwordHash = await hashPassword(password);
  
  console.log('===== テストユーザー情報 =====');
  console.log('Email:', email);
  console.log('Password:', password);
  console.log('Password Hash:', passwordHash);
  console.log('');
  console.log('===== SQL =====');
  console.log(`
INSERT INTO users (email, password_hash, name, role, is_active)
VALUES (
  '${email}',
  '${passwordHash}',
  'テストユーザー',
  'admin',
  1
) ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  updated_at = datetime('now');
  `.trim());
}

main().catch(console.error);
