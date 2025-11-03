// ============================================
// 🎯 統合設定システム（横展開対応版）
// 企業設定 + アプリケーション設定
// ============================================

// ============================================
// 🏢 企業設定マスター
// ============================================

/**
 * 企業ごとの設定を定義
 * 新しい企業を追加する場合は、ここに設定を追加するだけでOK
 */
const COMPANIES = {
  // Pollock社（元の設定）
  pollock: {
    // 基本情報
    company_name: "pollock",
    company_display_name: "Pollock株式会社",
    domain: "pollock.co.jp",
    department: "営業部",
    admin_email: "admin@pollock.co.jp",
    default_user_id: 1,

    // URL設定
    workers_url: "https://sirusiru-pollock.tsuji-090.workers.dev",
    pages_url: "https://sirusiru-pollock.noce-creative.com",
    pages_dev_url: "https://sirusiru-pollock.pages.dev",
    pages_develop_url: "https://sirusiru-pollock-develop.pages.dev",

    // 共通バックエンド
    django_api_url: "https://tenant-system.noce-creative.com",
    websocket_url: "wss://tenant-system.noce-creative.com",
    dify_base_url: "https://dify.noce-creative.com/v1"
  },

  // Radish社（新規）
  radish: {
    // 基本情報
    company_name: "radish",
    company_display_name: "株式会社Radish",
    domain: "radish-call.com",
    department: "新規事業開発部",
    admin_email: "ayumu_nishigaki@rdh.co.jp",
    default_user_id: 32,

    // URL設定
    workers_url: "https://radish-ai-engine.kanda02-1203.workers.dev",
    pages_url: "https://sirusiru-radish-hoken.noce-creative.com",
    pages_dev_url: "https://sirusiru-radish-hoken.pages.dev",
    pages_develop_url: "https://sirusiru-radish-hoken-develop.pages.dev",

    // 共通バックエンド
    django_api_url: "https://tenant-system.noce-creative.com",
    websocket_url: "wss://tenant-system.noce-creative.com",
    dify_base_url: "https://dify.noce-creative.com/v1"
  }
};

/**
 * 現在の企業設定を取得
 * @param {string} companyName - 企業名（'pollock', 'radish', etc.）
 * @returns {object} 企業設定オブジェクト
 */
function getCompanyConfig(companyName) {
  const config = COMPANIES[companyName];
  if (!config) {
    throw new Error(`Company config not found: ${companyName}`);
  }
  return config;
}

/**
 * CORS用の許可オリジンリストを生成
 * @param {object} config - 企業設定
 * @returns {array} 許可オリジンの配列
 */
function getCorsOrigins(config) {
  return [
    config.pages_url,
    config.pages_dev_url,
    config.pages_develop_url,
    config.workers_url,
    config.django_api_url,
    // 開発環境
    'http://localhost:8000',
    'http://localhost:3000'
  ];
}

/**
 * Workers環境変数形式に変換
 * @param {object} config - 企業設定
 * @returns {object} Wrangler用の環境変数オブジェクト
 */
function toWorkersEnv(config) {
  return {
    TENANT_API_BASE: config.django_api_url,
    TENANT_DOMAIN: config.domain,
    DIFY_BASE: config.dify_base_url,
    CORS_ORIGINS: getCorsOrigins(config).join(','),
    ADMIN_EMAIL: config.admin_email,
    COMPANY_NAME: config.company_display_name
  };
}

// ============================================
// 🎯 現在の企業を指定（ここを変更するだけで企業切り替え可能）
// ============================================
const CURRENT_COMPANY = "radish"; // "pollock" または "radish"

// 企業設定を取得
const companyConfig = getCompanyConfig(CURRENT_COMPANY);

// ============================================
// 📦 メイン設定オブジェクト
// ============================================

window.CONFIG = {
  // 🌐 API エンドポイント
  API_BASE: companyConfig.workers_url,
  DJANGO_API_BASE: companyConfig.django_api_url,
  WEBSOCKET_BASE: companyConfig.websocket_url,

  // 🏢 テナント情報
  TENANT_DOMAIN: companyConfig.domain,
  COMPANY_NAME: companyConfig.company_display_name,
  DEPARTMENT: companyConfig.department,

  // 👤 ユーザー情報
  DEFAULT_EMAIL: companyConfig.admin_email,
  DEFAULT_USER_ID: companyConfig.default_user_id,

  // 🎯 API エンドポイント一覧（ハードコーディング撲滅用）
  ENDPOINTS: {
    // 会話関連
    CONVERSATION_RENAME: (convId) => `${companyConfig.workers_url}/conversations/${convId}/name`,
    CONVERSATION_DELETE: (convId) => `${companyConfig.workers_url}/conversations/${convId}`,
    CONVERSATION_LIST: (userEmail) => `${companyConfig.workers_url}/api/conversation-list?user=${encodeURIComponent(userEmail)}`,
    CONVERSATION_NEW: `${companyConfig.workers_url}/api/conversations/new`,
    CONVERSATION_HISTORY: (userEmail, convId) => `${companyConfig.workers_url}/conversation-history?user=${encodeURIComponent(userEmail)}&conversation_id=${convId}`,

    // ファイル関連（Workers v7.2対応）
    FILE_UPLOAD: `${companyConfig.workers_url}/api/files/upload`,
    FILE_LIST: `${companyConfig.workers_url}/api/files/list`,
    FILE_DETAIL: `${companyConfig.workers_url}/api/files/detail`,
    FILE_UPDATE: `${companyConfig.workers_url}/api/files/update`,

    // チャット関連（Radish AI Engine v2.0）
    CHAT_MESSAGES: `${companyConfig.workers_url}/api/chat`,
    CHAT_FILE_UPLOAD: `${companyConfig.workers_url}/api/chat-files/upload`,

    // ドキュメント関連
    DOCUMENT_VIEW: (docId) => `${companyConfig.workers_url}/documents/${docId}`,

    // 権限・知識ベース関連（Workers v7.2対応）
    ACCESSIBLE_KNOWLEDGE_BASES: `${companyConfig.workers_url}/api/user/accessible-knowledge-bases`,

    // 音声関連（Workers v7.2対応）
    AUDIO_TO_TEXT: `${companyConfig.workers_url}/api/audio-to-text`,
    TEXT_TO_AUDIO: `${companyConfig.workers_url}/api/text-to-audio`,

    // システム関連（Workers v7.2対応）
    API_STATUS: `${companyConfig.workers_url}/api/api-status`,
    TEST_DIFY: `${companyConfig.workers_url}/api/test-dify`,
    PARAMETERS: `${companyConfig.workers_url}/api/parameters`,

    // 認証関連（Workers v7.2対応）
    LOGIN: `${companyConfig.workers_url}/api/token/`,
    TOKEN: `${companyConfig.workers_url}/api/token/`,
    TOKEN_REFRESH: `${companyConfig.workers_url}/api/token/refresh/`,

    // ユーザー関連（Workers v7.2対応）
    USER_PROFILE: `${companyConfig.workers_url}/app/api/user/profile`,

    // トークン管理（Workers v7.2対応）
    TOKEN_BALANCE: `${companyConfig.workers_url}/app/api/tokens/balance`,
    TOKEN_CONSUME: `${companyConfig.workers_url}/app/api/tokens/consume`,

    // サブスクリプション
    SUBSCRIPTION_STATUS: `${companyConfig.workers_url}/app/api/subscription/status`,

    // その他
    MEDIA_BASE: `${companyConfig.workers_url}/media/`,
    DATASETS_DOCUMENT: (docId) => `${companyConfig.workers_url}/datasets/your_dataset_id/documents/${docId}`
  },

  // 🔗 外部サービス URL
  EXTERNAL_SERVICES: {
    // CDN
    PDF_JS: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js",
    PDF_WORKER: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js",
    TESSERACT: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",

    // 企業サイト
    COMPANY_WEBSITE: "https://nocecreative.com/",

    // WebSocket
    WEBSOCKET_PERMISSIONS: (userId) => `${companyConfig.websocket_url}/ws/permissions/${userId}/`
  },

  // ⚙️ アプリケーション設定
  APP_SETTINGS: {
    // トークン管理
    TOKEN_KEY: "accessToken",
    REFRESH_KEY: "refreshToken",
    USER_EMAIL_KEY: "userEmail",
    USER_INFO_KEY: "userInfo",

    // リトライ設定
    MAX_RETRY: 2,

    // キャッシュ設定
    CACHE_DURATION: {
      USER_PROFILE: 10 * 60 * 1000,        // 10分
      CONVERSATION_LIST: 5 * 60 * 1000,    // 5分
      TOKEN_REFRESH_INTERVAL: 20 * 60 * 1000  // 20分
    },

    // フィーチャーフラグ
    FEATURES: {
      SUGGESTED_QUESTIONS: false,
      FILE_UPLOAD: false,  // ファイルアップロードも無効化
      AUDIO_FEATURES: false,  // 音声機能も無効化
      WEBSOCKET_UPDATES: false,  // WebSocketも無効化
      DYNAMIC_CONFIG: false,  // 動的設定は無効化
      SKIP_AUTH_FOR_TESTING: false  // Django JWT認証を使用
    },

    // UI設定
    UI: {
      MAX_FILE_SIZE: 10 * 1024 * 1024,     // 10MB
      SUPPORTED_FILE_TYPES: ['.pdf', '.txt', '.docx', '.jpg', '.png'],
      CHAT_HISTORY_LIMIT: 100
    }
  },

  // 📱 レスポンシブ設定
  RESPONSIVE: {
    MOBILE_BREAKPOINT: 768,
    TABLET_BREAKPOINT: 1024
  },

  // 🎨 テーマ設定
  THEME: {
    PRIMARY_COLOR: "#007bff",
    SECONDARY_COLOR: "#6c757d",
    SUCCESS_COLOR: "#28a745",
    WARNING_COLOR: "#ffc107",
    ERROR_COLOR: "#dc3545"
  },

  // 🌍 国際化設定
  I18N: {
    DEFAULT_LANGUAGE: "ja",
    SUPPORTED_LANGUAGES: ["ja", "en"],
    DATE_FORMAT: "YYYY-MM-DD",
    TIME_FORMAT: "HH:mm:ss"
  },

  // 🚀 デプロイ用設定
  DEPLOYMENT: {
    // Cloudflare Workers環境変数
    workers_env_vars: toWorkersEnv(companyConfig),

    // Django設定
    django_settings: {
      tenant_name: companyConfig.company_display_name,
      tenant_domain: companyConfig.domain,
      cors_origins: [
        companyConfig.pages_url,
        companyConfig.pages_dev_url
      ]
    }
  }
};

// ============================================
// 🔧 ヘルパー関数
// ============================================

/**
 * 安全な設定取得関数
 * @param {string} path - ドット区切りのパス（例: "APP_SETTINGS.MAX_RETRY"）
 * @param {*} fallback - 設定が見つからない場合のデフォルト値
 * @returns {*} 設定値
 */
window.getConfig = function(path, fallback = null) {
  const keys = path.split('.');
  let value = window.CONFIG;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return fallback;
    }
  }

  return value;
};

/**
 * オプション：ログイン後の動的設定更新（エラー発生時は無視）
 */
window.updateConfigFromAPI = async function() {
  if (!window.CONFIG.APP_SETTINGS.FEATURES.DYNAMIC_CONFIG) {
    return; // 動的設定が無効の場合はスキップ
  }

  try {
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    // 安全にテナント情報を取得（404でもエラーにしない）
    const response = await fetch(`${companyConfig.django_api_url}/api/tenant/current/`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Tenant-Domain': companyConfig.domain
      }
    });

    if (response.ok) {
      const tenantData = await response.json();

      // 安全に設定を更新
      if (tenantData.name) {
        window.CONFIG.COMPANY_NAME = tenantData.name;
      }
      if (tenantData.domain) {
        window.CONFIG.TENANT_DOMAIN = tenantData.domain;
      }
    }
  } catch (error) {
    // エラーは無視（静的設定で継続）
  }
};

// ============================================
// 📦 エクスポート（generate-wrangler.js用）
// ============================================

// Node.js環境（Workers/ビルド時）用のエクスポート
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    COMPANIES,
    getCompanyConfig,
    getCorsOrigins,
    toWorkersEnv
  };
}

// ブラウザ環境用のエクスポート
if (typeof window !== 'undefined') {
  window.CompanyConfig = {
    COMPANIES,
    getCompanyConfig,
    getCorsOrigins,
    toWorkersEnv
  };
}

// ============================================
// 🎯 初期化完了通知
// ============================================

console.log(`🏢 企業設定: ${CURRENT_COMPANY} (${companyConfig.company_display_name})`);
console.log(`🌐 Workers URL: ${companyConfig.workers_url}`);
console.log(`📧 管理者メール: ${companyConfig.admin_email}`);

// 設定完了イベントを発火
window.dispatchEvent(new CustomEvent('configReady', {
  detail: window.CONFIG
}));
