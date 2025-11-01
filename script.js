// ================================
// JavaScript全体コード (再設計版 + 修正版)
// ================================

// グローバル変数
let conversationId = "";        // 会話ID
let isAudioInitialized = false; // 音声再生初期化フラグ(未使用例)
let mediaRecorder;              // MediaRecorderインスタンス
let autoCalibrated = false;
let calibrationStartTs = 0;
let lastNonSilenceTime = 0;
let audioChunks = [];           // 録音データ格納
let lastBotResponse = "";       // 最新のBot返答
let historyList;                // 会話履歴表示用の<ul>参照
let isProcessingHistory = false;  // 履歴取得中フラグ
let historyRetryCount = 0;      // 履歴取得リトライカウント
const MAX_HISTORY_RETRIES = 3;  // 最大リトライ回数
let isProcessingInput = false;  // 送信処理中フラグ（重複送信防止）
let tokenRefreshTimer = null;   // ログインセッション維持用タイマー
let unauthorizedKeydownHandler = null;
let sidebarEl = null;
let currentAudio = null;

// WebSocket権限更新用変数
let permissionWebSocket = null;
let wsReconnectAttempts = 0;
let wsMaxReconnectAttempts = 5;
let wsReconnectDelay = 1000; // 初回は1秒、失敗ごとに倍増

// ドラッグ&ドロップ用変数
let dragCounter = 0;            // ドラッグイベントカウンター
let dropZoneOverlay = null;     // ドロップゾーンオーバーレイ要素

// チャット添付ファイル管理
let attachedFiles = [];         // 添付されたファイルの配列
let chatDragCounter = 0;        // チャット用ドラッグカウンター
let lastAttachedFileInfo = null; // 最後に添付されたファイル情報（会話継続用）

// リトライ制御用変数の追加
let isRetrying = false;
let retryBackoff = [1000, 2000, 4000, 8000]; // バックオフ時間 (ミリ秒)
let failedRequestCache = new Map(); // 失敗したリクエストの一時キャッシュ

const MAX_RETRY = getConfig('APP_SETTINGS.MAX_RETRY');
let logoutAlertShown   = false;

// 🌐 API設定（config.jsから自動取得）
// 設定ファイルの読み込み確認
if (!window.CONFIG) {
  console.error('❌ config.js が読み込まれていません。HTMLで<script src="config.js"></script>を追加してください。');
  alert('設定ファイルエラー: config.js が見つかりません');
}

// 🎯 設定ファイルから値を取得するヘルパー関数
function getConfig(path) {
  const keys = path.split('.');
  let value = window.CONFIG;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      throw new Error(`Configuration not found: ${path}`);
    }
  }

  return value;
}

// 🌐 基本設定
const API_BASE = getConfig('API_BASE');
const DJANGO_API_BASE = getConfig('DJANGO_API_BASE');
const TOKEN_KEY = getConfig('APP_SETTINGS.TOKEN_KEY');
const REFRESH_KEY = getConfig('APP_SETTINGS.REFRESH_KEY');

// ================================
// Django Cookie取得関数
// ================================
async function getDjangoCookies() {
    return new Promise((resolve, reject) => {
        // 隠しiframeを作成してDjango管理画面にアクセス
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.style.width = '1px';
        iframe.style.height = '1px';
        
        // タイムアウト設定（10秒）
        const timeout = setTimeout(() => {
            document.body.removeChild(iframe);
            resolve(null); // タイムアウト時はnullを返す
        }, 10000);
        
        iframe.onload = function() {
            try {
                // iframeからCookieを読み取ろうとする（同一オリジンポリシーにより制限される可能性あり）
                const cookies = {};
                
                // postMessageでCookie情報を要求（後で実装）
                iframe.contentWindow.postMessage({ type: 'GET_COOKIES' }, DJANGO_API_BASE);
                
                // Fallback: localStorageからDjango認証情報を取得
                const storedSession = localStorage.getItem('django_sessionid');
                const storedCSRF = localStorage.getItem('django_csrftoken');
                
                if (storedSession && storedCSRF) {
                    cookies.sessionid = storedSession;
                    cookies.csrftoken = storedCSRF;
                } else {
                    // 手動で既知のCookie値を設定（ユーザー提供・更新済み）
                    cookies.sessionid = '4cvclgru4ptfkeeqqobghmwpje4m79on'; // 最新のsessionid（2025-09-08更新）
                    cookies.csrftoken = 'TjYBW8GRMomBcjWeeuujIYFn63qgu4DO'; // 最新のcsrftoken（2025-09-08更新）
                    
                    // 今後の使用のためにlocalStorageに保存
                    localStorage.setItem('django_sessionid', cookies.sessionid);
                    localStorage.setItem('django_csrftoken', cookies.csrftoken);
                }
                
                clearTimeout(timeout);
                document.body.removeChild(iframe);
                resolve(cookies);
                
            } catch (error) {
                console.error('❌ Django Cookie取得エラー:', error);
                clearTimeout(timeout);
                document.body.removeChild(iframe);
                resolve({}); // エラー時は空のオブジェクトを返す
            }
        };
        
        iframe.onerror = function() {
            console.error('❌ Django管理画面への接続に失敗');
            clearTimeout(timeout);
            document.body.removeChild(iframe);
            resolve({});
        };
        
        // Django管理画面の軽量ページにアクセス
        iframe.src = `${DJANGO_API_BASE}/admin/login/?next=/admin/`;
        document.body.appendChild(iframe);
    });
}

// JWT自動取得フラグ
let isJwtTokenReady = false;
let jwtTokenInitPromise = null;

// ================================
// JWT自動取得機能
// ================================

/**
 * セッション認証を使ってJWTトークンを自動取得（テナント切り替え対応）
 */
async function initializeJwtToken() {
    if (jwtTokenInitPromise) {
        return jwtTokenInitPromise;
    }

    jwtTokenInitPromise = _doInitializeJwtToken();
    return jwtTokenInitPromise;
}

async function _doInitializeJwtToken() {
    try {
        // ログイン済みの場合はJWT自動取得をスキップ
        const accessToken = localStorage.getItem('accessToken');
        const existingJwtToken = localStorage.getItem('access_token');
        const currentTenant = localStorage.getItem('userTenant');

        if (accessToken || (existingJwtToken && currentTenant)) {
            isJwtTokenReady = true;
            return true;
        }

        // 未ログイン状態でのJWT取得は不要
        console.log('JWT自動取得をスキップ: ログイン後に実行されます');
        return false;

    } catch (error) {
        console.error('❌ JWTトークン初期化エラー:', error);
        isJwtTokenReady = false;
        return false;
    }
}

/**
 * CSRFトークンを取得（Django CSRF保護用）
 */
function getCsrfToken() {
    const csrfCookie = document.cookie
        .split('; ')
        .find(row => row.startsWith('csrftoken='));
    
    return csrfCookie ? csrfCookie.split('=')[1] : '';
}

/**
 * API呼び出し前にJWTトークンの準備を確認
 */
async function ensureJwtToken() {
    // ログイン済みの場合はJWTトークンは不要（accessTokenを使用）
    const accessToken = localStorage.getItem('accessToken');
    if (accessToken) {
        return accessToken; // 通常認証トークンを返す
    }

    // ログインしていない場合のみJWT自動取得を試行
    if (!isJwtTokenReady) {
        await initializeJwtToken();
    }

    const jwtToken = localStorage.getItem('access_token');
    if (!jwtToken) {
        throw new Error('JWT token is not available');
    }

    return jwtToken;
}
const MEDIA_API_BASE = getConfig('ENDPOINTS.MEDIA_BASE');

const PRODUCT_CHAT  = "chat";
const PRODUCT_IMAGE = "image";
const FEATURE_SUGGESTED_QUESTIONS = getConfig('APP_SETTINGS.FEATURES.SUGGESTED_QUESTIONS');

// Django API認証ヘッダー関数（Workers経由統一）
function addAuthHeaders(headers = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// Workers経由API呼び出し統一関数
async function workersApiFetch(endpoint, options = {}) {
  // トークンの準備を確認（accessToken または access_token）
  let token;
  try {
    token = await ensureJwtToken();
  } catch (error) {
    console.error('❌ Token preparation failed:', error);
    throw new Error('認証に失敗しました。ログインしてください。');
  }

  const config = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`, // JWTトークンを使用
      ...addAuthHeaders(),
      ...options.headers
    }
  };
  
  // すべてのAPI呼び出しをWorkers経由に統一
  const workersUrl = `${API_BASE}${endpoint}`;

  return fetch(workersUrl, config);
}

// ファイル一覧取得（Workers経由でDjango連携）
async function loadFilesList() {
  try {
    const response = await workersApiFetch('/api/files/list');
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ファイル一覧の取得に失敗しました`);
    }
    
    const data = await response.json();

    // 別テナントエラーの場合は、そのまま返してdisplayFileListで処理
    if (data.error === 'different_tenant') {
      return data;
    }

    if (data.error) {
      throw new Error(data.error);
    }
    
    // 権限情報を含むファイル一覧を取得
    const filesWithPermissions = await fetchFilesList();
    
    // ファイル一覧を表示（displayFilesList関数を使用）
    if (typeof displayFilesList === 'function') {
      displayFilesList(filesWithPermissions, data.knowledge_base, data.quota_info);
    }
    
    return filesWithPermissions || [];
    
  } catch (error) {
    console.error("❌ ファイル一覧取得エラー:", error);
    
    // エラー表示を更新
    const filesContainer = document.getElementById("files-container");
    if (filesContainer) {
      filesContainer.innerHTML = `
        <div class="alert alert-warning">
          <h6>ファイル一覧の取得に失敗しました</h6>
          <p>${error.message}</p>
          <small class="text-muted">Workers経由でのDjango連携を確認してください。</small>
        </div>
      `;
    }
    
    return [];
  }
}

/* ―――― 会話タイトル用ミニメニュー共有関数 ―――― */
let activeConvMenu = null;           // 開いているメニューを退避
function closeConvMenu(){
  if(activeConvMenu){
    activeConvMenu.remove();
    activeConvMenu = null;
    document.removeEventListener("click", closeConvMenu);
  }
}


// 簡易的なインメモリキャッシュ
const apiCache = {
  data: new Map(),
  ttl: new Map(),
  
  // キャッシュにデータを設定（ttlはミリ秒単位）
  set(key, data, ttl = 60000) {
    this.data.set(key, data);
    this.ttl.set(key, Date.now() + ttl);
  },
  
  // キャッシュからデータを取得
  get(key) {
    if (!this.data.has(key)) return null;
    if (Date.now() > this.ttl.get(key)) {
      // 期限切れならキャッシュ削除
      this.data.delete(key);
      this.ttl.delete(key);
      return null;
    }
    return this.data.get(key);
  },
  
  // キャッシュをクリア
  clear(key) {
    if (key) {
      this.data.delete(key);
      this.ttl.delete(key);
    } else {
      this.data.clear();
      this.ttl.clear();
    }
  }
};

// 無音検出用(必要なら再度追加)
let audioContext;
let analyser;
let source;
let silenceDetectionTimer;
let silenceThreshold = 0;    // 無音判定しきい値
let silenceDuration = 3000;   // 3秒続いたら停止（少し長めに）
let minRecordingDuration = 1000; // 最低録音時間（1秒）

// 送信ボタン、録音ボタン
const sendButton = document.getElementById("send-button");
const recordButton = document.getElementById("record-button");

// 音声認識の状態管理
let recordingState = 'idle'; // 'idle', 'starting', 'recording', 'stopping', 'processing'
let recordingStartTime = 0;


// ================================
// 1.5) PDFからテキスト抽出（新機能追加）
// ================================

// pdf.js を動的に読み込む関数
function loadPDFjsLib() {
  return new Promise((resolve, reject) => {
    if (window.pdfjsLib) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = getConfig('EXTERNAL_SERVICES.PDF_JS');
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = getConfig('EXTERNAL_SERVICES.PDF_WORKER');
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Tesseract.js を動的に読み込む関数
function loadTesseractJS() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = getConfig('EXTERNAL_SERVICES.TESSERACT');
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/**
 * PDFファイル（application/pdf）から、1ページ目を画像化しTesseract.jsでOCR処理を実行してテキストを抽出する
 * @param {File} file - PDFファイル
 * @returns {Promise<string>} - 抽出されたテキスト（失敗時は空文字列）
 */
async function extractTextFromPDF(file) {
  try {
    // ファイルがPDFか確認
    if (file.type !== "application/pdf") return "";
    // ファイルをDataURLとして読み込み
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    // pdf.js を読み込む
    await loadPDFjsLib();
    const loadingTask = window.pdfjsLib.getDocument(dataUrl);
    const pdfDoc = await loadingTask.promise;
    // 1ページ目を取得
    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 }); // 拡大して精度向上
    // オフスクリーンCanvas作成
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    const renderContext = { canvasContext: context, viewport: viewport };
    await page.render(renderContext).promise;
    // Canvasから画像データURLを取得
    const imageDataUrl = canvas.toDataURL("image/png");
    // Tesseract.js を読み込む
    await loadTesseractJS();
    const worker = await Tesseract.createWorker();
    await worker.load();
    await worker.loadLanguage("jpn");
    await worker.initialize("jpn");
    const { data: { text } } = await worker.recognize(imageDataUrl);
    await worker.terminate();
    return text;
  } catch (error) {
    console.error("PDF OCR抽出エラー:", error);
    return "";
  }
}

/**
 * 会話タイトルを変更する
 * @param {string} convId  - conversation_id
 * @param {string} newName - 新しい名称
 */
async function renameConversation(convId, newName){
  const userEmail = localStorage.getItem("userEmail") || "anonymous";
  const url = getConfig('ENDPOINTS.CONVERSATION_RENAME') ? getConfig('ENDPOINTS.CONVERSATION_RENAME')(convId) : `${API_BASE}/conversations/${convId}/name`;
  const resp = await apiFetch(url, {
    method : "POST",
    headers: { "Content-Type":"application/json" },
    body   : JSON.stringify({ name:newName, user:userEmail })
  });

  if(!resp.ok){
    const txt = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${txt}`);
  }
  // 成功したら必要に応じて resp.json() で updated_at など取得可
  apiCache.clear(`history-${convId}`);
}

/**
 * 会話を削除する
 * @param {string} convId
 */
async function deleteConversation(convId){
  const userEmail = localStorage.getItem("userEmail") || "anonymous";
  const url = getConfig('ENDPOINTS.CONVERSATION_DELETE') ? getConfig('ENDPOINTS.CONVERSATION_DELETE')(convId) : `${API_BASE}/conversations/${convId}`;
  const resp = await apiFetch(url, {
    method : "DELETE",
    headers: { "Content-Type":"application/json" },
    body   : JSON.stringify({ user: userEmail }),
    timeout: 10000
  });
  if(!resp.ok){
    const txt = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${txt}`);
  }
  apiCache.clear(`history-${convId}`);
}



// ================================
// 1) 入力欄の有効/無効制御
// ================================
function disableUserInput() {
  const inputField = document.getElementById("user-input");
  if (inputField) {
    inputField.disabled = true;
  }
}

function enableUserInput() {
  const inputField = document.getElementById("user-input");
  if (inputField) {
    inputField.disabled = false;
    // 入力欄を有効化後、自動的にフォーカスを設定
    setTimeout(() => {
      inputField.focus();
    }, 100); // 少し遅延させて確実にフォーカス
  }
}


// ================================
// 2) 入力された内容を処理
// ================================
async function processInput(inputText, audioFile, uploadedFileId = null) {
  try {
    // 既に処理中なら何もしない（重複送信防止）
    if (isProcessingInput) return;
    
    // 処理中フラグをON
    isProcessingInput = true;
    
    // 送信中の重複防止
    disableUserInput();

    let userInput = inputText;

    // 音声ファイル → テキスト認識
    if (audioFile) {
      updateSystemMessage("🎤 音声を解析しています...");
      const textFromAudio = await uploadAudio(audioFile);
      if (textFromAudio && textFromAudio.trim()) {
        // カタカナ表記を英字表記に統一
        userInput = normalizeTextForChat(textFromAudio.trim());
        
        updateSystemMessage(`🎤 音声認識完了: "${userInput}"`);
        
        // 1秒後にメッセージを削除して送信
        setTimeout(() => {
          removeSpecificSystemMessage(`🎤 音声認識完了: "${userInput}"`);
        }, 1000);
      } else {
        throw new Error("音声が認識できませんでした。もう一度はっきりと話してください。");
      }
    }

    if (!userInput) {
      addMessage("入力が空です。もう一度お試しください。", "system");
      return;
    }

    // ファイルアップロードのIDがある場合
    let filesParam = [];
    if (uploadedFileId) {
      filesParam.push({
        type: "document",
        transfer_method: "local_file",
        upload_file_id: uploadedFileId
      });
    }

    // チャット入力テキストの正規化（カタカナ→英字統一）
    userInput = normalizeTextForChat(userInput);

    // メッセージ送信
    await sendMessage(userInput, filesParam);
    
    // テストモードではトークン消費をスキップ
    if (getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
      console.log('🔓 テストモード: トークン消費APIコールをスキップ');
    } else {
      // トークン消費（1会話送信につき1トークン減算）
      try {
        const newBalance = await consumeTokens(1);
        if (newBalance !== null && newBalance !== undefined) {
          updateBalanceDisplay(newBalance);
        }
      } catch (tokenError) {
        // 401エラーの場合はトークンリフレッシュを試行
        if (tokenError.message && tokenError.message.includes('401')) {
          try {
            const refreshed = await tryRefresh();
            if (refreshed) {
              // リフレッシュ成功後に再度トークン消費を試行
              const newBalance = await consumeTokens(1);
              if (newBalance !== null && newBalance !== undefined) {
                updateBalanceDisplay(newBalance);
              }
            }
          } catch (retryError) {
            console.error("トークン消費リトライエラー:", retryError);
          }
        } else {
          console.error("トークン消費エラー:", tokenError);
        }
        // トークンエラーでもメッセージ送信は成功しているので、エラー表示は行わない
      }
    }

  } catch (err) {
    console.error("Error in processInput:", err);
    addMessage("エラーが発生しました。もう一度試してください。", "system");
  } finally {
    // 入力欄クリア & 有効化
    const inputField = document.getElementById("user-input");
    if (inputField) {
      inputField.value = "";
      enableUserInput();
    }
    // 処理中フラグをOFF
    isProcessingInput = false;
  }
}

// ================================
// 2.5) 初回挨拶メッセージを表示
// ================================
async function displayInitialGreeting() {
  try {
    // 既にメッセージがある場合はスキップ
    const chatHistory = document.getElementById("chat-history");
    if (chatHistory && chatHistory.children.length > 0) {
      return;
    }

    // API から初回メッセージを取得
    const endpoint = getConfig('ENDPOINTS.CHAT_MESSAGES');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '',
        conversation_id: null,
        user_id: 'test-user'
      })
    });

    if (response.ok) {
      const data = await response.json();
      if (data.answer) {
        addMessage(data.answer, 'bot');
        if (data.conversation_id) {
          conversationId = data.conversation_id;
        }
      }
    }
  } catch (error) {
    console.error('初回メッセージ取得エラー:', error);
    // エラーの場合はデフォルトメッセージを表示
    addMessage(
      'お電話ありがとうございます。保険加入のご相談ですね。\n' +
      '何か気になる症状や、既往症がございますか？\n' +
      '具体的な症状（例：胃が痛い）や病名（例：胃炎）をお聞かせください。',
      'bot'
    );
  }
}


// ================================
// 3) メッセージを送信
// ================================
async function sendMessage(userInput, files = []) {
  let resp; // 変数を関数スコープで宣言
  try {
    startLoadingState();

    if (userInput) {
      addMessage(userInput, "user");
    }

    const userEmail = localStorage.getItem("userEmail") || "anonymous";

    // 新しいWorkers APIでは会話IDは自動生成される（作成不要）
    console.log("チャット送信開始 - 会話ID:", conversationId || "新規会話");

    // 知識ベース設定状況をデバッグ
    try {
      const kbResponse = await apiFetch(getConfig('ENDPOINTS.ACCESSIBLE_KNOWLEDGE_BASES'), {
        method: "GET"
      });
      if (kbResponse.ok) {
        const kbData = await kbResponse.json();
      }
    } catch (kbError) {
      // Knowledge base check error handled silently
    }

    // 添付ファイルがある場合、アップロード済みのファイルを使用
    let chatFiles = files;
    if (attachedFiles.length > 0) {
      // ファイル情報を順次処理するためのPromise配列を作成
      const filePromises = attachedFiles
        .filter(fileItem => fileItem.status === 'uploaded' && fileItem.uploadFileId)
        .map(async (fileItem) => {
          if (fileItem.uploadResult && fileItem.uploadResult.is_temp) {
            // Base64エンコードされたファイルの場合
            const fileType = fileItem.uploadResult.file_type || "image";
            const isImage = fileItem.uploadResult.is_image || fileType === "image";
            
            
            // Base64データをそのまま使用（fileToBase64は既にdata:URLを返す）
            let dataUrl = fileItem.uploadResult.base64_data;
            
            // 画像ファイルはlocal_file方式でアップロード
            if (fileType === "image") {
              const formData = new FormData();
              formData.append('file', fileItem.file);
              formData.append('user', userEmail);

              const response = await apiFetch(getConfig('ENDPOINTS.FILE_UPLOAD'), {
                method: "POST",
                body: formData
              });

              if (response.ok) {
                const uploadData = await response.json();
                return {
                  type: fileType,
                  transfer_method: "local_file",
                  upload_file_id: uploadData.id
                };
              } else {
                throw new Error(`画像ファイルのアップロードに失敗しました。`);
              }
            } else {
              // 非画像ファイルはlocal_fileで送信
              return {
                type: fileType,
                transfer_method: "local_file",
                upload_file_id: fileItem.uploadFileId
              };
            }
          } else if (fileItem.uploadResult && !fileItem.uploadResult.is_temp) {
            // 正常にアップロードされた非画像ファイルの場合
            const fileType = fileItem.uploadResult.file_type || getFileTypeForDify(fileItem.file);
            return {
              type: fileType,
              transfer_method: "local_file",
              upload_file_id: fileItem.uploadFileId
            };
          }
          return null;
        });
      
      // すべてのファイル処理を待つ
      const processedFiles = await Promise.all(filePromises);
      chatFiles = processedFiles.filter(file => file !== null); // nullを除外
    }

    // デバッグ用ログ
    if (chatFiles && chatFiles.length > 0) {
    }

    // userInputのサニタイズ処理を追加
    const sanitizedInput = userInput
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 制御文字を削除
      .trim(); // 前後の空白を削除
    
    // デバッグ用: 元の入力と処理後の入力を比較
    if (userInput !== sanitizedInput) {
    }

    // Radish AI Engine v2.0 APIリクエスト形式
    const requestBody = {
      query: sanitizedInput
    };
    
    // conversation_idが有効な場合のみ追加（空文字は送信しない）
    if (conversationId && conversationId.trim() !== "") {
      requestBody.conversation_id = conversationId;
    }
    
    // user_idを追加（オプション）
    if (userEmail) {
      requestBody.user_id = userEmail;
    }
    
    // 注: ファイルアップロード機能は後で実装
    // 現在の新APIはファイルをサポートしていません

    console.log("送信するリクエストボディ:", JSON.stringify(requestBody, null, 2));

    resp = await apiFetch(getConfig('ENDPOINTS.CHAT_MESSAGES'), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    /* ====== エラーハンドリング強化 (400 → Overloaded も検知) ====== */
    if (!resp.ok) {
      const bodyText = await resp.text();
      console.error("Chat API Error:", bodyText);

      // 知識ベース未選択エラーをチェック
      if (bodyText.includes("知識ベースが選択されていません") || bodyText.includes("knowledge base not selected")) {
        throw new Error("申し訳ございません。知識ベースが選択されていません。\n\n管理画面で使用する知識ベースを選択してから、もう一度質問してください。");
      }

      // 会話が存在しないエラー（404）をチェック
      if (resp.status === 404 && (bodyText.includes("Conversation Not Exists") || bodyText.includes("not_found"))) {
        console.warn("会話が存在しません。新規会話を作成して再試行します。", conversationId);

        try {
          // 新規会話を作成
          await createNewConversation();

          // 新しい会話IDで再試行
          const retryRequestBody = {
            ...requestBody,
            conversation_id: conversationId
          };

          console.log("新規会話作成後の再試行:", {
            newConversationId: conversationId,
            retryBody: retryRequestBody
          });

          const retryResp = await apiFetch(getConfig('ENDPOINTS.CHAT_MESSAGES'), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(retryRequestBody)
          });

          if (retryResp.ok) {
            console.log("会話404エラー -> 新規会話作成 -> 再送信成功");
            return await handleStreamingResponse(retryResp, userInput, messageContainer);
          } else {
            const retryBodyText = await retryResp.text();
            console.error("新規会話作成後の再試行も失敗:", retryBodyText);
            throw new Error("会話の再作成と再送信に失敗しました。もう一度お試しください。");
          }
        } catch (conversationError) {
          console.error("新規会話作成に失敗:", conversationError);
          throw new Error("会話が見つからず、新規会話の作成にも失敗しました。ページを再読み込みしてもう一度お試しください。");
        }
      }

      // 認証エラー（401）をチェック
      if (resp.status === 401 || bodyText.includes("認証") || bodyText.includes("Authentication")) {
        console.error("認証エラー検出。再ログインが必要です。");
        showLoginModal();
        throw new Error("認証が失効しました。再ログインしてください。");
      }

      // UUID関連エラーをチェック（テナント切り替え時の問題対応）
      if (bodyText.includes("Input must have uuid") || bodyText.includes("uuid") || bodyText.includes("UUID")) {
        console.warn("UUID関連エラー検出。テナント切り替えによる認証問題:", userEmail);

        // 現在の認証情報をクリアして再ログインを促す
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("userEmail");
        localStorage.removeItem("userRoles");
        localStorage.removeItem("userTenant");
        localStorage.removeItem("userTokenBalance");

        // WebSocket接続もクリア
        if (permissionWebSocket) {
          permissionWebSocket.close();
          permissionWebSocket = null;
        }

        showLoginModal();
        throw new Error("ユーザー認証に問題があります。別の企業のアカウントでログインしてください。");
      }

      // JSONDecodeErrorの詳細なデバッグ情報
      if (bodyText.includes("JSONDecodeError")) {
        console.error("JSONDecodeError detected. Request details:", {
          originalInput: userInput,
          sanitizedInput: sanitizedInput || userInput,
          requestBody: requestBody,
          stringifiedBody: JSON.stringify(requestBody),
          hasSpecialChars: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(userInput),
          userEmail: userEmail,
          conversationId: conversationId
        });
      }
  
      let userMsg = "";
      
      // デバッグ情報をコンソールに出力
      console.error("Dify APIエラー詳細:", {
        status: resp.status,
        statusText: resp.statusText,
        url: resp.url,
        bodyText: bodyText.substring(0, 500), // 最初の500文字のみ
        hasFiles: chatFiles && chatFiles.length > 0,
        fileCount: chatFiles ? chatFiles.length : 0
      });
  
      /* JSON なら詳細を解析 */
      try {
        const j = JSON.parse(bodyText);          // {"error":"{...json...}"}
        const inner = typeof j.error === "string" ? JSON.parse(j.error) : j.error;
        const msg   = inner?.message || inner;
  
        /* モデル過負荷系 */
        if (/overloaded|ServiceUnavailable|Server\s+Unavailable|503/i.test(msg)) {
          userMsg = "現在モデルが混雑しています。数十秒待ってから再度お試しください。";
        } 
        /* ファイル関連エラー */
        else if (/Reached maximum retries.*for URL data:/i.test(msg)) {
          // 添付ファイルを自動削除
          if (attachedFiles.length > 0) {
            attachedFiles.length = 0;
            updateAttachedFilesDisplay();
          }
          userMsg = "添付されたファイルの処理でエラーが発生したため、ファイルを削除しました。\n\nファイルサイズが大きすぎるか、ファイル形式が対応していない可能性があります。\n\n同じメッセージをファイルなしで再送信してください。";
        }
        else if (/invalid_param/i.test(msg)) {
          
          if (/file/i.test(msg) || /URL data:/i.test(msg)) {
            // 添付ファイルを自動削除
            if (attachedFiles.length > 0) {
              attachedFiles.length = 0; // ファイル配列をクリア
              updateAttachedFilesDisplay(); // 表示を更新
            }
            userMsg = "添付ファイルでエラーが発生したため、ファイルを削除しました。\n\n同じメッセージをファイルなしで再送信してください。";
          } else if (/JSONDecodeError/i.test(msg)) {
            userMsg = "AIの内部処理でエラーが発生しました。\n\n特殊文字や絵文字などが含まれている可能性があります。\n入力内容を確認して再度お試しください。";
          } else {
            userMsg = "リクエストのパラメータに問題があります。\n\n添付ファイルがある場合は、ファイルを外してメッセージを送信してください。";
          }
        }
        else if (/PluginInvokeError|PluginDaemonInnerError/i.test(msg)) {
          // 添付ファイルを自動削除
          if (attachedFiles.length > 0) {
            attachedFiles.length = 0; // ファイル配列をクリア
            updateAttachedFilesDisplay(); // 表示を更新
          }
          // 502エラーの場合の処理
          if (/502 Bad Gateway/i.test(msg)) {
            if (attachedFiles.length > 0) {
              userMsg = "サーバーの一時的な問題で添付ファイルが処理できませんでした。\n\nファイルを削除しました。再度ファイルを添付してお試しください。";
            } else {
              userMsg = "サーバーの一時的な問題が発生しています。\n\nしばらく時間をおいてから再度お試しください。";
            }
          } else {
            userMsg = "添付ファイルでAI処理エラーが発生したため、ファイルを削除しました。\n\n同じメッセージをファイルなしで再送信してください。\n\n（非画像ファイルは現在AI処理に対応していません）";
          }
        }
        else if (/google.*error/i.test(msg)) {
          userMsg = "AIモデルの処理でエラーが発生しました。\n\nしばらく時間をおいてから再度お試しください。";
        }
        else if (/invalid character.*looking for beginning of value/i.test(msg)) {
          userMsg = "Difyアプリの設定に問題があります。\n\nDifyアプリのシステムプロンプトが正しく設定されているか確認してください。";
        }
        else if (typeof msg === "string") {
          userMsg = msg;                          // 他のメッセージをそのまま表示
        }
      } catch (_) {/* ignore */}
  
      if (userMsg) {
        addMessage(userMsg, "system");              // システム吹き出しでユーザーに通知
      }
      
      // ファイルエラーまたは特定エラーの場合は入力欄を復元（再送信用）
      if (/PluginInvokeError|PluginDaemonInnerError|invalid_param|URL data:|invalid character/i.test(bodyText)) {
        const inputField = document.getElementById("user-input");
        if (inputField && userInput) {
          inputField.value = userInput; // 元のメッセージを復元
        }
      }
      
      // エラー発生時も入力欄を有効化（重要）
      endLoadingState();
      enableUserInput();
      
      return;                                     // 送信処理を終了
    }

    // Radish AI Engine v2.0 レスポンス処理
    const contentType = resp.headers.get("Content-Type") || "";
    let data;
    
    // JSONレスポンスを取得
    data = await resp.json();
    
    // 会話ID更新
    const oldConversationId = conversationId;
    conversationId = data.conversation_id || conversationId || "";
    
    // 回答テキストを取得
    const botResponse = data.answer || "応答がありません";
    lastBotResponse = botResponse;

    addMessage(botResponse, "bot");
    
    // 症状入力の場合、疾病候補を表示
    if (data.type === "symptom" && data.suggestions && data.suggestions.length > 0) {
      const suggestionsText = "\n\n以下の疾病に該当する可能性があります:\n" + 
        data.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n");
      addMessage(suggestionsText, "system");
    }
    
    // ナレッジソースがあれば表示
    if (data.sources && data.sources.length > 0) {
      // 引用表示機能があれば使用
      if (typeof addCitation === 'function') {
        data.sources.forEach(source => {
          addCitation({
            document_name: source.title || "参照ナレッジ",
            content: source.content || "",
            score: source.score || 0
          });
        });
      }
    }

    // 会話履歴のキャッシュを更新
    if (conversationId) {
      const cacheKey = `history-${conversationId}`;
      if (typeof apiCache !== 'undefined' && apiCache.clear) {
        apiCache.clear(cacheKey);
      }
    }
    
    // 会話一覧のキャッシュもクリア（新しい会話が作成された場合）
    if (oldConversationId !== conversationId) {
      if (typeof apiCache !== 'undefined' && apiCache.clear) {
        apiCache.clear('conversation-list');
      }

      // 新しい会話が作成された場合、会話一覧を再取得
      try {
        if (typeof fetchConversationList === 'function') {
          await fetchConversationList();
        }

        // 新しく作成された会話を選択状態にする
        const conversationListUL = document.getElementById("conversation-list");
        if (conversationListUL) {
          const items = conversationListUL.querySelectorAll("li");
          items.forEach(item => {
            if (item.dataset.convId === conversationId) {
              // 他の選択をクリア
              const selected = conversationListUL.querySelector(".selected");
              if (selected) selected.classList.remove("selected");
              // 新しい会話を選択
              item.classList.add("selected");
            }
          });
        }
      } catch (err) {
        console.error("会話一覧の更新エラー:", err);
      }
    }

  } catch (err) {
    console.error("Error in sendMessage:", err);
    addMessage("エラーが発生しました。もう一度お試しください。", "system");
  } finally {
    endLoadingState();
    enableUserInput(); // 入力欄を有効化してフォーカスを設定
    // 送信成功時のみ添付ファイルをクリア
    if (resp && resp.ok) {
      attachedFiles = [];
      updateAttachedFilesDisplay();
    }
  }
}

/**
 * SSE( Server-Sent Events ) を JSON に変換
 * @param {Response} resp fetch レスポンス
 * @returns {Promise<Object>} 最終行の JSON
 */
async function parseEventStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  // "data: {...}\n\n" 単位で分割 → 最後の JSON を返す
  const events = buffer.split("\n\n").filter(Boolean);
  const last = events.at(-1).replace(/^data:\s*/, "");
  return JSON.parse(last);
}


// ================================
// 4) 送信ボタンのローディング制御
// ================================
function startLoadingState() {
  if (!sendButton) return;
  sendButton.disabled = true;
  sendButton.classList.add("loading");
  sendButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
}

function endLoadingState() {
  if (!sendButton) return;
  sendButton.disabled = false;
  sendButton.classList.remove("loading");
  sendButton.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
}


// ================================
// 5) ファイルアップロード(ナレッジ登録込み)
// ================================
/**
 * @param {File} file - アップロードしたいファイル
 * @returns {Promise<string>} - ファイルID (Dify 側などで発行されると想定)
 */
async function uploadFileAndRegisterToKnowledge(file) {
  try {
    const formData = new FormData();
    formData.append("file", file);
    
    // PDFの場合、OCRでテキスト抽出を試みる（現在は無効化）
    // Dify側でPDF処理を行うため、クライアント側でのOCR処理は不要
    let extractedText = "";
    // if (file.type === "application/pdf") {
    //   extractedText = await extractTextFromPDF(file);
    // }

    const resp = await apiFetch(getConfig('ENDPOINTS.FILE_UPLOAD'), { 
      method: "POST",
      body: formData
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP error! status: ${resp.status}, detail: ${errText}`);
    }

    const data = await resp.json();
    
    // ファイル一覧のキャッシュをクリア
    apiCache.clear('file-list');
    
    // Dify API の応答形式に合わせて、ファイルIDを返す
    return data.id || data;
  } catch (err) {
    console.error("Error uploading & registering knowledge:", err);
    throw err;
  }
}


// ================================
// 6) 引用情報をチャットに追加
// ================================
function addCitation(resource) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;

  const botMsgs = chatMessages.querySelectorAll(".message.bot");
  const lastBotMsg = botMsgs[botMsgs.length - 1];

  const citationDiv = document.createElement("div");
  citationDiv.className = "citation";
  citationDiv.textContent = `引用元: ${resource.document_name || "不明なファイル"}`;
  citationDiv.style.cursor = "pointer";

  citationDiv.addEventListener("click", () => {
    showPopup(resource.content || "引用元の内容が取得できません。");
  });

  if (lastBotMsg) {
    lastBotMsg.insertAdjacentElement("afterend", citationDiv);
  } else {
    chatMessages.appendChild(citationDiv);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ================================
// 7) ポップアップを表示
// ================================
function showPopup(content) {
  const popupContainer = document.getElementById("popup-container");
  const popupText = document.getElementById("popup-text");
  const closeBtn = document.getElementById("close-popup");
  if (!popupContainer || !popupText || !closeBtn) {
    // ポップアップ要素が見つからない場合は静かに処理を終了
    return;
  }

  popupText.textContent = content;
  popupContainer.style.display = "block";

  // クリックで閉じる
  closeBtn.addEventListener("click", () => {
    popupContainer.style.display = "none";
  }, { once: true });
}


// ================================
// 8) 録音開始 (record-button)
// ================================
recordButton.addEventListener("click", async () => {
  // 既に処理中なら何もしない
  if (isProcessingInput) return;

  // 状態に応じて処理を分岐
  switch (recordingState) {
    case 'recording':
      // 録音中なら停止
      stopRecording();
      return;
    case 'starting':
    case 'stopping':
    case 'processing':
      // 処理中は何もしない
      return;
    case 'idle':
      // 録音開始
      await startRecording();
      return;
  }
});

// 録音開始関数
async function startRecording() {
  recordingState = 'starting';
  startRecordLoadingState();

  try {
    addMessage("🎤 音声認識を準備しています...", "system");

    /* ==== ① デバイス取得：ノイズ抑制付き mono 48 kHz ==== */
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
      }
    });

    /* ==== ② MediaRecorder を Opus 固定で作成 ==== */
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus"
    });

    /* ==== ③ dataavailable で認識処理 ==== */
    mediaRecorder.ondataavailable = async (e) => {
      if (!(e.data && e.data.size)) return;
      
      recordingState = 'processing';
      
      // 無音タイマー停止
      if (silenceDetectionTimer) {
        clearTimeout(silenceDetectionTimer);
        silenceDetectionTimer = null;
      }

      // UI更新
      recordButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      recordButton.disabled = true;
      
      // システムメッセージを音声認識中に更新
      updateSystemMessage("🎤 音声を認識しています...");
      
      try {
        await processInput("", e.data);   // 音声→テキスト→送信
      } catch (error) {
        addMessage("音声認識中にエラーが発生しました。もう一度お試しください。", "system");
      } finally {
        // 確実にマイクボタンを復元
        resetRecordButton();
        audioContext?.close();
      }
    };

    /* ==== ④ stop は後片付けのみ ==== */
    mediaRecorder.onstop = () => {
      if (recordingState === 'recording') {
        recordingState = 'stopping';
      }
      
      if (silenceDetectionTimer) {
        clearTimeout(silenceDetectionTimer);
        silenceDetectionTimer = null;
      }
    };

    // 録音開始
    mediaRecorder.start();
    recordingState = 'recording';
    recordingStartTime = Date.now();
    
    recordButton.innerHTML = '<i class="fa-solid fa-stop"></i>';
    recordButton.style.backgroundColor = '#ff4444';
    
    updateSystemMessage("🎤 録音中... 話してください（自動停止または再度クリックで停止）");
    await setupSilenceDetection(stream);

  } catch (err) {
    console.error("Error accessing microphone:", err);
    resetRecordButton();
    
    const errorMsg = err.name === "NotAllowedError" 
      ? "マイクアクセスが拒否されました。ブラウザ設定を確認してください。"
      : err.name === "NotFoundError" 
      ? "マイクが検出されませんでした。デバイスを確認してください。"
      : "マイクアクセス中にエラーが発生しました。";
    
    addMessage(`❌ ${errorMsg}`, "system");
  }
}

// 録音停止関数
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    recordingState = 'stopping';
    mediaRecorder.stop();
    
    const recordingDuration = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
    updateSystemMessage(`🎤 録音停止（${recordingDuration}秒）- 音声を処理中...`);
    
    recordButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    recordButton.style.backgroundColor = '';
    recordButton.disabled = true;
  }
}

// ================================
// 9) 録音ボタンのローディング制御
// マイクボタン状態を確実にリセットする関数
function resetRecordButton() {
  if (recordButton) {
    recordingState = 'idle';
    recordButton.disabled = false;
    recordButton.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    recordButton.style.backgroundColor = '';
  }
}

// ========= ブランド名・固有名詞の音声認識・読み上げ辞書システム =========
// 新しいブランド名や固有名詞を追加する場合は、以下の形式で辞書に追加してください：
//
// 'BRAND_KEY': {
//   displayName: 'チャット表示用の名前',
//   pronunciationForTTS: '音声読み上げ用のカタカナ・ひらがな',
//   speechRecognitionPatterns: [
//     '音声認識で間違えられる可能性のあるパターン1',
//     '音声認識で間違えられる可能性のあるパターン2',
//     ...
//   ]
// }

// 動的辞書（KVから取得）
let BRAND_PRONUNCIATION_DICTIONARY = {
  // デフォルト辞書（フォールバック用）
  'SIRUSIRU': {
    displayName: 'SIRUSIRU',
    pronunciationForTTS: 'シルシル',
    speechRecognitionPatterns: [
      'シルシル', 'シル知る', '知る知る',
      'シェルシェル', 'シェルシル', 'シルシェル', 'しぇるしぇる',
      'シュルシュル', 'シルシュル', 'シュルシル', 'しゅるしゅる',
      '知るしる'
    ]
  },
  'SIRUMUTE': {
    displayName: 'SIRUMUTE',
    pronunciationForTTS: 'シルミュート',
    speechRecognitionPatterns: [
      'シルミュート', '知るミュート', 'シルムート', 'シルミュー[トド]'
    ]
  },
  'SIRANAI': {
    displayName: 'SIRANAI',
    pronunciationForTTS: 'しらない',
    speechRecognitionPatterns: [
      'しらない', 'シラナイ', '知らない'
    ]
  },
  'NOCE_CREATIVE': {
    displayName: 'Noce Creative',
    pronunciationForTTS: 'ノーチェ クリエイティブ',
    speechRecognitionPatterns: [
      'ノーチェクリエイティブ', 'ノーチェ クリエイティブ', 'ノーチ クリエイティブ'
    ]
  }
};

// 辞書をKVから取得する関数（dictionary-sync.js を使用）
async function loadDictionaryFromKV() {
  try {
    if (!window.dictionarySync) {
      console.warn('[Dictionary] DictionarySync not available, using default dictionary');
      return BRAND_PRONUNCIATION_DICTIONARY;
    }

    const dictionary = await window.dictionarySync.getDictionary();
    
    if (dictionary && Object.keys(dictionary).length > 0) {
      // KVから取得した辞書で更新
      BRAND_PRONUNCIATION_DICTIONARY = { ...dictionary };
      return BRAND_PRONUNCIATION_DICTIONARY;
    } else {
      throw new Error('Empty dictionary received');
    }
  } catch (error) {
    console.warn('[Dictionary] Failed to load from KV, using default:', error.message);
    return BRAND_PRONUNCIATION_DICTIONARY;
  }
}

// 辞書の自動更新監視（dictionary-sync.js のコールバック使用）
function startDictionarySync() {
  if (!window.dictionarySync) {
    console.warn('[Dictionary] DictionarySync not available, skipping sync setup');
    return;
  }

  // dictionary-sync.js の監視機能を利用
  window.dictionarySync.startWatching(async (updatedDictionary) => {
    if (updatedDictionary && Object.keys(updatedDictionary).length > 0) {
      BRAND_PRONUNCIATION_DICTIONARY = { ...updatedDictionary };
    }
  });
}

// チャット入力テキストの正規化関数（辞書ベース）
function normalizeTextForChat(text) {
  let normalizedText = text;
  
  // 辞書を使用してパターンマッチング
  for (const [brandKey, brandData] of Object.entries(BRAND_PRONUNCIATION_DICTIONARY)) {
    for (const pattern of brandData.speechRecognitionPatterns) {
      // 正規表現を使用してより柔軟にマッチング
      const regex = new RegExp(pattern.replace(/\[([^\]]+)\]/g, '($1)'), 'g');
      normalizedText = normalizedText.replace(regex, brandData.displayName);
    }
  }
  
  return normalizedText;
}

// 音声読み上げ用テキストの変換関数（辞書ベース）
function convertTextForTTS(text) {
  let ttsText = text;
  
  // 辞書を使用してブランド名を音声読み上げ用に変換
  for (const [brandKey, brandData] of Object.entries(BRAND_PRONUNCIATION_DICTIONARY)) {
    const regex = new RegExp(brandData.displayName, 'g');
    ttsText = ttsText.replace(regex, brandData.pronunciationForTTS);
  }
  
  return ttsText;
}

// ================================
// 無音検出のセットアップ関数 - 追加
async function setupSilenceDetection(stream) {
  try {
    // AudioContext の作成
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;              // 256 で問題なければそのまま

    // マイク入力を Analyser に接続
    source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    // 追加: AudioContext が suspend されていたら再開
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    // ★ 追加: キャリブレーション用の初期化
    autoCalibrated     = false;
    calibrationStartTs = 0;

    lastNonSilenceTime = Date.now();     // タイマー初期化    
    detectSilence();                    // 無音検出ループ開始
  } catch (err) {
    console.error("無音検出のセットアップに失敗:", err);
  }
}

// ================================
// 無音検出ループ（detectSilence）
// ================================
function detectSilence() {
  // 録音が終わっていれば何もしない
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  /* === 1. 時間波形を取得して RMS を算出 === */
  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(dataArray);

  let sumSq = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128; // -1 ～ 1 に正規化
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / dataArray.length) * 100; // 0～100 目安

  /* === 2. 自動キャリブレーション（開始 1.5 秒間）=== */
  if (!autoCalibrated) {
    if (!calibrationStartTs) calibrationStartTs = Date.now();

    // 1.5 秒間 RMS の最大値を収集
    if (Date.now() - calibrationStartTs < 1500) {
      silenceThreshold = Math.max(silenceThreshold, rms);
    } else {
      // 1.5 秒経過したら 1.5 倍マージンを取って確定
      silenceThreshold = Math.max(3, silenceThreshold * 1.5);
      autoCalibrated = true;
    }
  }

  const currentTime = Date.now();
  const recordingElapsed = currentTime - recordingStartTime;

  /* === 3. 無音判定（最低録音時間を過ぎてから） === */
  if (recordingElapsed > minRecordingDuration) {
    if (rms > silenceThreshold) {
      lastNonSilenceTime = currentTime;           // 音あり → タイマーリセット
      
      // 録音中のフィードバック更新（1秒ごと）
      if (Math.floor(recordingElapsed / 1000) !== Math.floor((recordingElapsed - 100) / 1000)) {
        const secondsElapsed = Math.floor(recordingElapsed / 1000);
        updateSystemMessage(`🎤 録音中... ${secondsElapsed}秒経過（話してください）`);
      }
    } else if (currentTime - lastNonSilenceTime > silenceDuration) {
      updateSystemMessage(`🎤 無音を検出しました - 録音を自動停止`);
      stopRecording();
      return;
    }
  }

  /* === 4. 次フレームへ === */
  silenceDetectionTimer = setTimeout(detectSilence, 100); // 100ms間隔で処理を軽く
}

// 録音ボタンのローディング制御
function startRecordLoadingState() {
  if (!recordButton) return;
  recordButton.disabled = false; // 録音中も押せるようにする（停止のため）
  recordButton.classList.add("recording");
}

function endRecordLoadingState() {
  if (!recordButton) return;
  recordButton.disabled = false;
  recordButton.classList.remove("recording");
  recordButton.classList.remove("loading");
  // 元のマイクアイコンに戻す
  recordButton.innerHTML = '<i class="fa-solid fa-microphone"></i>';
}


// ================================
// 10) 録音停止ボタン (stop-button)
// ================================
const stopBtn = document.getElementById("stop-button");
if (stopBtn) {
  stopBtn.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      // addMessage("録音停止しました。", "system");
    } else {
      // addMessage("録音中ではありません。", "system");
    }
  });
}


// ================================
// 11) 音声読み上げ開始
// ================================
document.getElementById("text-to-audio-button").addEventListener("click", async () => {
  if (!lastBotResponse) {
    addMessage("読み上げる返答がありません。", "system");
    return;
  }
  try {
    await playBotResponse(lastBotResponse);
  } catch (err) {
    console.error("Error in text-to-audio:", err);
    addMessage("読み上げ中にエラーが発生しました。", "system");
  }
});


// ================================
// 12) 音声ファイルを送信しテキスト変換
// ================================
async function uploadAudio(file) {
  try {
    const userEmail = localStorage.getItem("userEmail") || "anonymous";
    const resp = await apiFetch(getConfig('ENDPOINTS.AUDIO_TO_TEXT'), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioContent: await fileToBase64ForAudio(file),
        user: userEmail
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Audio-to-Text API Error:", errText);
      throw new Error(`HTTP error: ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.text) {
      throw new Error("音声認識結果が空です。");
    }
    return data.text;
  } catch (err) {
    console.error("Error in uploadAudio:", err);
    throw err;
  }
}


// ================================
// 13) ファイルをBase64に変換（音声認識用：Base64部分のみ）
// ================================
function fileToBase64ForAudio(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      // data:audio/webm;codecs=opus;base64, の部分を除去してBase64部分のみ取得
      const base64Part = result.split(',')[1];
      resolve(base64Part);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


// ================================
// 14) チャットボット返答を音声再生
// ================================
async function playBotResponse(text) {
  try {
    /* === ① すでに再生中の音声があれば止める ================= */
    if (currentAudio) {
      currentAudio.pause();            // 停止
      currentAudio.currentTime = 0;    // 冒頭に戻す
      URL.revokeObjectURL(currentAudio.src); // Blob URL開放
      currentAudio = null;
    }

    /* === ② 音声読み上げ用にテキストを前処理 ================= */
    // 辞書ベースでブランド名を音声読み上げ用に変換（表示は変えずに音声読み上げのみ変更）
    const speechText = convertTextForTTS(text);
    
    /* === ③ 新しい音声を生成して再生 ========================= */
    const userEmail = localStorage.getItem("userEmail") || "anonymous";
    const resp = await apiFetch(
      getConfig('ENDPOINTS.TEXT_TO_AUDIO'),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speechText, user: userEmail })
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Text-to-Audio API Error:", errText);
      throw new Error(`HTTP error: ${resp.status}`);
    }

    const result = await resp.json();
    if (!result.success || !result.data?.audioContent) {
      throw new Error("音声データが取得できませんでした");
    }
    
    // Base64デコードしてBlobを作成
    const audioContent = result.data.audioContent;
    const audioBuffer = Uint8Array.from(atob(audioContent), c => c.charCodeAt(0));
    const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
    const audioUrl = URL.createObjectURL(blob);

    /* Audio インスタンスを作成して再生 */
    const audio = new Audio(audioUrl);
    currentAudio = audio;          // ← 状態を保持
    audio.play();

    /* 再生終了時に後片付け */
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(audioUrl);
      if (currentAudio === audio) {
        currentAudio = null;
      }
    });
  } catch (err) {
    console.error("Error playing bot response:", err);
    addMessage("返答内容の再生中にエラーが発生しました。", "system");
  }
}

// ================================
// 15) チャットメッセージ表示 (Markdown)
// ================================
function addMessage(text, sender) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;

  /* ── 重複ガード ───────────────────────
     直前の .message 要素が
       1) 同じ送信者クラスを持ち
       2) textContent が完全一致
     なら新たなノードを追加しない
  ----------------------------------- */
  const lastNode = chatMessages.lastElementChild;
  if (
    lastNode &&
    lastNode.classList.contains("message") &&
    lastNode.classList.contains(sender) &&
    lastNode.textContent === text
  ) {
    return;
  }

  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${sender}`;

  // bot ⇒ Markdown で整形
  if (sender === "bot") {
    const html = marked.parse(text);
    msgDiv.innerHTML = html;

    const audioBtn = document.createElement("button");
    audioBtn.className = "text-to-audio-btn";
    audioBtn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
    audioBtn.title = "音声で再生";
    audioBtn.addEventListener("click", () => playBotResponse(text));
    msgDiv.appendChild(audioBtn);
  } else {
    msgDiv.textContent = text;
  }

  chatMessages.appendChild(msgDiv);

  // スクロール位置調整
  if (sender === "bot") {
    msgDiv.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  } else {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  cleanupChatMessages(); // 古いメッセージを削除
}


// ================================
// 16) チャットメッセージ削除 (メモリ対策)
// ================================
function cleanupChatMessages() {
  const chatMessages = document.getElementById("chat-messages");
  const maxMessages = 100;
  while (chatMessages.childNodes.length > maxMessages) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
}

// システムメッセージを更新する関数
function updateSystemMessage(newText) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;
  
  // 最後のシステムメッセージを探す
  const systemMessages = chatMessages.querySelectorAll(".message.system");
  const lastSystemMessage = systemMessages[systemMessages.length - 1];
  
  if (lastSystemMessage) {
    lastSystemMessage.textContent = newText;
  } else {
    // システムメッセージがなければ新規作成
    addMessage(newText, "system");
  }
}

// ================================
// ファイル重複チェック関数
// ================================
async function checkFileDuplication(file) {
  try {
    let fileList = null;
    const cacheKey = 'file-list';
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData) {
      fileList = cachedData;
    } else {
      // 権限フィルタリング適用済みファイル一覧APIを使用
      const response = await apiFetch(getConfig('ENDPOINTS.FILE_LIST'), { method: "GET" });
      if (response.ok) {
        fileList = await response.json();
        apiCache.set(cacheKey, fileList, 5 * 60 * 1000); // 5分間キャッシュ
      }
    }
    
    // 新しいDjango API形式に対応
    const filesArray = fileList?.files || fileList?.data || [];
    if (!Array.isArray(filesArray)) {
      return { duplicateExists: false, similarFiles: [] };
    }
    
    let duplicateExists = false;
    let similarFiles = [];
    
    // ファイル名から拡張子を除いた部分を取得する関数
    const getFileNameWithoutExtension = (filename) => {
      const lastDotIndex = filename.lastIndexOf('.');
      return lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
    };
    
    filesArray.forEach(doc => {
      if (doc.name) {
        const docNameBase = getFileNameWithoutExtension(doc.name).toLowerCase();
        const fileNameBase = getFileNameWithoutExtension(file.name).toLowerCase();
        
        if (doc.name === file.name) {
          duplicateExists = true;
        } else if (
          docNameBase.includes(fileNameBase) || 
          fileNameBase.includes(docNameBase) ||
          (docNameBase.length > 3 && fileNameBase.length > 3 && 
           docNameBase.substring(0, 3) === fileNameBase.substring(0, 3))
        ) {
          similarFiles.push(doc.name);
        }
      }
    });
    
    return { duplicateExists, similarFiles };
    
  } catch (err) {
    console.error("ファイル重複チェック中にエラー:", err);
    return { duplicateExists: false, similarFiles: [] };
  }
}

// ================================
// ドラッグ&ドロップ機能
// ================================

// ドロップゾーンオーバーレイを作成
function createDropZoneOverlay() {
  if (dropZoneOverlay) return dropZoneOverlay;
  
  dropZoneOverlay = document.createElement('div');
  dropZoneOverlay.id = 'drop-zone-overlay';
  dropZoneOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 123, 255, 0.1);
    border: 3px dashed #007bff;
    z-index: 10000;
    display: none;
    justify-content: center;
    align-items: center;
    backdrop-filter: blur(2px);
    font-size: 24px;
    color: #007bff;
    font-weight: bold;
    text-align: center;
    pointer-events: none;
  `;
  
  dropZoneOverlay.innerHTML = `
    <div style="background: rgba(255,255,255,0.9); padding: 40px; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2);">
      <i class="fa-solid fa-cloud-arrow-up" style="font-size: 48px; margin-bottom: 20px; display: block;"></i>
      ファイルをここにドロップしてアップロード<br>
      <small style="font-size: 16px; color: #666;">対応形式: PDF, TXT, DOCX, XLSX, PNG, JPG など</small>
    </div>
  `;
  
  document.body.appendChild(dropZoneOverlay);
  return dropZoneOverlay;
}

// ドロップゾーンを表示
function showDropZone() {
  const overlay = createDropZoneOverlay();
  overlay.style.display = 'flex';
}

// ドロップゾーンを非表示
function hideDropZone() {
  if (dropZoneOverlay) {
    dropZoneOverlay.style.display = 'none';
  }
}

// ファイルサイズとタイプのチェック
function validateDroppedFile(file) {
  const maxSizeInBytes = 15 * 1024 * 1024; // 15MB
  const allowedTypes = [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp'
  ];
  
  // ファイルサイズチェック
  if (file.size > maxSizeInBytes) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `ファイルサイズが大きすぎます。\n現在のサイズ: ${fileSizeMB}MB\n最大サイズ: 15MB`
    };
  }
  
  // ファイルタイプチェック - より柔軟な判定
  const fileExtension = file.name.split('.').pop().toLowerCase();
  const allowedExtensions = ['pdf', 'txt', 'docx', 'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
  
  if (!allowedTypes.includes(file.type) && !allowedExtensions.includes(fileExtension)) {
    return {
      valid: false,
      error: `サポートされていないファイル形式です。\n対応形式: PDF, TXT, DOCX, XLSX, PNG, JPG など\nファイルタイプ: ${file.type || '不明'}`
    };
  }
  
  return { valid: true };
}

// ドロップされたファイルを処理
async function handleDroppedFile(file) {
  try {
    // ログイン状態チェック
    const accessToken = localStorage.getItem("accessToken");
    if (!accessToken) {
      addMessage("❌ ファイルアップロードにはログインが必要です", "system");
      showLoginModal();
      return;
    }
    
    // ファイルの検証
    const validation = validateDroppedFile(file);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }
    
    // ファイル情報を表示
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    addMessage(`📎 ファイルをドロップしました: ${file.name} (${fileSizeMB}MB)`, "system");
    
    // 重複チェック
    addMessage("📋 既存ファイルをチェック中...", "system");
    const { duplicateExists, similarFiles } = await checkFileDuplication(file);
    
    if (duplicateExists) {
      if (!confirm(`同じ名前のファイル「${file.name}」が既に存在します。\n上書きしますか？`)) {
        addMessage("❌ アップロードをキャンセルしました", "system");
        return;
      }
    }
    
    if (similarFiles.length > 0) {
      const similarList = similarFiles.slice(0, 5).join("\n• ");
      const message = `似た名前のファイルが見つかりました:\n• ${similarList}${similarFiles.length > 5 ? `\n他${similarFiles.length - 5}件` : ''}\n\n内容がバッティングしていないかご確認ください。続行しますか？`;
      
      if (!confirm(message)) {
        addMessage("❌ アップロードをキャンセルしました", "system");
        return;
      }
    }
    
    // アップロード処理
    addMessage("📤 ファイルをアップロード中...", "system");
    const result = await uploadFileAndRegisterToKnowledge(file);
    
    addMessage("✅ ファイルアップロード完了", "system");
    
    // ファイル一覧のキャッシュをクリア
    apiCache.clear('file-list');
    // クォータキャッシュもクリア
    if (window.quotaManager) {
      window.quotaManager.quotaCache = null;
    }
    
  } catch (error) {
    console.error("Dropped file upload error:", error);
    addMessage("❌ ファイルアップロード中にエラーが発生しました", "system");
    
    // エラーの種類に応じて分かりやすいメッセージを表示
    let errorMessage = "ファイルアップロード中にエラーが発生しました。";
    
    // Cloudflareブロックエラーのチェック
    if (error.message.includes("Cloudflare") || error.message.includes("blocked")) {
      errorMessage = "セキュリティチェックによりアップロードがブロックされました。\n時間をおいて再度お試しください。";
    } else if (error.message.includes("413") || error.message.includes("file_too_large")) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
      errorMessage = `ファイルサイズが大きすぎます。\n現在のサイズ: ${fileSizeMB}MB\n最大サイズ: 15MB`;
    } else if (error.message.includes("415") || error.message.includes("unsupported_file_type")) {
      errorMessage = `サポートされていないファイル形式です。\n対応形式: PDF, TXT, DOCX, XLSX, PNG, JPG など`;
    } else if (error.message.includes("403")) {
      errorMessage = `アップロード権限がありません。\n再度ログインしてお試しください。`;
    }
    
    alert(errorMessage);
  }
}

// ドラッグ&ドロップのセットアップ
function setupDragAndDrop() {
  // ページ全体でのドラッグイベントを監視
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    
    // ファイルがドラッグされている場合のみ処理
    if (e.dataTransfer.types.includes('Files')) {
      showDropZone();
    }
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    
    // カウンターが0になったらオーバーレイを非表示
    if (dragCounter === 0) {
      hideDropZone();
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    
    // ファイルがドラッグされている場合のみドロップを許可
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    hideDropZone();
    
    // ファイルが含まれているかチェック
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    // 複数ファイルの場合は最初のファイルのみ処理
    if (files.length > 1) {
      addMessage("⚠️ 複数ファイルが検出されました。最初のファイルのみ処理します。", "system");
    }
    
    const file = files[0];
    await handleDroppedFile(file);
  });

  // ページを離れる際の誤ドロップを防ぐ
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

}

// ================================
// アップロードモーダル用のドラッグ&ドロップ
// ================================
let modalDragCounter = 0;
let modalDropHandlers = {
  dragenter: null,
  dragleave: null,
  dragover: null,
  drop: null
};

function setupModalDragAndDrop() {
  const uploadModal = document.getElementById("upload-modal");
  const modalContent = uploadModal.querySelector(".modal-content");
  
  if (!modalContent) return;
  
  // モーダルコンテンツのスタイルを調整
  modalContent.style.position = "relative";
  
  // ドラッグオーバー時のスタイル
  const addDragOverStyle = () => {
    modalContent.style.backgroundColor = "#e3f2fd";
    modalContent.style.border = "2px dashed #2196F3";
    modalContent.style.transition = "all 0.3s ease";
  };
  
  const removeDragOverStyle = () => {
    modalContent.style.backgroundColor = "";
    modalContent.style.border = "";
  };
  
  // イベントハンドラを定義
  modalDropHandlers.dragenter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalDragCounter++;
    
    if (e.dataTransfer.types.includes('Files')) {
      addDragOverStyle();
    }
  };
  
  modalDropHandlers.dragleave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalDragCounter--;
    
    if (modalDragCounter === 0) {
      removeDragOverStyle();
    }
  };
  
  modalDropHandlers.dragover = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  
  modalDropHandlers.drop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalDragCounter = 0;
    removeDragOverStyle();
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    // 複数ファイルの場合は最初のファイルのみ処理
    if (files.length > 1) {
      alert("複数ファイルが検出されました。最初のファイルのみ選択されます。");
    }
    
    const file = files[0];
    const fileInput = document.getElementById("file-input");
    const fileNameSpan = document.getElementById("file-name");
    
    if (fileInput && fileNameSpan) {
      // ファイルをinputに設定
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      
      // ファイル名を表示
      fileNameSpan.textContent = file.name;
      
      // changeイベントを手動で発火
      const event = new Event('change', { bubbles: true });
      fileInput.dispatchEvent(event);
    }
  };
  
  // イベントリスナーを追加
  modalContent.addEventListener('dragenter', modalDropHandlers.dragenter);
  modalContent.addEventListener('dragleave', modalDropHandlers.dragleave);
  modalContent.addEventListener('dragover', modalDropHandlers.dragover);
  modalContent.addEventListener('drop', modalDropHandlers.drop);
  
}

function removeModalDragAndDrop() {
  const uploadModal = document.getElementById("upload-modal");
  const modalContent = uploadModal.querySelector(".modal-content");
  
  if (!modalContent) return;
  
  // イベントリスナーを削除
  if (modalDropHandlers.dragenter) {
    modalContent.removeEventListener('dragenter', modalDropHandlers.dragenter);
  }
  if (modalDropHandlers.dragleave) {
    modalContent.removeEventListener('dragleave', modalDropHandlers.dragleave);
  }
  if (modalDropHandlers.dragover) {
    modalContent.removeEventListener('dragover', modalDropHandlers.dragover);
  }
  if (modalDropHandlers.drop) {
    modalContent.removeEventListener('drop', modalDropHandlers.drop);
  }
  
  // スタイルをリセット
  modalContent.style.backgroundColor = "";
  modalContent.style.border = "";
  modalDragCounter = 0;
  
}

// ================================
// チャット画面用のドラッグ&ドロップ（ファイル添付）
// ================================
function setupChatDragAndDrop() {
  const chatContainer = document.querySelector('main');
  
  if (!chatContainer) return;
  
  // ドラッグエンター
  chatContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatDragCounter++;
    
    if (e.dataTransfer.types.includes('Files')) {
      showChatDropZone();
    }
  });
  
  // ドラッグリーブ
  chatContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatDragCounter--;
    
    if (chatDragCounter === 0) {
      hideChatDropZone();
    }
  });
  
  // ドラッグオーバー
  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  
  // ドロップ
  chatContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatDragCounter = 0;
    hideChatDropZone();
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    
    // 複数ファイルの場合は最初のファイルのみ処理
    if (files.length > 1) {
      addMessage("⚠️ 複数ファイルが検出されました。最初のファイルのみ添付されます。", "system");
    }
    
    // 既に添付されているファイルがある場合は制限
    if (attachedFiles.length > 0) {
      addMessage("⚠️ 既に添付ファイルがあります。現在のファイルを削除してから新しいファイルを添付してください。", "system");
      return;
    }
    
    const file = files[0];
    await handleChatFileAttachment(file);
  });
  
}

// チャット用ドロップゾーンの表示/非表示
function showChatDropZone() {
  if (!dropZoneOverlay) {
    dropZoneOverlay = createChatDropZoneOverlay();
  }
  dropZoneOverlay.style.display = 'flex';
}

function hideChatDropZone() {
  if (dropZoneOverlay) {
    dropZoneOverlay.style.display = 'none';
  }
}

function createChatDropZoneOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'chat-drop-zone-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(76, 175, 80, 0.1);
    border: 3px dashed #4CAF50;
    z-index: 10000;
    display: none;
    justify-content: center;
    align-items: center;
    backdrop-filter: blur(2px);
    font-size: 24px;
    color: #4CAF50;
    font-weight: bold;
    text-align: center;
    pointer-events: none;
  `;
  
  overlay.innerHTML = `
    <div style="background: rgba(255,255,255,0.95); padding: 40px; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.2);">
      <i class="fa-solid fa-paperclip" style="font-size: 48px; margin-bottom: 20px; display: block;"></i>
      ファイルをここにドロップして添付<br>
      <small style="font-size: 16px; color: #666;">対応形式: PDF, DOCX, 画像, 音声, 動画など</small>
    </div>
  `;
  
  document.body.appendChild(overlay);
  return overlay;
}

// ================================
// ファイル添付処理
// ================================

// ファイル添付のメイン処理
async function handleChatFileAttachment(file) {
  try {
    // ファイルバリデーション
    const validation = validateChatFile(file);
    if (!validation.valid) {
      addMessage(`❌ ${validation.error}`, "system");
      return;
    }
    
    // 添付ファイル配列に追加（アップロード前）
    const fileItem = {
      id: Date.now() + Math.random(),
      file: file,
      name: file.name,
      size: file.size,
      type: getFileType(file),
      status: 'uploading',
      uploadFileId: null
    };
    
    attachedFiles.push(fileItem);
    updateAttachedFilesDisplay();
    
    // ファイルをDify APIにアップロード
    try {
      const uploadResult = await uploadFileToDify(file);
      fileItem.uploadFileId = uploadResult.id;
      fileItem.uploadResult = uploadResult;
      fileItem.status = 'uploaded';
      updateAttachedFilesDisplay();
      
      if (uploadResult.is_temp) {
        // ファイルアップロード完了メッセージ
        if (uploadResult.file_type === 'image') {
          addMessage(`✅ 画像ファイル「${file.name}」を添付しました`, "system");
        } else {
          addMessage(`✅ ファイル「${file.name}」を添付しました`, "system");
        }
      } else {
        // 正常にDify APIにアップロードされたファイル
        const fileTypeText = uploadResult.file_type === 'image' ? '画像' : 
                           uploadResult.file_type === 'document' ? 'ドキュメント' :
                           uploadResult.file_type === 'audio' ? '音声' :
                           uploadResult.file_type === 'video' ? '動画' : 'ファイル';
        addMessage(`✅ ${fileTypeText}「${file.name}」を添付しました`, "system");
      }
    } catch (uploadError) {
      console.error("ファイルアップロードエラー:", uploadError);
      fileItem.status = 'error';
      updateAttachedFilesDisplay();
      
      // エラーメッセージを分かりやすく表示
      let errorMessage = uploadError.message;
      if (errorMessage.includes("ファイルのアップロードができませんでした")) {
        addMessage(`❌ ファイル「${file.name}」のアップロードができませんでした。\n\nしばらく時間をおいてからお試しください。`, "system");
      } else if (errorMessage.includes("サイズが大きすぎます")) {
        addMessage(`❌ ${errorMessage}`, "system");
      } else {
        addMessage(`❌ ファイル「${file.name}」のアップロードでエラーが発生しました。\n\nファイルサイズやファイル形式をご確認ください。`, "system");
      }
    }
    
  } catch (error) {
    console.error("ファイル添付処理エラー:", error);
    addMessage("❌ ファイルの添付中にエラーが発生しました。しばらく時間をおいてからお試しください。", "system");
  }
}

// ファイルバリデーション
// ファイル検証関数（全ファイルタイプ対応）
function validateChatFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  const fileType = getFileTypeForDify(file);
  
  // ファイルタイプ別のサイズ制限と対応形式チェック
  let maxSize;
  let supportedExtensions;
  
  switch (fileType) {
    case 'image':
      maxSize = 5 * 1024 * 1024; // 5MB（Base64エンコード時のサイズ制限を考慮）
      supportedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
      break;
    case 'document':
      maxSize = 10 * 1024 * 1024; // 10MB（AI処理の安定性を考慮）
      supportedExtensions = ['txt', 'md', 'mdx', 'markdown', 'pdf', 'html', 'xlsx', 'xls', 'doc', 'docx', 'csv', 'eml', 'msg', 'pptx', 'ppt', 'xml', 'epub'];
      break;
    case 'audio':
      maxSize = 25 * 1024 * 1024; // 25MB（AI処理の安定性を考慮）
      supportedExtensions = ['mp3', 'm4a', 'wav', 'amr', 'mpga'];
      break;
    case 'video':
      maxSize = 50 * 1024 * 1024; // 50MB（AI処理の安定性を考慮）
      supportedExtensions = ['mp4', 'mov', 'mpeg', 'webm'];
      break;
    default:
      return {
        valid: false,
        error: `ファイル「${file.name}」の種類は対応していません。画像、ドキュメント、音声、動画ファイルのみご利用いただけます。`
      };
  }
  
  // ファイルサイズチェック
  if (file.size > maxSize) {
    const currentSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    const maxSizeMB = (maxSize / (1024 * 1024));
    return {
      valid: false,
      error: `ファイル「${file.name}」のサイズが大きすぎます。\n\n現在のサイズ: ${currentSizeMB}MB\n最大サイズ: ${maxSizeMB}MB`
    };
  }
  
  // ファイル形式チェック
  if (!supportedExtensions.includes(extension)) {
    return {
      valid: false,
      error: `ファイル「${file.name}」の形式は対応していません。\n\n対応している形式: ${supportedExtensions.join(', ')}`
    };
  }
  
  // MIMEタイプチェック（画像のみ）
  if (fileType === 'image' && !file.type.startsWith('image/')) {
    return {
      valid: false,
      error: `選択されたファイルは画像ファイルではありません。JPG、PNG、GIF、WEBP、SVGファイルをお選びください。`
    };
  }
  
  // 非画像ファイルはWorkersプロキシ経由でアップロードするため、APIキーチェックは不要
  
  return { valid: true };
}

// ファイルタイプ判定
function getFileType(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  
  const documentExts = ['txt', 'md', 'markdown', 'pdf', 'html', 'xlsx', 'xls', 'docx', 'csv', 'eml', 'msg', 'pptx', 'ppt', 'xml', 'epub'];
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const audioExts = ['mp3', 'm4a', 'wav', 'webm', 'amr'];
  const videoExts = ['mp4', 'mov', 'mpeg', 'mpga'];
  
  if (documentExts.includes(extension)) return 'document';
  if (imageExts.includes(extension)) return 'image';
  if (audioExts.includes(extension)) return 'audio';
  if (videoExts.includes(extension)) return 'video';
  
  return 'custom';
}

// Dify API用のファイルタイプを判定する関数（より厳密）
function getFileTypeForDify(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  const mimeType = file.type;
  
  // 画像ファイル - MIMEタイプも確認
  if (mimeType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)) {
    return 'image';
  }
  
  // 音声ファイル - MIMEタイプも確認
  if (mimeType.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'webm', 'amr'].includes(extension)) {
    return 'audio';
  }
  
  // 動画ファイル - MIMEタイプも確認
  if (mimeType.startsWith('video/') || ['mp4', 'mov', 'mpeg', 'mpga'].includes(extension)) {
    return 'video';
  }
  
  // ドキュメントファイル - Dify対応形式に限定
  const documentExtensions = ['txt', 'md', 'markdown', 'pdf', 'html', 'xlsx', 'xls', 'docx', 'csv', 'eml', 'msg', 'pptx', 'ppt', 'xml', 'epub'];
  if (documentExtensions.includes(extension)) {
    return 'document';
  }
  
  // その他
  return 'custom';
}

// ファイルアイコン取得
function getFileIcon(type, extension) {
  switch (type) {
    case 'document':
      if (['pdf'].includes(extension)) return 'fa-file-pdf';
      if (['doc', 'docx'].includes(extension)) return 'fa-file-word';
      if (['xls', 'xlsx'].includes(extension)) return 'fa-file-excel';
      if (['ppt', 'pptx'].includes(extension)) return 'fa-file-powerpoint';
      return 'fa-file-text';
    case 'image':
      return 'fa-file-image';
    case 'audio':
      return 'fa-file-audio';
    case 'video':
      return 'fa-file-video';
    default:
      return 'fa-file';
  }
}

// 添付ファイル表示の更新
function updateAttachedFilesDisplay() {
  const area = document.getElementById('attached-files-area');
  const list = document.getElementById('attached-files-list');
  
  if (attachedFiles.length === 0) {
    area.style.display = 'none';
    return;
  }
  
  area.style.display = 'block';
  list.innerHTML = '';
  
  attachedFiles.forEach(fileItem => {
    const item = document.createElement('div');
    item.className = 'attached-file-item';
    
    const extension = fileItem.name.split('.').pop().toLowerCase();
    const icon = getFileIcon(fileItem.type, extension);
    const sizeText = (fileItem.size / 1024).toFixed(1) + ' KB';
    
    let statusHtml = '';
    if (fileItem.status === 'uploading') {
      statusHtml = '<span class="attached-file-status uploading">アップロード中...</span>';
    } else if (fileItem.status === 'uploaded') {
      statusHtml = '<span class="attached-file-status uploaded">準備完了</span>';
    } else if (fileItem.status === 'error') {
      statusHtml = '<span class="attached-file-status error">エラー</span>';
    }
    
    item.innerHTML = `
      <div class="attached-file-icon">
        <i class="fa-solid ${icon}"></i>
      </div>
      <div class="attached-file-info">
        <div class="attached-file-name">${fileItem.name}</div>
        <div class="attached-file-details">${sizeText} • ${fileItem.type} ${statusHtml}</div>
      </div>
      <button class="attached-file-remove" onclick="removeAttachedFile('${fileItem.id}')">
        <i class="fa-solid fa-times"></i>
      </button>
    `;
    
    list.appendChild(item);
  });
}

// 添付ファイルの削除
function removeAttachedFile(fileId) {
  const beforeCount = attachedFiles.length;
  attachedFiles = attachedFiles.filter(file => file.id != fileId);
  const afterCount = attachedFiles.length;
  
  updateAttachedFilesDisplay();
}

// ファイルをBase64に変換
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      // data:URLをそのまま返す（例: data:image/png;base64,iVBORw0KGgo...）
      resolve(reader.result);
    };
    reader.onerror = error => reject(error);
  });
}


// Dify APIへのファイルアップロード（直接APIアクセス版）
async function uploadFileToDify(file) {
  const userEmail = localStorage.getItem("userEmail") || "anonymous";
  const fileType = getFileTypeForDify(file);
  
  
  // 非画像ファイルはDifyの/files/uploadエンドポイントでアップロード
  if (fileType !== 'image') {
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('user', userEmail);
        
        // リトライ時は少し待機
        if (retryCount > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
        
        // Difyの正式なファイルアップロードエンドポイントを使用
        const response = await apiFetch(getConfig('ENDPOINTS.FILE_UPLOAD'), {
          method: "POST",
          body: formData
        });
        
        if (response.ok) {
          const uploadData = await response.json();
          
          return {
            id: uploadData.id,
            name: uploadData.name,
            size: uploadData.size,
            extension: uploadData.extension,
            mime_type: uploadData.mime_type,
            created_by: uploadData.created_by,
            created_at: uploadData.created_at,
            is_temp: false,
            file_type: fileType,
            is_image: false,
            upload_data: uploadData
          };
        } else {
          const errorText = await response.text();
          
          if (retryCount < maxRetries) {
            retryCount++;
            continue; // リトライ
          }
          
          throw new Error(`ファイルアップロード失敗: ${response.status}`);
        }
        
      } catch (error) {
        if (retryCount < maxRetries) {
          retryCount++;
          continue; // リトライ
        }
        
        console.error("ファイルアップロードエラー:", error);
        throw new Error(`ファイルのアップロードができませんでした。しばらく時間をおいてからお試しください。`);
      }
    }
  }
  
  // 画像ファイルはDifyの/files/uploadエンドポイントでアップロード
  try {
    const extension = file.name.split('.').pop().toLowerCase();
    
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('user', userEmail);
    
    const response = await apiFetch(getConfig('ENDPOINTS.FILE_UPLOAD'), {
      method: "POST",
      body: formData
    });
    
    if (response.ok) {
      const uploadData = await response.json();
      
      return {
        id: uploadData.id,
        name: uploadData.name,
        size: uploadData.size,
        extension: uploadData.extension,
        mime_type: uploadData.mime_type,
        created_by: uploadData.created_by,
        created_at: uploadData.created_at,
        is_temp: false,
        file_type: fileType,
        is_image: true,
        upload_data: uploadData
      };
    } else {
      const errorText = await response.text();
      console.error("画像ファイルのアップロード失敗:", response.status, errorText);
      
      throw new Error(`画像ファイルのアップロードに失敗しました: ${errorText}`);
    }
    
  } catch (error) {
    console.error("画像ファイルの処理エラー:", error);
    throw new Error(`画像ファイルの処理に失敗しました: ${error.message}`);
  }
}


// ================================
// 17) DOM構築後のイベント設定
// ================================
// グローバルエラーハンドラーを追加（外部ライブラリエラー対策）
window.addEventListener('error', function(event) {
  if (event.filename && event.filename.includes('classifier.js')) {
    // classifier.jsのエラーは無視
    console.log('classifier.js エラーを無視:', event.message);
    event.preventDefault();
    return true;
  }
  if (event.message && event.message.includes('Input must have uuid')) {
    // UUID関連エラーは無視
    console.log('UUID関連エラーを無視:', event.message);
    event.preventDefault();
    return true;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // JWT認証の初期化（ログイン後に実行）
  initializeJwtToken().catch(error => {
    // エラーログを出力しない（ログイン前は正常な動作）
    console.log('JWT初期化をスキップ: ログイン後に実行されます');
  });
  
  // マイクボタンを初期状態に設定
  setTimeout(() => {
    resetRecordButton();
  }, 100);

/* ===== サイドバー開閉トグル ===== */
sidebarEl = document.getElementById("sidebar");
const sidebarToggleBtn = document.getElementById("sidebar-toggle");

/* ── サイドバー開閉トグル ───────────────── */
sidebarToggleBtn.addEventListener('click', () => {
  const isCollapsed = sidebarEl.classList.toggle('collapsed');   // ←★ sidebarEl に変更
  document.body.classList.toggle('sidebar-open', !isCollapsed);
});

// ページ読み込み時はサイドバーを閉じた状態で開始（デスクトップ・スマホ共通）
sidebarEl.classList.add('collapsed');
document.body.classList.remove('sidebar-open');
  updateNavMenu();
  // ログイン状態のチェック - 新規追加
  checkLoginStatus();
  
  // ネットワーク監視を開始 - 新規追加
  setupNetworkMonitoring();

  // チャット初回メッセージ（AI側から質問）を表示
  displayInitialGreeting();

  // チャット画面でのファイル添付ドラッグ&ドロップ機能を初期化
  setupChatDragAndDrop();
  
  // WebSocket権限更新機能を初期化
  initWebSocketPermissionUpdates();
  
  // 辞書を初期化（dictionary-sync.js の読み込みを待機）
  setTimeout(() => {
    loadDictionaryFromKV();
    
    // 辞書の自動更新監視を開始
    startDictionarySync();
  }, 100);
  
  // ナビゲーションのトグル
  const menuToggle = document.getElementById("menu-toggle");
  const headerNav = document.getElementById("header-nav");
  if (menuToggle && headerNav) {
    menuToggle.addEventListener("click", () => {
      headerNav.classList.toggle("open");
      setTimeout(() => {
      }, 500);
    });
  }

  // 送信ボタン
  const sendBtn = document.getElementById("send-button");
  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      // 処理中なら何もしない
      if (isProcessingInput) return;
      
      const userInput = document.getElementById("user-input").value.trim();
      processInput(userInput, null);
    });
  }

  // エンターキー (Shift+Enterで改行)
  const userInputField = document.getElementById("user-input");
  if (userInputField) {
    userInputField.addEventListener("keydown", e => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // 処理中なら何もしない
        if (isProcessingInput) return;
        
        const userInput = userInputField.value.trim();
        processInput(userInput, null);
      }
    });
  }

  // ====================================
  // アップロードモーダル関連
  // ====================================
  const openUploadModalButton = document.getElementById("open-upload-modal-button");
  const uploadModal = document.getElementById("upload-modal");
  const closeUploadModalButton = document.getElementById("close-upload-modal");
  const confirmUploadButton = document.getElementById("confirm-upload-button");
  const fileInput = document.getElementById("file-input");

  if (
    openUploadModalButton &&
    uploadModal &&
    closeUploadModalButton &&
    confirmUploadButton &&
    fileInput
  ) {
    // モーダルを開くボタン
    openUploadModalButton.addEventListener("click", () => {
      uploadModal.style.display = "flex";
      setupModalDragAndDrop(); // モーダル用のドラッグ＆ドロップを有効化
    });

    // モーダルを閉じるボタン
    closeUploadModalButton.addEventListener("click", () => {
      uploadModal.style.display = "none";
      fileInput.value = "";
      // ファイル情報表示をクリア
      const fileInfoDiv = document.getElementById("file-info");
      if (fileInfoDiv) fileInfoDiv.textContent = "";
      removeModalDragAndDrop(); // モーダル用のドラッグ＆ドロップを無効化
    });

    // ファイル選択時のイベント（複数ファイル対応版では無効化）
    // 複数ファイル選択機能がindex.htmlで実装されているため、この処理は無効化
    /*
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      const fileInfoDiv = document.getElementById("file-info") || createFileInfoDiv();

      if (file) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);

        // クォータ制限を動的に取得
        const quotaManager = window.quotaManager;
        const limits = quotaManager ? await quotaManager.getUploadLimits() : null;

        const maxSizeMB = limits && typeof limits.maxFileSize === 'number' ? limits.maxFileSize : 1000;
        const maxFiles = limits && typeof limits.maxFiles === 'number' ? limits.maxFiles : 1000;
        const currentFiles = limits && typeof limits.currentFiles === 'number' ? limits.currentFiles : 0;
        const remainingFiles = limits && typeof limits.remainingFiles === 'number' ? limits.remainingFiles : 1000;
        const remainingStorage = limits && typeof limits.remainingStorage === 'number' ? limits.remainingStorage : 10;

        let infoText = `ファイル名: ${file.name}\nサイズ: ${fileSizeMB}MB`;
        let warningText = "";
        let isValid = true;

        // ファイルサイズチェック
        if (file.size > maxSizeMB * 1024 * 1024) {
          warningText += `❌ ファイルサイズが制限(${maxSizeMB}MB)を超えています\n`;
          isValid = false;
        }

        // ファイル数制限チェック
        if (typeof remainingFiles === 'number' && remainingFiles <= 0) {
          warningText += `❌ ファイル数が上限に達しています (${currentFiles}/${maxFiles})\n`;
          isValid = false;
        }

        // ストレージ容量チェック
        if (typeof remainingStorage === 'number' && fileSizeMB / 1024 > remainingStorage) {
          warningText += `❌ ストレージ容量が不足しています (残り: ${remainingStorage.toFixed(2)}GB)\n`;
          isValid = false;
        }

        // 成功メッセージまたは制限情報表示
        if (isValid) {
          if (typeof maxSizeMB === 'number') {
            warningText = `✅ アップロード可能\n制限: ${maxSizeMB}MB, ファイル数: ${remainingFiles}/${maxFiles}`;
          } else {
            warningText = `⚠️ 制限情報を取得できませんでした`;
          }
          fileInfoDiv.style.color = "#44aa44";
        } else {
          fileInfoDiv.style.color = "#ff4444";
        }

        fileInfoDiv.textContent = `${infoText}\n${warningText}`;

        // アップロードボタンの有効/無効制御
        const confirmButton = document.getElementById("confirm-upload-button");
        if (confirmButton) {
          confirmButton.disabled = !isValid;
          confirmButton.style.opacity = isValid ? "1" : "0.5";
          confirmButton.style.cursor = isValid ? "pointer" : "not-allowed";
        }
      } else {
        fileInfoDiv.textContent = "";
        // ファイルが選択されていない場合はボタンを無効にする
        const confirmButton = document.getElementById("confirm-upload-button");
        if (confirmButton) {
          confirmButton.disabled = true;
          confirmButton.style.opacity = "0.5";
          confirmButton.style.cursor = "not-allowed";
        }
      }
    });
    */

    // ファイル情報表示要素を作成
    function createFileInfoDiv() {
      let fileInfoDiv = document.getElementById("file-info");
      if (!fileInfoDiv) {
        fileInfoDiv = document.createElement("div");
        fileInfoDiv.id = "file-info";
        fileInfoDiv.style.cssText = "margin-top: 10px; padding: 10px; background: #f5f5f5; border-radius: 4px; font-size: 12px; white-space: pre-line;";
        fileInput.parentNode.insertBefore(fileInfoDiv, fileInput.nextSibling);
      }
      return fileInfoDiv;
    }

    // 「アップロード」確定ボタン
    confirmUploadButton.addEventListener("click", async () => {
      const file = fileInput.files[0];
      if (!file) {
        alert("ファイルが選択されていません。");
        return;
      }

      // クォータ制限チェック（動的制限対応版）
      const quotaManager = window.quotaManager;
      const limits = quotaManager ? await quotaManager.getUploadLimits() : null;
      
      if (limits) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
        const maxSizeMB = typeof limits.maxFileSize === 'number' ? limits.maxFileSize : 1000;
        const remainingFiles = typeof limits.remainingFiles === 'number' ? limits.remainingFiles : 1000;
        const remainingStorage = typeof limits.remainingStorage === 'number' ? limits.remainingStorage : 10;
        
        // ファイルサイズチェック
        if (file.size > maxSizeMB * 1024 * 1024) {
          alert(`ファイルサイズが大きすぎます。\n現在のサイズ: ${fileSizeMB}MB\n最大サイズ: ${maxSizeMB}MB\n\nより小さなファイルを選択してください。`);
          return;
        }
        
        // ファイル数制限チェック
        if (typeof remainingFiles === 'number' && remainingFiles <= 0) {
          alert(`ファイル数が上限に達しています。\n不要なファイルを削除してから再度お試しください。`);
          return;
        }
        
        // ストレージ容量チェック
        if (typeof remainingStorage === 'number' && fileSizeMB / 1024 > remainingStorage) {
          alert(`ストレージ容量が不足しています。\n必要容量: ${fileSizeMB}MB\n残り容量: ${(remainingStorage * 1024).toFixed(1)}MB\n\n不要なファイルを削除してください。`);
          return;
        }
      }

      // 重複チェック
      try {
        const { duplicateExists, similarFiles } = await checkFileDuplication(file);
        
        if (duplicateExists) {
          if (!confirm(`同じ名前のファイル「${file.name}」が既に存在します。\n上書きしますか？`)) {
            // ボタンを元の状態に戻す
            confirmUploadButton.disabled = false;
            confirmUploadButton.innerHTML = originalButtonContent;
            confirmUploadButton.style.cursor = 'pointer';
            return;
          }
        }
        
        if (similarFiles.length > 0) {
          const similarList = similarFiles.slice(0, 5).join("\n• ");
          const message = `似た名前のファイルが見つかりました:\n• ${similarList}${similarFiles.length > 5 ? `\n他${similarFiles.length - 5}件` : ''}\n\n内容がバッティングしていないかご確認ください。続行しますか？`;
          
          if (!confirm(message)) {
            // ボタンを元の状態に戻す
            confirmUploadButton.disabled = false;
            confirmUploadButton.innerHTML = originalButtonContent;
            confirmUploadButton.style.cursor = 'pointer';
            return;
          }
        }
      } catch (err) {
        console.error("ファイル名のチェック中にエラーが発生しました:", err);
      }

      addMessage("ファイルをアップロードしています...", "system");
      
      // アップロードボタンをローディング状態にする
      const originalButtonContent = confirmUploadButton.innerHTML;
      confirmUploadButton.disabled = true;
      confirmUploadButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> アップロード中...';
      confirmUploadButton.style.cursor = 'not-allowed';
      
      try {
        const result = await uploadFileAndRegisterToKnowledge(file);
        addMessage("アップロード完了。", "system");
        alert("アップロードが完了しました。");
        // ファイル一覧のキャッシュをクリア
        apiCache.clear('file-list');
        // クォータキャッシュもクリア
        if (window.quotaManager) {
          window.quotaManager.quotaCache = null;
        }
      } catch (err) {
        addMessage("アップロード中にエラーが発生しました。", "system");
        console.error(err);
        
        // エラーの種類に応じて分かりやすいメッセージを表示
        let errorMessage = "アップロード中にエラーが発生しました。";
        
        if (err.message.includes("413") || err.message.includes("file_too_large")) {
          const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
          errorMessage = `ファイルサイズが大きすぎます。\n現在のサイズ: ${fileSizeMB}MB\n最大サイズ: 15MB\n\nファイルを圧縮するか、より小さなファイルを選択してください。`;
        } else if (err.message.includes("415") || err.message.includes("unsupported_file_type")) {
          errorMessage = `サポートされていないファイル形式です。\n対応形式: PDF, TXT, DOCX, XLSX, PNG, JPG など`;
        } else if (err.message.includes("400") || err.message.includes("invalid_param")) {
          errorMessage = `ファイルのパラメータが無効です。\nファイルが破損していないか確認してください。`;
        } else if (err.message.includes("403")) {
          errorMessage = `アップロード権限がありません。\n管理者にお問い合わせください。`;
        } else if (err.message.includes("502") || err.message.includes("503") || err.message.includes("504")) {
          errorMessage = `サーバーエラーが発生しました。\nしばらく待ってから再度お試しください。`;
        }
        
        alert(errorMessage);
      } finally {
        // ボタンを元の状態に戻す
        confirmUploadButton.disabled = false;
        confirmUploadButton.innerHTML = originalButtonContent;
        confirmUploadButton.style.cursor = 'pointer';
        uploadModal.style.display = "none";
        fileInput.value = "";
        removeModalDragAndDrop(); // モーダル用のドラッグ＆ドロップを無効化
      }
    });
  } else {
    // アップロードモーダル要素が見つからない場合は機能を無効化
    return;
  }

  // 会話履歴モーダル
  historyList = document.getElementById("history-list");
  const historyLink = document.getElementById("history-link");
  const historyModal = document.getElementById("history-modal");
  const closeHistoryModalButton = document.getElementById("close-history-modal");

  if (historyLink && historyModal && closeHistoryModalButton) {
    historyLink.addEventListener("click", async (e) => {
      e.preventDefault();
      historyModal.style.display = "flex";
      await fetchConversationHistory(); // convId未指定 => 「まだ会話がありません」と表示
    });
    closeHistoryModalButton.addEventListener("click", () => {
      historyModal.style.display = "none";
    });
  }

  // 会話一覧、新規会話
  const conversationListRefreshBtn = document.getElementById("conversation-refresh");
  const newConversationBtn = document.getElementById("new-conversation-btn");

  if (conversationListRefreshBtn) {
    conversationListRefreshBtn.addEventListener("click", async () => {
      await fetchConversationList();
    });
  }
  if (newConversationBtn) {
    newConversationBtn.addEventListener("click", async () => {
      await createNewConversation();
      sidebarEl.classList.add("collapsed");
      document.body.classList.remove("sidebar-open");
    });
  }

  // ログイン状態の場合のみ会話一覧自動取得
  if (localStorage.getItem("accessToken")) {
    fetchConversationList();
  }

  /*****************************************************
   * ファイル一覧：モーダル表示
   *****************************************************/
  const fileListLink = document.getElementById("file-list-link");
  const fileListModal = document.getElementById("file-list-modal");
  const fileListUl = document.getElementById("file-list");
  const closeFileListModalButton = document.getElementById("close-file-list-modal");

  if (fileListLink && fileListModal && fileListUl && closeFileListModalButton) {
    fileListLink.addEventListener("click", async () => {
      try {
        fileListUl.innerHTML = "";
        
        // 🔄 権限データが変更されている可能性があるため、常に最新データを取得

        // 権限関連のキャッシュをクリア
        apiCache.clear('file-list');
        apiCache.clear('user-permissions');
        
        // 権限情報付きファイル一覧を取得
        const data = await fetchFilesList();
        
        // 新しいデータをキャッシュに保存
        apiCache.set('file-list', data, 5 * 60 * 1000);
        displayFileList(data);
        
        fileListModal.style.display = "flex";
      } catch (error) {
        // ファイル一覧取得エラーは静かに処理
        addMessage("ファイル一覧の取得中にエラーが発生しました。", "system");
      }
    });
    closeFileListModalButton.addEventListener("click", () => {
      fileListModal.style.display = "none";
    });
  }

  // ファイル一覧表示関数
  function displayFileList(data) {
    if (!fileListUl) {
      console.error('❌ fileListUl 要素が見つかりません');
      return;
    }

    // 別テナントエラーの場合
    if (data && data.error === 'different_tenant') {
      const expectedDomain = data.expected_domain || 'correct domain';
      fileListUl.innerHTML = `
        <li style="
          background: #fff3cd;
          border: 1px solid #ffeaa7;
          border-radius: 8px;
          padding: 15px;
          margin: 10px 0;
          color: #856404;
          list-style: none;
        ">
          <div style="display: flex; align-items: center; gap: 8px; font-weight: bold; margin-bottom: 8px;">
            <span>⚠️</span>
            <span>アクセス権限について</span>
          </div>
          <div style="line-height: 1.6; font-size: 14px;">
            別企業のアカウントでログインしています。<br>
            正しいアカウント（@${expectedDomain}）でログインし直してください。
          </div>
        </li>
      `;
      return;
    }

    if (!data || data.length === 0) {
      fileListUl.innerHTML = "<li>登録されているファイルはありません。</li>";
      return;
    }
    
    // dataが配列の場合（新しい形式）
    const files = Array.isArray(data) ? data : (data.data || []);
    
    // Django仕様: 'none'権限のファイルは表示しない
    const visibleFiles = files.filter(file => {
      // 権限がオブジェクトの場合は effective_level を使用
      let permission = 'read';
      if (typeof file.permission === 'object' && file.permission !== null) {
        permission = file.permission.effective_level || 'read';
      } else {
        permission = file.permission || file.permission_level || file.effective_permission || 'read';
      }

      return permission !== 'none';
    });
    
    if (visibleFiles.length === 0) {
      fileListUl.innerHTML = "<li>アクセス可能なファイルはありません。</li>";
    } else {

      // 既存のファイル一覧をクリア
      fileListUl.innerHTML = "";

      visibleFiles.forEach(doc => {
        const li = document.createElement("li");
        let dateStr = "";
        if (doc.created_at) {
          const dt = new Date(doc.created_at * 1000);
          dateStr = dt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
        }
        li.textContent = (doc.name || `ドキュメントID: ${doc.id}`) + (dateStr ? " - 登録日: " + dateStr : "");
        li.dataset.docId = doc.id;
        li.addEventListener("click", async function() {
          const clickedDocId = this.dataset.docId;
          await showFileDetail(clickedDocId);
        });
        
        // 権限に基づいて削除ボタンの表示を制御
        const hasEditPermission = checkEditPermission(doc.permission);
        
        
        if (hasEditPermission) {
          const deleteBtn = document.createElement("button");
          deleteBtn.textContent = "×";
          deleteBtn.className = "delete-file-btn";
          deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          /* ── 1回目 ─────────────────────── */
          const first = confirm("ファイルを削除しますか？");
          if (!first) return;               // キャンセル → 何もしない

          /* ── 2回目 ─────────────────────── */
          const second = confirm("本当に削除しますか？");
          if (!second) return;              // キャンセル → 何もしない

          /* ── ここまで来たら削除を実行 ─── */
          try {
            const deleteUrl =
              getConfig('ENDPOINTS.DOCUMENT_VIEW') ? getConfig('ENDPOINTS.DOCUMENT_VIEW')(doc.id) : `${API_BASE}/documents/${doc.id}`;

            const res = await apiFetch(deleteUrl, { method: "DELETE" });
            if (!res.ok) {
              const errText = await res.text();
              throw new Error(errText);
            }

            alert("ファイルが削除されました。");
            li.remove();                    // リストから即時削除
            apiCache.clear("file-list");    // キャッシュもクリア
          } catch (err) {
            // ファイル削除エラーはユーザーに通知
            alert("ファイル削除に失敗しました: " + err.message);
          }
          });
          li.appendChild(deleteBtn);
        }

        fileListUl.appendChild(li);
      });

    }
  }

  /**
   * 編集権限があるかチェック
   * @param {string} permission - 権限レベル ('none', 'read', 'comment', 'contribute', 'inherit')
   * @returns {boolean} - 編集権限があるかどうか
   */
  function checkEditPermission(permission) {
    // 権限がオブジェクトの場合は effective_level を使用
    let effectivePermission = permission;
    if (typeof permission === 'object' && permission !== null) {
      effectivePermission = permission.effective_level || 'read';
    }

    // 'contribute'権限がある場合のみ編集（削除）可能
    return effectivePermission === 'contribute';
  }

  /**
   * ファイル一覧を強制更新（キャッシュクリア付き）
   */
  async function forceRefreshFilesList() {
    // APIキャッシュをクリア
    if (typeof apiCache !== 'undefined') {
      apiCache.clear("file-list");
      apiCache.clear("user-permissions");
    }
    
    // ファイル一覧を再取得して表示
    const files = await fetchFilesList();
    displayFileList(files);
  }


  /**
   * ファイル詳細モーダルの編集ボタン権限を更新
   * @param {string} docId - ドキュメントID
   * @param {HTMLElement} toggleEditBtn - 編集モードボタン
   * @param {HTMLElement} updateFileBtn - 更新ボタン
   */
  async function updateFileDetailPermissions(docId, toggleEditBtn, updateFileBtn) {
    try {
      
      // Workers経由でユーザーの知識ベース権限情報を取得
      const cacheBuster = Date.now();
      const permissionsResponse = await apiFetch(getConfig('ENDPOINTS.ACCESSIBLE_KNOWLEDGE_BASES') + `?_=${cacheBuster}`, {
        method: "GET"
      });
      
      let filePermission = 'read'; // デフォルトは読み取り専用
      
      if (permissionsResponse.ok) {
        const permissionsData = await permissionsResponse.json();
        
        // 権限データを処理してファイル権限を取得
        if (permissionsData.knowledge_bases && Array.isArray(permissionsData.knowledge_bases)) {
          let foundFilePermission = false;
          
          permissionsData.knowledge_bases.forEach(kb => {
            
            if (kb.documents && Array.isArray(kb.documents)) {
              kb.documents.forEach(doc => {
                if ((doc.document_id || doc.id) === docId) {
                  filePermission = doc.permission_level || doc.effective_permission || 'read';
                  foundFilePermission = true;
                }
              });
            }
          });
          
          // 個別ファイル権限が見つからない場合、知識ベース権限を適用
          if (!foundFilePermission) {
            const firstKB = permissionsData.knowledge_bases.find(kb => kb.permissions?.permission_level);
            if (firstKB) {
              filePermission = firstKB.permissions.permission_level;
            } else {
            }
          }
        }
      } else {
        // フォールバック: ローカル役職情報を使用
        const userRoles = JSON.parse(localStorage.getItem("userRoles") || "[]");
        const hasAdminRole = userRoles.includes('役員') || userRoles.includes('管理者');
        filePermission = hasAdminRole ? 'contribute' : 'read';
      }
      
      // 編集権限があるかチェック
      const hasEditPermission = checkEditPermission(filePermission);
      
      // 編集ボタンの表示/非表示を制御
      if (hasEditPermission) {
        toggleEditBtn.style.display = 'inline-block';
        toggleEditBtn.title = '編集モードに切り替え';
      } else {
        toggleEditBtn.style.display = 'none';
        updateFileBtn.style.display = 'none'; // 更新ボタンも非表示
      }
      
      // モーダルに権限情報を保存（WebSocket更新時に参照）
      const modal = document.getElementById("file-detail-modal");
      if (modal) {
        modal.setAttribute("data-file-permission", filePermission);
      }
      
    } catch (error) {
      // エラー時は編集ボタンを非表示にする（安全側に倒す）
      toggleEditBtn.style.display = 'none';
      updateFileBtn.style.display = 'none';
    }
  }

  async function showFileDetail(docId) {
  try {
    if (!docId) {
      alert("ファイル詳細を取得できません: 無効なドキュメントIDです");
      return;
    }
    
    // 注: 権限チェックはファイル一覧のフィルタリングで実行済み
    
    // モーダル関連の要素を取得
    const modal = document.getElementById("file-detail-modal");
    const viewDiv = document.getElementById("file-detail-view");
    const editTextarea = document.getElementById("file-detail-edit");
    const closeBtn = document.getElementById("close-file-detail-modal");
    const toggleEditBtn = document.getElementById("toggle-edit-mode-button");
    const updateFileBtn = document.getElementById("update-file-button");
    
    if (!modal || !viewDiv || !editTextarea || !closeBtn || !toggleEditBtn || !updateFileBtn) {
      alert("ファイル詳細モーダル関連の要素が見つかりません。");
      return;
    }
    
    // 読み込み中の表示
    viewDiv.textContent = "ファイル内容を読み込み中...";
    editTextarea.value = "";
    
    // ドキュメントIDを設定
    modal.setAttribute("data-doc-id", docId);
    
    // ファイルの権限情報を取得して編集ボタンを制御
    await updateFileDetailPermissions(docId, toggleEditBtn, updateFileBtn);
    
    // モーダルを表示
    modal.style.display = "flex";
    
    // ファイル詳細のキャッシュキー
    const cacheKey = `file-detail-${docId}`;
    const cachedData = apiCache.get(cacheKey);
    
    let contentText = "";
    
    if (cachedData) {
      contentText = cachedData;
    } else {
      // Workers経由でDjango連携済みファイル詳細を取得
      const res = await workersApiFetch(`/api/files/detail?docId=${encodeURIComponent(docId)}`);
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTPエラー! ステータス: ${res.status}`);
      }
      
      const data = await res.json();
      
      // Django+Workers統合レスポンス処理
      if (!data.success) {
        throw new Error(data.error || "ドキュメント取得に失敗しました。");
      }
      
      if (!data.data || data.data.length === 0) {
        throw new Error("ドキュメント内容が空です。");
      }
      
      
      contentText = data.data.map(seg => seg.content).join("\n---\n");
      
      // キャッシュに保存（10分間）
      apiCache.set(cacheKey, contentText, 10 * 60 * 1000);
    }
    
    // コンテンツを表示
    viewDiv.textContent = contentText;
    editTextarea.value = contentText;
    
    // 閉じるボタンのイベントを設定（既存のリスナーを削除して新規作成）
    closeBtn.onclick = null; // 既存のイベントをクリア
    closeBtn.onclick = function() {
      modal.style.display = "none";
    };
    
    // 編集モード切替ボタンを設定
    toggleEditBtn.onclick = null;
    toggleEditBtn.onclick = function() {
      if (viewDiv.style.display === "none") {
        // 閲覧モードに戻す
        viewDiv.style.display = "block";
        editTextarea.style.display = "none";
        this.textContent = "編集モード";
        updateFileBtn.style.display = "none";
      } else {
        // 編集モードにする
        viewDiv.style.display = "none";
        editTextarea.style.display = "block";
        this.textContent = "閲覧モード";
        updateFileBtn.style.display = "inline-block";
      }
    };
    
    // 更新ボタンのイベントを設定
    updateFileBtn.onclick = null;
    updateFileBtn.onclick = async function() {
      const currentDocId = modal.getAttribute("data-doc-id");
      
      const updatedText = editTextarea.value.trim();
      if (!updatedText) {
        alert("内容が空です。");
        return;
      }
      
      // ボタンを無効化
      this.disabled = true;
      const originalText = this.textContent;
      this.textContent = "更新中...";
      
      try {
        const resp = await apiFetch(getConfig('ENDPOINTS.FILE_UPDATE'), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docId: currentDocId,
            text: updatedText
          })
        });
        
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`更新エラー: ${resp.status} - ${errText}`);
        }
        
        const responseData = await resp.json();
        
        if (responseData.success) {
          alert("更新が完了しました。");
          // 表示を更新
          viewDiv.textContent = updatedText;
          // 編集モードを終了
          viewDiv.style.display = "block";
          editTextarea.style.display = "none";
          toggleEditBtn.textContent = "編集モード";
          updateFileBtn.style.display = "none";
          
          // キャッシュを更新
          const cacheKey = `file-detail-${currentDocId}`;
          apiCache.set(cacheKey, updatedText, 10 * 60 * 1000);
        } else {
          alert("更新に失敗しました: " + (responseData.message || "不明なエラー"));
        }
      } catch (err) {
        alert("更新中にエラーが発生しました: " + err.message);
      } finally {
        // ボタンを元に戻す
        this.disabled = false;
        this.textContent = originalText;
      }
    };
    
  } catch (error) {
    alert(`ファイル詳細取得中にエラーが発生しました: ${error.message}`);
    
    // エラーが発生した場合はモーダルを閉じる
    const modal = document.getElementById("file-detail-modal");
    if (modal) {
      modal.style.display = "none";
    }
  }
}
});

// ================================
// 18) 会話一覧を取得・表示
// ================================
async function fetchConversationList() {
  try {
    // テストモードでは会話一覧APIをスキップ
    if (getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
      console.log('🔓 テストモード: 会話一覧APIコールをスキップ');
      displayConversationList([]);
      return;
    }

    // キャッシュチェック
    const cacheKey = 'conversation-list';
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData) {
      displayConversationList(cachedData.data || []);
      return;
    }
    
    // ユーザーID取得（メールアドレスをIDとして使用）
    const userEmail = localStorage.getItem("userEmail");
    if (!userEmail) {
      // メールアドレスが取得できない場合は空の会話リストを表示
      displayConversationList([]);
      return;
    }
    
    // TODO: 将来的にWorkersに会話一覧エンドポイントを実装
    displayConversationList([]);
    
  } catch (err) {
    // 認証エラーの場合は静かに処理（ログイン促進のため）
    if (err.message && err.message.includes("No access token")) {
      displayConversationList([]);
      return;
    }
    
    console.error("Error fetching conversation list:", err);
    
    // エラーメッセージ表示（システムメッセージとして）
    addMessage("会話一覧の取得中にエラーが発生しました。", "system");
    
    // エラーの場合でも空の会話一覧を表示
    displayConversationList([]);
  }
}

function displayConversationList(conversations) {
  const conversationListUL = document.getElementById("conversation-list");
  if (!conversationListUL) return;

  // リストを空にする
  conversationListUL.innerHTML = "";

  // 会話がない場合
  if (!conversations.length) {
    const emptyItem = document.createElement("li");
    emptyItem.textContent = "会話がありません";
    emptyItem.className = "empty-conversation";
    conversationListUL.appendChild(emptyItem);
    return;
  }

  // 各会話のリストアイテムを作成
  conversations.forEach(conv => {
    const li = document.createElement("li");
    
    // ── タイトルと 3 点メニューを並べる ──
    const titleSpan = document.createElement("span");
    titleSpan.className = "conv-title";
    titleSpan.textContent = conv.name || "(名称未設定)";

    const menuBtn = document.createElement("button");
    menuBtn.className = "conv-menu-btn";
    menuBtn.innerHTML = "&hellip;";
    /* === 新: GPT 風の小さなメニュー === */
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();          // li クリックを殺す
      e.preventDefault();

      closeConvMenu();              // すでに開いていれば閉じる

      /* ── メニュー DOM を生成 ── */
      const menu = document.createElement("div");
      menu.className = "conv-context-menu";

      const renameBtn = document.createElement("button");
      renameBtn.textContent = "名前を変更";
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "削除";

      menu.append(renameBtn, deleteBtn);
      document.body.appendChild(menu);
      activeConvMenu = menu;

      /* --- 位置調整: ボタンの“すぐ右”に出す（はみ出し補正付き） --- */
      const r = menuBtn.getBoundingClientRect();
      menu.style.top = `${r.bottom + window.scrollY + 4}px`;

      // ボタンの右端＋4px を基準に配置
      let left = r.right + window.scrollX + 4;

      // 右端が画面外に出る場合だけ、画面内に収まるようシフト
      const maxLeft = window.scrollX + window.innerWidth - menu.offsetWidth - 8; // 右から 8px 余白
      if (left > maxLeft) left = maxLeft;

      menu.style.left = `${left}px`;

      /* --- 名前変更 --- */
      renameBtn.addEventListener("click", async () => {
        const current = titleSpan.textContent;
        const newName = prompt("新しい会話タイトル", current);
        if(!newName || newName === current) return closeConvMenu();
        try{
          await renameConversation(conv.id, newName);
          titleSpan.textContent = newName;
          li.dataset.convName   = newName;
          apiCache.clear("conversation-list");
        }catch(err){
          alert("タイトル変更に失敗しました: " + err.message);
        }
        closeConvMenu();
      });

      /* --- 削除 --- */
      deleteBtn.addEventListener("click", async () => {
        if(!confirm("本当にこの会話を削除しますか？※元に戻せません")) return closeConvMenu();
        try{
          await deleteConversation(conv.id);
          li.remove();
          apiCache.clear("conversation-list");
          if(conversationId === conv.id){          // 表示中だったらクリア
            conversationId = "";
            clearChatMessages();
          }
        }catch(err){
          alert("削除に失敗しました: " + err.message);
        }
        closeConvMenu();
      });

      /* 外側クリックで閉じる */
      setTimeout(() => document.addEventListener("click", closeConvMenu), 0);
    });

    li.appendChild(titleSpan);
    li.appendChild(menuBtn);
    
    // データ属性を設定（ID・名前）
    li.dataset.convId = conv.conversation_id || conv.id;
    li.dataset.convName = conv.name || "(名称未設定)";
    
    // 作成日時を表示（あれば）
    if (conv.created_at) {
      const date = new Date(conv.created_at * 1000);
      const formattedDate = date.toLocaleDateString('ja-JP');
      const timeElem = document.createElement("span");
      timeElem.className = "conversation-date";
      timeElem.textContent = formattedDate;
      li.appendChild(timeElem);
    }

    // クリックイベント設定
    li.addEventListener("click", async () => {
      // 既に選択されている場合は何もしない
      if (li.classList.contains("selected")) return;
      
      // 選択状態を更新
      const selected = conversationListUL.querySelector(".selected");
      if (selected) selected.classList.remove("selected");
      li.classList.add("selected");
      
      // 会話IDを設定して履歴取得
      conversationId = conv.id;
      await fetchConversationHistory(conv.id, li.dataset.convName);
      sidebarEl.classList.add("collapsed");
      document.body.classList.remove("sidebar-open");
    });

    // リストに追加
    conversationListUL.appendChild(li);
  });
}


// ================================
// 19) 新規会話作成
// ================================
async function createNewConversation() {
  try {
    // 読み込み中メッセージを表示
    clearChatMessages();
    addMessage("新規会話を作成しています...", "system");
    
    // ユーザーID取得
    const userEmail = localStorage.getItem("userEmail") || "anonymous";
    
    // conversationIdをリセット（新規会話のため）
    conversationId = "";
    
    // 新規会話作成API呼び出し
    const resp = await apiFetch(getConfig('ENDPOINTS.CONVERSATION_NEW'), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        'X-API-Client': 'sirusiru-chat',
        'X-Tenant-Domain': getConfig('TENANT_DOMAIN')
      },
      body: JSON.stringify({
        user: userEmail
      })
    });
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Create New Conversation Error:", errText);

      // 認証エラーの場合は特別処理
      if (resp.status === 401) {
        clearSystemMessages("新規会話を作成しています...");
        addMessage("認証エラーが発生しました。ページを再読み込みしてログインし直してください。", "system");
        // 3秒後に自動リロード
        setTimeout(() => {
          window.location.reload();
        }, 3000);
        return;
      }

      // その他のエラー
      clearSystemMessages("新規会話を作成しています...");
      addMessage("新規会話の作成中にエラーが発生しました。再度お試しください。", "system");
      return;
    }
    
    // 成功した場合
    const data = await resp.json();
    console.log("新規会話作成レスポンス:", data);

    // 会話IDを設定
    conversationId = data.id || data.conversation_id || "";
    console.log("設定された会話ID:", conversationId);

    // 読み込み中メッセージを削除
    clearSystemMessages("新規会話を作成しています...");
    
    // Difyパラメータから開始挨拶を取得して表示
    const difyParams = await fetchDifyParameters();
    
    if (difyParams && difyParams.opening_statement) {
      // ボットからの開始挨拶を表示
      addMessage(difyParams.opening_statement, "bot");
    } else if (data.first_message) {
      // APIレスポンスに最初のメッセージがあれば表示
      addMessage(data.first_message, "bot");
    }
    
    // 会話一覧のキャッシュをクリア
    apiCache.clear('conversation-list');
    
    // 会話一覧を再取得
    await fetchConversationList();
    
    // 新しく作成された会話を選択状態にする
    const conversationListUL = document.getElementById("conversation-list");
    if (conversationListUL) {
      const items = conversationListUL.querySelectorAll("li");
      items.forEach(item => {
        if (item.dataset.convId === conversationId) {
          // 選択状態を更新
          const selected = conversationListUL.querySelector(".selected");
          if (selected) selected.classList.remove("selected");
          item.classList.add("selected");
        }
      });
    }
  } catch (err) {
    console.error("Error creating new conversation:", err);
    
    // 読み込み中メッセージを削除
    clearSystemMessages("新規会話を作成しています...");
    
    // エラーメッセージを表示
    addMessage("新規会話の作成中にエラーが発生しました。", "system");
  }
}


// ================================
// 20) 会話履歴を取得しチャット更新
// ================================
async function fetchConversationHistory(convId, convName) {
  // 既に処理中なら何もしない
  if (isProcessingHistory) return;
  isProcessingHistory = true;
  
  try {
    // 会話IDがなければ空表示
    if (!convId) {
      if (historyList) {
        historyList.innerHTML = "<li>会話を選択または新規作成してください</li>";
      }
      clearChatMessages();
      isProcessingHistory = false;
      return;
    }
    
    // キャッシュチェック
    const cacheKey = `history-${convId}`;
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData) {
      await displayHistoryFromData(cachedData, convName);
      isProcessingHistory = false;
      return;
    }
    
    // 読み込み中メッセージを表示
    clearChatMessages();
    addMessage("会話履歴を読み込み中...", "system");
    
    // ユーザーID取得
    const userEmail = localStorage.getItem("userEmail") || "anonymous";
    
    // 履歴取得API呼び出し
    const endpoint = getConfig('ENDPOINTS.CONVERSATION_HISTORY') ? getConfig('ENDPOINTS.CONVERSATION_HISTORY')(userEmail, convId) : `${API_BASE}/conversation-history?user=${encodeURIComponent(userEmail)}&conversation_id=${convId}`;

    const resp = await apiFetch(endpoint, {
      method: "GET",
      headers: {
        'X-API-Client': 'sirusiru-chat',
        'X-Tenant-Domain': getConfig('TENANT_DOMAIN')
      },
      timeout: 15000  // 15秒タイムアウト
    });
    
    if (!resp.ok) {
      // エラーメッセージを解析
      let friendlyMessage = "会話履歴の取得に失敗しました。新しいメッセージを送信して会話を継続できます。";
      let shouldRetry = false;
      
      try {
        const errorText = await resp.text();
        console.error("ConversationHistory error:", errorText);
        
        // サーバーエラーの場合
        if (resp.status >= 500) {
          friendlyMessage = "現在サーバーがメンテナンス中か一時的な問題が発生しています。新しいメッセージを送信することで会話を継続できます。";
          shouldRetry = historyRetryCount < MAX_HISTORY_RETRIES;
        }
      } catch (parseErr) {
        console.error("Error parsing error message:", parseErr);
      }
      
      // 読み込み中メッセージを削除（clearSystemMessagesの代わりに）
      removeSpecificSystemMessage("会話履歴を読み込み中...");
      
      // リトライするか決定
      if (shouldRetry) {
        historyRetryCount++;
        addMessage(`会話履歴の取得中にエラーが発生しました。再試行します (${historyRetryCount}/${MAX_HISTORY_RETRIES})...`, "system");
        
        // 1秒後に再試行
        setTimeout(() => {
          isProcessingHistory = false;
          fetchConversationHistory(convId, convName);
        }, 1000);
        return;
      } else {
        // リトライせず、エラーメッセージを表示
        historyRetryCount = 0;
        addMessage(friendlyMessage, "system");
        
        // 空の会話履歴として処理
        displayHistoryFromData({ data: [] }, convName);
        isProcessingHistory = false;
        return;
      }
    }
    
    // 成功した場合
    historyRetryCount = 0;
    const data = await resp.json();
    
    // キャッシュに保存（5分間）
    apiCache.set(cacheKey, data, 5 * 60 * 1000);
    
    // 読み込み中メッセージを削除（clearSystemMessagesの代わりに）
    removeSpecificSystemMessage("会話履歴を読み込み中...");
    
    // 履歴を表示
    await displayHistoryFromData(data, convName);
  } catch (err) {
    console.error("Error fetching conversation history:", err);
    
    // 読み込み中メッセージを削除（clearSystemMessagesの代わりに）
    removeSpecificSystemMessage("会話履歴を読み込み中...");
    
    // エラーメッセージを表示
    let errorMessage = "会話履歴の取得中にエラーが発生しました。";

    // 認証エラーの場合
    if (err.message.includes("Authentication failed") || err.message.includes("401")) {
      errorMessage = "認証エラーが発生しました。ページを再読み込みしてログインし直してください。";
      addMessage(errorMessage, "system");
      // 3秒後に自動リロード
      setTimeout(() => {
        window.location.reload();
      }, 3000);
      return;
    }

    // タイムアウトエラーの場合
    if (err.name === "TimeoutError" || err.message.includes("timeout")) {
      errorMessage = "サーバーからの応答がありません。しばらくしてからもう一度お試しください。";
    }

    addMessage(errorMessage, "system");
    
    // 空の会話履歴として処理
    await displayHistoryFromData({ data: [] }, convName);
  } finally {
    isProcessingHistory = false;
  }
}

// 特定のテキストを持つシステムメッセージを削除する関数
function removeSpecificSystemMessage(text) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;
  
  const systemMessages = chatMessages.querySelectorAll(".message.system");
  systemMessages.forEach(msg => {
    if (msg.textContent === text) {
      chatMessages.removeChild(msg);
    }
  });
}

// 履歴データから表示を行う関数
async function displayHistoryFromData(data, convName) {
  // チャットメッセージをクリア
  clearChatMessages();
  
  // データがあれば表示
  if (data.data && data.data.length > 0) {
    data.data.forEach(msg => {
      if (msg.query) addMessage(msg.query, "user");
      if (msg.answer) addMessage(msg.answer, "bot");
    });
  } else {
    // 会話履歴が空の場合、開始挨拶を表示
    const difyParams = await fetchDifyParameters();
    
    if (difyParams && difyParams.opening_statement) {
      addMessage(difyParams.opening_statement, "bot");
    }
  }

  // 会話名を表示
  if (convName) {
    addMessage(`「${convName}」に切り替えました`, "system");
  }
}

// チャットメッセージをクリアする関数
function clearChatMessages() {
  const chatMessages = document.getElementById("chat-messages");
  if (chatMessages) {
    chatMessages.innerHTML = "";
  }
}


// ================================
// 21) フォローアップ(質問候補)取得＆表示
// ================================
async function fetchSuggestedQuestions(messageId) {
  try {
    // キャッシュキー
    const cacheKey = `suggested-${messageId}`;
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData) {
      displaySuggestedQuestions(cachedData.data || []);
      return;
    }
    
    const userEmail = localStorage.getItem("userEmail") || "anonymous";
    const resp = await apiFetch(getConfig('ENDPOINTS.SUGGESTED_QUESTIONS') ? getConfig('ENDPOINTS.SUGGESTED_QUESTIONS')(messageId, userEmail) : `${API_BASE}/messages/${messageId}/suggested?user=${encodeURIComponent(userEmail)}`);
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Get Suggested Questions error:", errText);
      return;
    }
    const data = await resp.json();
    
    // 30分間キャッシュ（質問候補は変わりにくいため）
    apiCache.set(cacheKey, data, 30 * 60 * 1000);
    
    displaySuggestedQuestions(data.data || []);
  } catch (err) {
    console.error("Error fetching suggestions:", err);
  }
}

function displaySuggestedQuestions(suggestions) {
  const container = document.getElementById("suggested-questions");
  if (!container) return;

  container.innerHTML = "";

  if (!suggestions.length) {
    return;
  }

  suggestions.forEach(suggestion => {
    const btn = document.createElement("button");
    btn.textContent = suggestion;
    btn.style.margin = "4px";
    btn.style.padding = "6px 10px";
    btn.style.background = "#444";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "4px";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => {
      processInput(suggestion, null);
    });
    container.appendChild(btn);
  });
}


// ================================
// ログインモーダル制御等 (後半)
// ================================
const loginLink = document.getElementById("login-link");
const loginModal = document.getElementById("login-modal");
const closeLoginModalButton = document.getElementById("close-login-modal");
const loginSubmitButton = document.getElementById("login-submit-button");

if (loginLink && loginModal && closeLoginModalButton && loginSubmitButton) {
  loginLink.addEventListener("click", () => {
    loginModal.style.display = "flex";
  });

  closeLoginModalButton.addEventListener("click", () => {
    loginModal.style.display = "none";
  });

  loginSubmitButton.addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value.trim();
    if (!email || !password) {
      alert("メールアドレスとパスワードを入力してください。");
      return;
    }
  
    try {
      // 新しいログインエンドポイントを使用
      const loginEndpoint = getConfig('ENDPOINTS.LOGIN');

      const response = await fetch(loginEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Client": "sirusiru-chat",
          "X-Tenant-Domain": window.CONFIG?.TENANT_DOMAIN || "example.com"
        },
        body: JSON.stringify({ username: email, password: password })
      });

      if (!response.ok) {
        const errorData = await response.json();
        alert("ログイン失敗: " + (errorData.error || response.statusText));
        return;
      }

      const data = await response.json(); 
      // loginSuccess関数を使用してトークン保存とタイマー設定
      loginSuccess(data);
      
      hideLoginModal();
      updateNavMenu();
      
      // 状態更新
      enableUserInteractions();
      
      // 注: loginSuccess関数内で自動的に会話履歴が更新されるので、
      // ここでの会話履歴の取得コードは必要ありません
    } catch (err) {
      console.error("ログイン中エラー:", err);
      alert("ログイン処理中にエラーが発生しました。");
    }
  });
}

const mypageLink = document.getElementById("mypage-link");
const mypageModal = document.getElementById("mypage-modal");
const closeMypageModalButton = document.getElementById("close-mypage-modal");
const logoutButton = document.getElementById("logout-button");

if (mypageLink && mypageModal && closeMypageModalButton && logoutButton) {
  mypageLink.addEventListener("click", () => {
    showMypageModal();
  });

  closeMypageModalButton.addEventListener("click", () => {
    mypageModal.style.display = "none";
  });

  logoutButton.addEventListener("click", () => {
    logoutUser();
  });
}

// ログイン成功時の処理（トークン保存とタイマー設定）
function loginSuccess(data) {
  /* ▼ レスポンスのどこにトークンが来ても拾えるようにする */

  // WebSocket再接続カウンターをリセット（新しいログイン用）
  wsReconnectAttempts = 0;
  wsReconnectDelay = 1000;

  // ① メールアドレス
  const email =
        data.email               ||      // { "email": … }
        data.user?.email         ||      // { "user": { "email": … } }
        "";
  if (email) localStorage.setItem("userEmail", email);

  // ユーザー情報を保存（新しい /api/login エンドポイント用）
  if (data.user) {
    try {
      localStorage.setItem("userInfo", JSON.stringify(data.user));
    } catch (e) {
      console.error("ユーザー情報の保存エラー:", e);
    }
  }

  // ② ロール（配列 or 文字列想定）
  const roles =
        data.roles               ||      // { "roles": […] }
        data.user?.roles         ||      // { "user": { "roles": […] } }
        data.user?.groups        ||      // Django の Group 名
        [];


  localStorage.setItem("userRoles", JSON.stringify(roles));

  // ③ テナント（名称だけで OK）
  let tenant =
        data.tenant              ||      // { "tenant": "foo" }
        data.user?.tenant        ||      // { "user": { "tenant": "foo" } }
        data.user?.tenant_name   ||      // { "user": { "tenant_name": "foo" } }
        "";

  // オブジェクトの場合はnameプロパティを取得
  if (typeof tenant === 'object' && tenant !== null) {
    tenant = tenant.name || tenant.company_name || tenant.tenant_name || JSON.stringify(tenant);
  }

  localStorage.setItem("userTenant", String(tenant));


  const access  = data.access        || data.access_token  ||
                  data.token?.access || data.tokens?.access;
  const refresh = data.refresh       || data.refresh_token ||
                  data.token?.refresh|| data.tokens?.refresh;

  if (!access || !refresh) {
    alert("ログイン応答にアクセストークンが含まれていません。サーバー側のレスポンス形式を確認してください。");
    console.error("loginSuccess: missing token field →", data);
    return;
  }

  localStorage.setItem("accessToken",  access);
  localStorage.setItem("refreshToken", refresh);

  logoutAlertShown = false;

  /* ④ 残トークン数を API から取得して保存・表示 ----------------- */
  fetchRemainingTokens()
    .then(balance => updateBalanceDisplay(balance))
    .catch(err => console.error("残トークン取得失敗:", err));
  
  /* ⑤ ユーザープロファイル情報を取得して保存 ----------------- */
  // キャッシュをクリア（テナント切り替え対応）
  if (apiCache && apiCache.data) {
    apiCache.clear(); // 全キャッシュをクリア
  }

  fetchUserProfile()
    .then(profile => {
      if (profile) {
        updateUserInfoDisplay(profile);
      }
    })
    .catch(err => console.error("ユーザープロファイル取得失敗:", err));
  
  // トークン更新タイマーを設定
  setupTokenRefreshTimer();
  enableUserInteractions();

  setTimeout(async () => {
    try {
      // WebSocket接続をリセット（テナント切り替え対応）
      resetWebSocketConnection();

      // 会話一覧を取得して表示
      await fetchConversationList();

      // 最新の会話を読み込む（会話一覧が取得できていれば）
      const conversationListUL = document.getElementById("conversation-list");
      if (conversationListUL && conversationListUL.firstChild &&
          conversationListUL.firstChild.dataset &&
          conversationListUL.firstChild.dataset.convId) {
        // 一番上の会話を選択
        const firstConv = conversationListUL.firstChild;
        conversationId = firstConv.dataset.convId;
        await fetchConversationHistory(conversationId, firstConv.dataset.convName);
      } else {
        // 会話がない場合は新規会話を作成（追加遅延）
        setTimeout(async () => {
          await createNewConversation();
        }, 1000);
      }
    } catch (err) {
      console.error("ログイン後の会話履歴更新エラー:", err);
      addMessage("会話履歴の更新中にエラーが発生しました。", "system");
    }
    removeSpecificSystemMessage("操作するにはログインが必要です。");
  }, 1000); // 遅延を増やして認証状態の安定を待つ
}

// ログインセッション維持のためのトークン更新タイマー設定
function setupTokenRefreshTimer() {
  // 既存のタイマーがある場合はクリア
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
  }
  
  // アクセストークンがある場合のみタイマーを設定
  const token = localStorage.getItem("accessToken");
  if (token) {
    // 5分ごとにトークンの有効期限をチェック
    tokenRefreshTimer = setInterval(async () => {
      const currentToken = localStorage.getItem("accessToken");
      if (currentToken && isTokenExpiringSoon(currentToken, 5)) {
        console.log("定期チェック: トークンが期限切れ間近のため、リフレッシュします");
        const success = await tryRefresh();
        if (!success) {
          console.error("定期リフレッシュに失敗しました");
          // リフレッシュ失敗時はタイマー停止
          clearInterval(tokenRefreshTimer);
          tokenRefreshTimer = null;
        }
      } else if (currentToken) {
        // console.log("定期チェック: トークンは有効です"); // 不要なログ削除
      } else {
        console.warn("定期チェック: トークンが見つかりません");
        clearInterval(tokenRefreshTimer);
        tokenRefreshTimer = null;
      }
    }, 5 * 60 * 1000); // 5分

    // ページがフォーカスされた時のトークンチェック
    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden && localStorage.getItem("accessToken")) {
        const currentToken = localStorage.getItem("accessToken");
        if (currentToken && isTokenExpiringSoon(currentToken, 10)) {
          console.log("ページフォーカス時: トークンが期限切れ間近のため、リフレッシュします");
          await tryRefresh();
        }
      }
    });
  }
}

async function fetchRemainingTokens() {
  try {
    const cacheKey = 'token-balance';
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData !== null) {
      return cachedData;
    }
    
    const resp = await apiFetch(getConfig('ENDPOINTS.TOKEN_BALANCE'), {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });
    
    if (!resp.ok) {
      // レスポンスのContent-Typeをチェック
      const contentType = resp.headers.get("Content-Type") || '';
      
      if (contentType.includes("application/json")) {
        try {
          const errorData = await resp.json();
          console.error("残トークン取得失敗:", errorData.error || resp.statusText);
        } catch (e) {
          console.error("残トークン取得失敗(JSON解析エラー):", resp.status, resp.statusText);
        }
      } else {
        // HTMLエラーページなど、JSONではないレスポンス
        const errorText = await resp.text();
        console.error("残トークン取得失敗(非JSONレスポンス):", resp.status, errorText.substring(0, 200));
      }
      return null;
    }
    
    let data;
    try {
      data = await resp.json();               // { total, products:{…} }
    } catch (e) {
      console.error("残トークン取得レスポンスのJSON解析エラー:", e);
      return null;
    }
    const balObj = {
      total : data.total,
      chat  : data.products?.[PRODUCT_CHAT]  ?? 0,
      image : data.products?.[PRODUCT_IMAGE] ?? 0
    };

    if (typeof balObj.total !== "number") {
      // トークン数が数値でない場合はnullを返す（ログイン状態の可能性）
      return null;
    }

    apiCache.set(cacheKey, balObj, 5 * 60 * 1000);
    return balObj;
  } catch (error) {
    console.error("トークン残高取得エラー:", error);
    return null;
  }
}

// ユーザープロファイル情報を取得（Django API優先）
async function fetchUserProfile() {
  try {
    // テストモードではAPIコールをスキップ
    if (getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
      console.log('🔓 テストモード: ユーザープロファイルAPIコールをスキップ');
      return {
        email: 'test-user@example.com',
        name: 'Test User',
        company: 'Test Company'
      };
    }

    const cacheKey = 'user-profile';
    const cachedData = apiCache.get(cacheKey);

    if (cachedData !== null) {
      return cachedData;
    }

    // ローカルストレージから取得
    const userInfo = localStorage.getItem(getConfig('APP_SETTINGS.USER_INFO_KEY'));
    if (userInfo) {
      try {
        const data = JSON.parse(userInfo);
        apiCache.set(cacheKey, data, 5 * 60 * 1000);
        return data;
      } catch (e) {
        console.error('保存されたユーザー情報の解析エラー:', e);
      }
    }

    return null;
  } catch (error) {
    console.error("ユーザープロファイル取得エラー:", error);
    return null;
  }
}

// Django APIから直接ユーザープロファイル情報を取得
async function fetchUserProfileFromAPI() {
  try {
    const response = await apiFetch(getConfig('ENDPOINTS.USER_PROFILE'), {
      method: 'GET'
    });

    if (response.ok) {
      const profileData = await response.json();
      return profileData;
    } else {
      console.error("Django API ユーザープロファイル取得エラー:", response.status);
      return null;
    }
  } catch (error) {
    console.error("Django API ユーザープロファイル取得エラー:", error);
    return null;
  }
}

// ユーザー情報表示を更新
function updateUserInfoDisplay(profile) {
  try {
    // ユーザー情報をlocalStorageに保存（既存の形式と互換性を保つ）
    if (profile.email) {
      localStorage.setItem("userEmail", profile.email);
    }
    // Django APIからのrole情報処理（role or position フィールドを使用）
    const roleFromAPI = profile.role || profile.position;
    if (roleFromAPI) {
      const roles = [roleFromAPI];
      localStorage.setItem("userRoles", JSON.stringify(roles));
    }
    // Django APIからのテナント情報処理（company_name or tenant_name フィールドを使用）
    const tenantFromAPI = profile.company_name || profile.tenant_name || profile.company || profile.tenant;
    if (tenantFromAPI) {
      localStorage.setItem("userTenant", String(tenantFromAPI));
    }
    
  } catch (error) {
    console.error("ユーザー情報表示更新エラー:", error);
  }
}

async function consumeTokens(amount) {
  try {
    const resp = await apiFetch(getConfig('ENDPOINTS.TOKEN_CONSUME'), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ tokens: amount })
    });

    const contentType = resp.headers.get("Content-Type") || '';

    if (!resp.ok) {
      let errorMessage = `エラー: ステータスコード ${resp.status}`;

      if (contentType.includes("application/json")) {
        const errData = await resp.json();
        errorMessage += ` - ${errData.message || JSON.stringify(errData)}`;
      } else if (contentType.includes("text/html")) {
        const errHtml = await resp.text();
        console.error("サーバーエラーHTML:", errHtml);
        errorMessage += ` - サーバーエラーが発生しました。詳細はサーバーのログをご確認ください。`;
      } else {
        errorMessage += ` - 不明なエラー形式`;
      }

      // 401エラーの場合は例外をスローして上位でリトライ処理
      if (resp.status === 401) {
        throw new Error(`401: ${errorMessage}`);
      }

      // 500エラーの場合は警告ログのみで処理を継続
      if (resp.status === 500) {
        console.error("トークン消費API 500エラー - 処理を継続:", errorMessage);
        return null;
      }

      alert(errorMessage);
      return;
    }

    const data = await resp.json();               // { total, products:{…} }
    const balObj = {
      total : data.total,
      chat  : data.products?.[PRODUCT_CHAT]  ?? 0,
      image : data.products?.[PRODUCT_IMAGE] ?? 0
    };

    // 自動チャージが発生した場合の通知処理
    if (data.auto_charged || data.recharged || data.charged_amount || data.auto_charge_occurred) {
      const chargedAmount = data.charged_amount || data.auto_charge_amount || 100; // デフォルト100トークン
      showAutoChargeNotification(chargedAmount, data.total);
    }

    updateBalanceDisplay(balObj);
    apiCache.set("token-balance", balObj, 5 * 60 * 1000);
    return balObj;

  } catch (err) {
    console.error("通信エラー:", err);
    alert("通信エラーが発生しました。ネットワークを確認してください。");
  }
}

/**
 * 自動チャージ通知を表示する関数
 * @param {number} chargedAmount チャージされたトークン数
 * @param {number} newBalance 新しい残高
 */
function showAutoChargeNotification(chargedAmount, newBalance) {
  try {
    // チャット画面に通知メッセージを追加
    const chatMessages = document.getElementById("chat-messages");
    if (chatMessages) {
      const notificationDiv = document.createElement("div");
      notificationDiv.className = "auto-charge-notification";
      notificationDiv.style.cssText = `
        background: linear-gradient(135deg, #4CAF50, #45a049);
        color: white;
        padding: 15px 20px;
        margin: 10px 0;
        border-radius: 10px;
        border-left: 5px solid #2e7d32;
        box-shadow: 0 4px 8px rgba(0,0,0,0.1);
        animation: slideInFromRight 0.5s ease-out;
        position: relative;
      `;

      notificationDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 24px;">💳</span>
          <div>
            <div style="font-weight: bold; font-size: 16px; margin-bottom: 5px;">
              🔄 自動チャージ完了
            </div>
            <div style="font-size: 14px; opacity: 0.95;">
              ${chargedAmount} トークンが自動追加されました<br>
              現在の残高: ${newBalance} トークン
            </div>
          </div>
        </div>
      `;

      chatMessages.appendChild(notificationDiv);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      // 5秒後に自動的に非表示（フェードアウト）
      setTimeout(() => {
        notificationDiv.style.transition = "opacity 1s ease-out";
        notificationDiv.style.opacity = "0";
        setTimeout(() => {
          if (notificationDiv.parentNode) {
            notificationDiv.parentNode.removeChild(notificationDiv);
          }
        }, 1000);
      }, 5000);
    }

    // ヘッダーにも一時的な通知を表示
    showHeaderNotification(`💳 ${chargedAmount} トークン自動チャージ完了`);

    // コンソールにもログ出力
    console.log(`🔄 自動チャージ: ${chargedAmount} トークン追加, 新残高: ${newBalance}`);

  } catch (error) {
    console.error("自動チャージ通知表示エラー:", error);
  }
}

/**
 * ヘッダーに一時的な通知を表示する関数
 * @param {string} message 表示するメッセージ
 */
function showHeaderNotification(message) {
  try {
    // 既存の通知があれば削除
    const existingNotification = document.getElementById('header-notification');
    if (existingNotification) {
      existingNotification.remove();
    }

    const header = document.querySelector('header');
    if (!header) return;

    const notification = document.createElement('div');
    notification.id = 'header-notification';
    notification.style.cssText = `
      position: fixed;
      top: 70px;
      left: 50%;
      transform: translateX(-50%);
      background: #4CAF50;
      color: white;
      padding: 10px 20px;
      border-radius: 5px;
      box-shadow: 0 4px 8px rgba(0,0,0,0.2);
      z-index: 9999;
      font-size: 14px;
      font-weight: 500;
      animation: slideDown 0.3s ease-out;
    `;

    notification.textContent = message;
    document.body.appendChild(notification);

    // 3秒後に自動削除
    setTimeout(() => {
      notification.style.transition = "opacity 0.5s ease-out, transform 0.5s ease-out";
      notification.style.opacity = "0";
      notification.style.transform = "translateX(-50%) translateY(-10px)";
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 500);
    }, 3000);

  } catch (error) {
    console.error("ヘッダー通知表示エラー:", error);
  }
}

/**
 * テスト用: 自動チャージ通知をデモ表示する関数
 * 開発・テスト時に手動で呼び出し可能
 */
function testAutoChargeNotification() {
  showAutoChargeNotification(100, 105);
}

// グローバルに公開（テスト用）
window.testAutoChargeNotification = testAutoChargeNotification;

async function checkSubscriptionStatus() {
  const token = localStorage.getItem("accessToken");
  if (!token) {
    alert("ログインしてください。");
    return;
  }

  try {
    const resp = await apiFetch(getConfig('ENDPOINTS.SUBSCRIPTION_STATUS'), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("サブスク確認失敗:", errText);
      return;
    }
    const data = await resp.json();
  } catch (err) {
    console.error("サブスク状態チェック中エラー:", err);
  }
}

function updateNavMenu() {
  const loginLink = document.getElementById("login-link");
  const mypageLink = document.getElementById("mypage-link");
  const dictionaryManagerLink = document.getElementById("dictionary-manager-link");
  const accessToken = localStorage.getItem("accessToken");

  if (loginLink) {
    loginLink.style.display = accessToken ? "none" : "inline-block";
  }

  if (mypageLink) {
    mypageLink.style.display = accessToken ? "inline-block" : "none";
  }

  if (dictionaryManagerLink) {
    dictionaryManagerLink.style.display = accessToken ? "inline-block" : "none";
  }
}

function showMypageModal() {
  const mypageModal = document.getElementById("mypage-modal");
  const emailSpan = document.getElementById("user-email");
  const rolesSpan = document.getElementById("user-roles");
  const tenantSpan = document.getElementById("user-tenant");
  const tokenSpan = document.getElementById("user-token-balance");

  if (!mypageModal || !emailSpan || !rolesSpan || !tenantSpan || !tokenSpan) {
    // マイページモーダル要素が見つからない場合は機能を無効化
    return;
  }

  const email = localStorage.getItem("userEmail") || "";
  const roles = JSON.parse(localStorage.getItem("userRoles") || "[]");
  const tenant = localStorage.getItem("userTenant") || "";
  const tokenBalance = Number(localStorage.getItem("userTokenBalance") || 0);


  emailSpan.textContent = email;
  rolesSpan.textContent = roles.join(", ");
  tenantSpan.textContent = tenant;
  if (!tokenBalance) {
    tokenSpan.textContent = tokenBalance;
  } else {
    // ローカルに無ければ即時取得
    fetchRemainingTokens().then(bal => updateBalanceDisplay(bal));
  }

  mypageModal.style.display = "flex";
}

function logoutUser() {
  // 既存のタイマーがある場合はクリア
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }

  // WebSocket接続を完全に切断（再接続防止）
  if (permissionWebSocket) {
    permissionWebSocket.close();
    permissionWebSocket = null;
  }

  // WebSocket再接続試行をリセット
  wsReconnectAttempts = wsMaxReconnectAttempts; // 最大値に設定して再接続を防止
  wsReconnectDelay = 1000;

  // ポーリングタイマーを停止
  stopPollingPermissionUpdates();

  // JWT自動取得フラグもリセット（テナント切り替え対応）
  isJwtTokenReady = false;
  jwtTokenInitPromise = null;

  // LocalStorageを完全にクリア（テナント切り替え対応）
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("userRoles");
  localStorage.removeItem("userTenant");
  localStorage.removeItem("userTokenBalance");
  localStorage.removeItem("access_token"); // JWT自動取得用トークンもクリア
  localStorage.removeItem("cachedUserId"); // キャッシュされたuser_idもクリア
  localStorage.removeItem(getConfig('APP_SETTINGS.USER_INFO_KEY')); // 新しいユーザー情報もクリア

  // キャッシュをクリア
  apiCache.clear();

  updateNavMenu();
  setupUnauthorizedInterceptors();

  const mypageModal = document.getElementById("mypage-modal");
  if (mypageModal) {
    mypageModal.style.display = "none";
  }

  if (!logoutAlertShown) {          // ← 追加
    alert("ログアウトしました。");
    logoutAlertShown = true;
  }

  // チャットメッセージをクリア
  clearChatMessages();
  addMessage("ログアウトしました。操作するにはログインが必要です。", "system");

  // ここを追加: ログアウト後すぐにログインモーダルを表示
  showLoginModal();
}

function updateBalanceDisplay(raw) {
  if (!raw) return;

  // 数値だけ来ても壊れないよう後方互換
  const bal = typeof raw === "number"
              ? { total: raw, chat: "-", image: "-" }
              : raw;

  localStorage.setItem("userTokenBalance", bal.total);

  const span = document.getElementById("user-token-balance");
  if (span) {
    // 基本の残高表示
    span.textContent = bal.total;

    // 自動チャージ機能が有効であることを示すツールチップを追加
    span.title = `現在の残高: ${bal.total} トークン\n💡 残高が0になると自動的に100トークンがチャージされます`;

    // 残高が少ない場合の警告表示
    if (bal.total <= 5) {
      span.style.color = "#ff9800"; // オレンジ色で警告
      span.title += "\n⚠️ 残高が少なくなっています";
    } else {
      span.style.color = ""; // デフォルト色に戻す
    }
  }

  apiCache.set("token-balance", bal, 5 * 60 * 1000);
}

// トークンの有効期限をチェックする関数
function isTokenExpiringSoon(token, bufferMinutes = 2) {
  if (!token) return true;

  // テストモードではトークンチェックをスキップ
  if (getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
    return false; // 常に有効として扱う
  }

  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const exp = payload.exp;
    if (!exp) return true;

    const now = Math.floor(Date.now() / 1000);
    const timeUntilExpiry = exp - now;
    const bufferSeconds = bufferMinutes * 60;

    return timeUntilExpiry <= bufferSeconds;
  } catch (error) {
    // テストモードの場合はエラーログを出さない
    if (!getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
      console.error("トークン有効期限チェックエラー:", error);
    }
    return true;
  }
}

async function tryRefresh() {
  const refresh = localStorage.getItem("refreshToken");
  if (!refresh) {
    console.warn("リフレッシュトークンが見つかりません");
    return false;
  }

  console.log("トークンリフレッシュを開始...");

  try {
    const resp = await fetch(getConfig('ENDPOINTS.TOKEN_REFRESH'), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Client": "sirusiru-chat",
        "X-Tenant-Domain": getConfig('TENANT_DOMAIN')
      },
      body: JSON.stringify({ refresh })
    });

    console.log(`リフレッシュレスポンス: ${resp.status}`);

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`リフレッシュ失敗: ${resp.status} - ${errorText}`);

      if (resp.status === 400 || resp.status === 401) {
        // リフレッシュトークンが無効な場合は完全にクリア（テナント切り替え対応）
        console.warn("無効なリフレッシュトークンを削除 - 完全ログアウト実行");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("accessToken");
        localStorage.removeItem("userEmail");
        localStorage.removeItem("userRoles");
        localStorage.removeItem("userTenant");
        localStorage.removeItem("userTokenBalance");

        // WebSocket接続もクリア
        if (permissionWebSocket) {
          permissionWebSocket.close();
          permissionWebSocket = null;
        }

        // キャッシュもクリア
        if (apiCache) {
          apiCache.clear();
        }

        // 権限ポーリングも停止
        stopPollingPermissionUpdates();
      }
      return false;
    }

    const data = await resp.json();
    const newAccess = data.access || data.access_token;
    if (!newAccess) {
      console.error("リフレッシュレスポンスにアクセストークンがありません");
      return false;
    }

    console.log("トークンリフレッシュ成功");
    localStorage.setItem("accessToken", newAccess);
    if (data.refresh) {
      localStorage.setItem("refreshToken", data.refresh);
    }
    return true;
  } catch (error) {
    console.error("トークンリフレッシュエラー:", error);
    return false;
  }
}

// シンプルなapiFetch関数（動作していたバージョンをベース）
async function apiFetch(url, options = {}) {
  // トークン取得
  let token = localStorage.getItem("accessToken");

  // トークンの有効期限をチェックし、期限切れ前にリフレッシュ
  if (token && isTokenExpiringSoon(token)) {
    console.log("トークンが期限切れ間近のため、事前にリフレッシュします");
    const refreshed = await tryRefresh();
    if (refreshed) {
      token = localStorage.getItem("accessToken");
    } else {
      console.warn("事前リフレッシュに失敗しました");
    }
  }

  // アクセストークン未格納の場合は即ログイン要求せず、まずリフレッシュを試してみる
  if (!token) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      token = localStorage.getItem("accessToken");
    } else {
      // 特定のエンドポイント（会話リスト取得など）では認証が必須なので、その場合のみログインモーダルを表示
      const requiresAuth = [
        '/conversation-list',
        '/conversation-history',
        '/conversations/new',
        '/audio-to-text',
        '/text-to-audio',
        '/api/chat/messages'
      ].some(endpoint => url.includes(endpoint));

      if (requiresAuth) {
        showLoginModal();
        throw new Error("No access token, and refresh failed.");
      }
      // 認証不要のエンドポイントの場合は続行
    }
  }

  // 共通ヘッダーに認証トークンを付与（トークンがある場合のみ）
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
  }

  // fetchオプションにCORSと認証情報を含める
  const fetchOptions = {
    ...options,
    headers,
    mode: 'cors',
    credentials: 'include'
  };

  let retryCount = 0;
  let authRetryCount = 0;  // 認証リトライカウント追加
  const maxRetries = 3;  // ネットワークエラー時に最大3回再試行
  const maxAuthRetries = 1;  // 認証エラー時は1回だけリトライ

  async function executeFetch() {
    try {
      let res = await fetch(url, fetchOptions);

      // 401認証エラー時のリフレッシュ処理
      if (res.status === 401 && authRetryCount < maxAuthRetries) {
        authRetryCount++;
        
        const refreshSuccess = await tryRefresh();
        if (!refreshSuccess) {
          showLoginModal();
          throw new Error("Authentication failed. Please log in again.");
        }
        
        // 新しいトークンをセットして再試行
        const newToken = localStorage.getItem("accessToken");
        if (newToken) {
          fetchOptions.headers["Authorization"] = `Bearer ${newToken}`;
          res = await fetch(url, fetchOptions);
        }
        
        // それでも401の場合は諦める
        if (res.status === 401) {
          showLoginModal();
          throw new Error("Still unauthorized after refresh. Please log in.");
        }
      } else if (res.status === 401) {
        // リトライ上限に達した場合
        showLoginModal();
        throw new Error("Authentication failed after retries.");
      }

      return res;
    } catch (error) {
      // 認証エラー以外のネットワークエラー時の指数バックオフ再試行
      if (!error.message.includes("Authentication") && retryCount < maxRetries) {
        retryCount++;
        const backoffTime = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        return executeFetch();
      }
      console.error("Network error after retries:", error);
      throw error;
    }
  }

  return executeFetch();
}

// ================================
// Dify APIパラメータ取得関数
// ================================
async function fetchDifyParameters() {
  try {
    // キャッシュチェック
    const cached = apiCache.get('dify-parameters');
    if (cached) return cached;
    
    const resp = await apiFetch(getConfig('ENDPOINTS.PARAMETERS'), {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    
    if (!resp.ok) {
      console.warn("Failed to fetch Dify parameters:", resp.status);
      throw new Error(`Dify parameters API failed: ${resp.status}`);
    }
    
    const data = await resp.json();
    
    // キャッシュに保存（5分間）
    apiCache.set('dify-parameters', data, 5 * 60 * 1000);
    
    return data;
  } catch (err) {
    console.warn("Error fetching Dify parameters:", err);
    throw new Error(`Failed to fetch Dify parameters: ${err.message}`);
  }
}

function showLoginModal() {
  const loginModal = document.getElementById("login-modal");
  if (!loginModal) return;

  loginModal.style.display = "flex";

  // 未ログイン状態ではモーダルを閉じられないようにする
  const closeBtn = document.getElementById("close-login-modal");
  if (closeBtn) {
    closeBtn.style.display = "none";
  }

  // 入力欄と送信ボタンを無効化
  const userInput = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-button");
  if (userInput) userInput.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  
  // モーダル外クリックでもログインモーダルを閉じられないようにする
  loginModal.onclick = function(e) {
    if (e.target === loginModal) {
      e.stopPropagation();
      // アラートで表示するので以下の行を削除
      // addMessage("操作するにはログインが必要です。", "system");
      alert("操作するにはログインが必要です。"); // 代わりにアラートで表示
    }
  };
}

function hideLoginModal() {
  const loginModal = document.getElementById("login-modal");
  if (loginModal) {
    loginModal.style.display = "none";
  }

  const closeBtn = document.getElementById("close-login-modal");
  if (closeBtn) {
    closeBtn.style.display = "inline-block";
  }

  const userInput = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-button");
  if (userInput) userInput.disabled = false;
  if (sendBtn) sendBtn.disabled = false;
}

// ファイル削除用の関数（削除APIへのリクエスト）
async function deleteFile(docId) {
  try {
    // ここでは、DELETEリクエストで削除を実行する例です。
    // ※エンドポイントのURLは、環境に合わせて修正してください。
    const response = await apiFetch(getConfig('ENDPOINTS.DATASETS_DOCUMENT') ? getConfig('ENDPOINTS.DATASETS_DOCUMENT')(docId) : `${API_BASE}/datasets/your_dataset_id/documents/${docId}`, {
      method: "DELETE"
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }
    alert("ファイルが削除されました。");
    
    // ファイル一覧キャッシュをクリア
    apiCache.clear('file-list');
  } catch (err) {
    console.error("ファイル削除エラー:", err);
    alert("ファイル削除に失敗しました: " + err.message);
  }
}

// ================================
// ログイン状態のチェック (新規追加)
// ================================
function checkLoginStatus() {
  // 開発・テスト用: 認証スキップモード
  if (getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
    console.log("🔓 認証スキップモード: テスト用にログインなしで動作します");
    // ダミーのユーザー情報を設定
    localStorage.setItem("accessToken", "test-dummy-token");
    localStorage.setItem("userEmail", "test@example.com");
    enableUserInteractions();
    updateNavMenu();
    return;
  }
  
  const token = localStorage.getItem("accessToken");
  
  if (!token) {
    // 初回ロード時にトークンがない場合は即座にログインモーダルを表示
    setTimeout(() => {
      showLoginModal();
    }, 1000); // 1秒後にログインモーダルを表示
    setupUnauthorizedInterceptors();
  } else {
    // トークンがある場合は有効性を確認
    validateTokenSilently();
    // トークン更新タイマーを設定
    setupTokenRefreshTimer();
    // ユーザー操作を有効化
    enableUserInteractions();
  }
  
  updateNavMenu();
}

// 保存されたトークンの有効性を静かに確認
async function validateTokenSilently() {
  try {
    // 一時的に無効化：トークンバランスAPIで401エラーが発生するため
    return;
    
    // 軽量なAPIエンドポイントを叩いて有効性確認
    const resp = await fetch(getConfig('ENDPOINTS.TOKEN_BALANCE'), {
      headers: {
        "Authorization": `Bearer ${localStorage.getItem("accessToken")}`,
        "X-API-Client": "sirusiru-chat",
        "X-Tenant-Domain": getConfig('TENANT_DOMAIN')
      }
    });
    
    if (!resp.ok && resp.status === 401) {
      // 無効なトークン
      const refreshSuccess = await tryRefresh();
      if (!refreshSuccess) {
        // リフレッシュ失敗時も強制表示しない
        setupUnauthorizedInterceptors();
      }
    }
  } catch (error) {
    console.error("Token validation error:", error);
    // エラー時もそのまま続行
  }
}

// 未ログイン時にユーザー操作を傍受してログインモーダルを表示
function setupUnauthorizedInterceptors() {
  const interceptElements = [
    document.getElementById("send-button"),
    document.getElementById("record-button"),
    document.getElementById("open-upload-modal-button"),
    document.getElementById("file-list-link"),
    document.getElementById("new-conversation-btn"),
    document.getElementById("conversation-refresh")
  ];
  
  interceptElements.forEach(elem => {
    if (elem) {
      // 元のclickイベントを保存
      elem.__originalClick = elem.onclick;
      
      // 新しいclickイベントで上書き
      elem.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        alert("操作するにはログインが必要です。"); // チャット欄ではなくアラートで表示
        showLoginModal();
      };
    }
  });
  
  // フォーム送信に対する傍受
  const userInput = document.getElementById("user-input");
  if (userInput) {
    unauthorizedKeydownHandler = function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        alert("メッセージを送信するにはログインが必要です。"); // チャット欄ではなくアラートで表示
        showLoginModal();
      }
    };
    userInput.addEventListener("keydown", unauthorizedKeydownHandler, true);
  }
}

// ユーザー操作を有効化
function enableUserInteractions() {
  const userInput = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-button");
  if (userInput) userInput.disabled = false;
  if (sendBtn) sendBtn.disabled = false;
  
  // WebSocket権限更新機能を初期化
  setTimeout(() => {
    initWebSocketPermissionUpdates();
  }, 1000);
  
  // 傍受していたイベントを元に戻す
  const elements = [
    document.getElementById("send-button"),
    document.getElementById("record-button"),
    document.getElementById("open-upload-modal-button"),
    document.getElementById("file-list-link"),
    document.getElementById("new-conversation-btn"),
    document.getElementById("conversation-refresh")
  ];
  
  elements.forEach(elem => {
    if (elem) {
      // イベントリスナーをクリア（より確実な方法）
      if (elem.__originalClick) {
        elem.onclick = elem.__originalClick;
        delete elem.__originalClick;
      } else {
        elem.onclick = null;
      }
      
      // 元々のイベントリスナーが設定されていた場合は再設定
      if (elem.id === "send-button") {
        elem.addEventListener("click", () => {
          // 処理中なら何もしない
          if (isProcessingInput) return;
          
          const userInput = document.getElementById("user-input").value.trim();
          processInput(userInput, null);
        });
      }
      
      // 他のボタンについても同様に元々の機能を再設定する
      // 例：record-buttonなど必要に応じて
    }
  });
  
  // キーボードイベントも元に戻す
  const inputField = document.getElementById("user-input");
  if (inputField) {
    if (unauthorizedKeydownHandler) {
      inputField.removeEventListener("keydown", unauthorizedKeydownHandler, true);
      unauthorizedKeydownHandler = null;
    }
    
    // 正しいイベントリスナーを設定し直す
    inputField.addEventListener("keydown", e => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // 処理中なら何もしない
        if (isProcessingInput) return;
        
        const userInput = inputField.value.trim();
        processInput(userInput, null);
      }
    });
  }
}

// ネットワーク状態の監視
function setupNetworkMonitoring() {
  window.addEventListener('online', () => {
    addMessage("インターネット接続が回復しました。", "system");
    // ログイン状態の場合のみキャッシュをクリアして最新データを取得
    if (localStorage.getItem("accessToken")) {
      apiCache.clear('conversation-list');
      fetchConversationList();
    }
  });
  
  window.addEventListener('offline', () => {
    addMessage("インターネット接続が切断されました。一部機能が利用できません。", "system");
  });
}

// システムメッセージを削除する関数 - 追加して問題を解決
function clearSystemMessages(text) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;
  
  const systemMessages = chatMessages.querySelectorAll(".message.system");
  systemMessages.forEach(msg => {
    // 特定のテキストを含むメッセージのみ削除
    if (msg.textContent === text) {
      chatMessages.removeChild(msg);
    }
  });
}

// 全てのシステムメッセージを削除する関数（オプション）
function clearAllSystemMessages() {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;
  
  const systemMessages = chatMessages.querySelectorAll(".message.system");
  systemMessages.forEach(msg => {
    chatMessages.removeChild(msg);
  });
}

// ================================
// WebSocket権限更新機能
// ================================

// WebSocket権限更新システムを初期化（フォールバック付き）
async function initWebSocketPermissionUpdates() {
  try {
    const userEmail = localStorage.getItem("userEmail");
    if (!userEmail) {
      return;
    }

    // Django APIからuser_idを取得
    const userId = await getUserIdFromEmail(userEmail);
    if (!userId) {
      // user_idが取得できない場合は静かにポーリング方式に切り替え
      // フォールバック：ポーリング方式で権限更新を実装
      initPollingPermissionUpdates();
      return;
    }

    // WebSocket接続を少し遅らせて試行（ログイン直後の接続問題を回避）
    setTimeout(() => {
      try {
        connectPermissionWebSocket(userId);
      } catch (wsError) {
        // WebSocket接続に失敗した場合は静かにポーリング方式に切り替え
        // フォールバック：ポーリング方式で権限更新を実装
        initPollingPermissionUpdates();
      }
    }, 2000); // 2秒遅延
  } catch (error) {
    console.error("WebSocket権限更新初期化エラー:", error);
    // フォールバック：ポーリング方式で権限更新を実装
    initPollingPermissionUpdates();
  }
}

// メールアドレスからuser_idを取得
async function getUserIdFromEmail(email) {
  try {
    // ユーザープロファイル情報から取得（テナント切り替え対応）
    const profile = await fetchUserProfile();

    if (!profile) {
      console.error("WebSocket: ユーザープロファイル取得エラー");
      return null;
    }

    if (profile.id) {
      // 取得したuser_idをキャッシュして再利用（テナント切り替え時にクリア）
      localStorage.setItem('cachedUserId', profile.id);
      return profile.id;
    }

    // LocalStorageからキャッシュされたuser_idを取得
    const cachedUserId = localStorage.getItem('cachedUserId');
    if (cachedUserId) {
      return parseInt(cachedUserId);
    }

    // フォールバック: デフォルトユーザーIDは使用しない（古いIDとの競合を避ける）
    console.warn("WebSocket: user_idが取得できませんでした。WebSocket接続をスキップします。");
    return null;
  } catch (error) {
    console.error("WebSocket: user_id取得エラー:", error);
    return null;
  }
}

// WebSocket接続を開始
function connectPermissionWebSocket(userId) {
  try {
    if (permissionWebSocket) {
      permissionWebSocket.close();
      permissionWebSocket = null;
    }

    // WebSocket URLを構築（プロトコルをHTTPSに合わせてWSS）
    const wsUrl = getConfig('EXTERNAL_SERVICES.WEBSOCKET_PERMISSIONS') ? getConfig('EXTERNAL_SERVICES.WEBSOCKET_PERMISSIONS')(userId) : `${getConfig('WEBSOCKET_BASE')}/ws/permissions/${userId}/`;
    
    permissionWebSocket = new WebSocket(wsUrl);

    permissionWebSocket.onopen = function(event) {
      wsReconnectAttempts = 0; // 成功したらリトライカウントをリセット
      wsReconnectDelay = 1000; // 再接続遅延もリセット
      
      // 接続確認のためのpingを送信
      setTimeout(() => {
        if (permissionWebSocket && permissionWebSocket.readyState === WebSocket.OPEN) {
          permissionWebSocket.send(JSON.stringify({
            type: 'ping',
            timestamp: Date.now()
          }));
        }
      }, 1000);
    };

    permissionWebSocket.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        handlePermissionUpdate(data);
      } catch (error) {
        console.error("WebSocketメッセージ解析エラー:", error);
      }
    };

    permissionWebSocket.onerror = function(error) {
      // WebSocketエラーは静かに処理（ポーリングフォールバックがあるため）
      console.warn("WebSocket connection failed, using polling fallback");
    };

    permissionWebSocket.onclose = function(event) {
      permissionWebSocket = null;
      
      // 自動再接続（最大試行回数まで）
      if (wsReconnectAttempts < wsMaxReconnectAttempts) {
        wsReconnectAttempts++;
        setTimeout(() => {
          connectPermissionWebSocket(userId);
        }, wsReconnectDelay);
        
        // 再接続遅延を倍増（最大30秒まで）
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
      } else {
        // ポーリング方式にフォールバック
        initPollingPermissionUpdates();
      }
    };
  } catch (error) {
    console.error("🔴 WebSocket connection setup error:", error);
    console.warn("Falling back to polling method due to setup error");
    // フォールバック：ポーリング方式で権限更新を実装
    initPollingPermissionUpdates();
  }
}

// 権限更新通知を処理
function handlePermissionUpdate(data) {
  switch (data.type) {
    case 'permission_update':
    case 'cache_cleared':
      // ファイル一覧を自動更新
      refreshFileList();
      
      // Dify会話中の場合、権限変更をDifyにも通知
      refreshDifyPermissions();
      break;
      
    case 'error':
      console.error("WebSocket権限更新エラー:", data.message);
      break;
  }
}


// ファイル一覧を自動更新（WebSocketリアルタイム権限更新対応）
function refreshFileList() {
  try {
    
    // ファイル一覧関連のキャッシュをクリア
    apiCache.clear('files');
    apiCache.clear('file-list');
    apiCache.clear('user-permissions');
    
    // ファイル一覧モーダルが表示されている場合は自動更新
    const fileListModal = document.getElementById('file-list-modal');
    const isFileListModalVisible = fileListModal && fileListModal.style.display !== 'none' && 
                                   fileListModal.style.display !== '';
    
    if (isFileListModalVisible) {
      
      // ファイル一覧モーダル内容を更新（削除ボタンの表示/非表示も含む）
      setTimeout(async () => {
        try {
          if (typeof forceRefreshFilesList !== 'undefined') {
            await forceRefreshFilesList();
          } else {
            // フォールバック: ファイル一覧を再取得・表示（権限情報付き）
            const files = await fetchFilesList();
            if (typeof displayFilesList === 'function') {
              displayFilesList(files, { name: 'SIRUSIRU-Noce' }, null);
            } else {
              displayFileList(files);
            }
          }
        } catch (error) {
        }
      }, 100);
    }
    
    // ファイル詳細モーダルが表示されている場合は編集ボタンを自動更新（Django仕様準拠）
    const fileDetailModal = document.getElementById('file-detail-modal');
    const isFileDetailModalVisible = fileDetailModal && fileDetailModal.style.display !== 'none' && 
                                     fileDetailModal.style.display !== '';
    
    if (isFileDetailModalVisible) {
      const docId = fileDetailModal.getAttribute('data-doc-id');
      if (docId) {
        setTimeout(async () => {
          try {
            await refreshFileDetailPermissions(docId);
          } catch (error) {
            console.error('ファイル詳細権限更新エラー:', error);
          }
        }, 150);
      }
    }
    
    // ファイル一覧画面が表示されている場合は自動更新
    const currentUrl = window.location.href;
    const isFileSection = currentUrl.includes('#files') || 
                         document.querySelector('.file-section:not([style*="display: none"])') ||
                         document.querySelector('#files:not([style*="display: none"])');
    
    if (isFileSection) {
      // ファイルナビゲーションボタンを再クリックしてリフレッシュ
      const fileNavButton = document.querySelector('nav a[href="#files"], button[data-section="files"], .nav-link[href="#files"]');
      if (fileNavButton) {
        // 少し遅延を入れてからクリック
        setTimeout(() => {
          fileNavButton.click();
        }, 300);
      } else {
        // ページ全体を軽くリフレッシュ（最終手段）
        setTimeout(() => {
          window.location.hash = '#files';
        }, 300);
      }
    }
  } catch (error) {
  }
}

// WebSocket接続状態を確認
function checkWebSocketConnection() {
  if (!permissionWebSocket || permissionWebSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  return true;
}

// デバッグ用WebSocket状態確認
window.debugWebSocket = {
  status: function() {
    if (!permissionWebSocket) {
      return "not_initialized";
    }
    
    const states = {
      0: "CONNECTING",
      1: "OPEN", 
      2: "CLOSING",
      3: "CLOSED"
    };
    
    const state = states[permissionWebSocket.readyState] || "UNKNOWN";

    return state;
  },
  
  reconnect: function(userId) {
    if (permissionWebSocket) {
      permissionWebSocket.close();
    }
    wsReconnectAttempts = 0;
    wsReconnectDelay = 1000;
    const userIdToUse = userId || 2; // デフォルトuser_id
    connectPermissionWebSocket(userIdToUse);
  },
  
  testConnection: function(userId = 2) {
    const testUrl = `${window.CONFIG?.WEBSOCKET_BASE || 'wss://tenant-system.noce-creative.com'}/ws/permissions/${userId}/`;
    const testWs = new WebSocket(testUrl);

    testWs.onopen = function() {
      testWs.close();
    };

    testWs.onerror = function(error) {
      console.error("❌ テスト接続失敗:", error);
    };

    testWs.onclose = function(event) {
      // Test connection closed
    };
  }
};

// 手動でWebSocket接続をリセット（テナント切り替え対応）
function resetWebSocketConnection() {
  if (permissionWebSocket) {
    permissionWebSocket.close();
    permissionWebSocket = null;
  }
  wsReconnectAttempts = 0;
  wsReconnectDelay = 1000;

  // テナント切り替え時は少し待ってから再接続
  setTimeout(() => {
    const userEmail = localStorage.getItem("userEmail");
    if (userEmail) {
      initWebSocketPermissionUpdates();
    }
  }, 2000);
}

// WebSocket状態をグローバルに公開（デバッグ用）
window.debugWebSocket = {
  status: () => {
    if (!permissionWebSocket) return "未接続";
    switch(permissionWebSocket.readyState) {
      case WebSocket.CONNECTING: return "接続中";
      case WebSocket.OPEN: return "接続済み";
      case WebSocket.CLOSING: return "切断中";
      case WebSocket.CLOSED: return "切断済み";
      default: return "不明";
    }
  },
  reconnect: resetWebSocketConnection,
  check: checkWebSocketConnection,
  refreshFiles: refreshFileList
};

// Dify会話中の権限変更通知
function refreshDifyPermissions() {
  try {
    // 現在会話中かどうかチェック
    const isInConversation = conversationId && conversationId.length > 0;
    
    if (isInConversation) {
      // Dify権限キャッシュをクリアする
      apiCache.clear('dify-parameters');
      apiCache.clear('filtered-documents');
      
      // 会話内に権限変更通知メッセージを表示（目立たない形で）
      const chatMessages = document.getElementById("chat-messages");
      if (chatMessages) {
        const systemNotice = document.createElement("div");
        systemNotice.className = "message system-notice";
        systemNotice.style.cssText = `
          padding: 4px 8px;
          margin: 8px 0;
          background: #f0f0f0;
          border-radius: 4px;
          font-size: 12px;
          color: #666;
          text-align: center;
        `;
        systemNotice.textContent = "ファイル権限が更新されました";
        chatMessages.appendChild(systemNotice);
        
        // 10秒後に削除
        setTimeout(() => {
          if (systemNotice.parentNode) {
            systemNotice.parentNode.removeChild(systemNotice);
          }
        }, 10000);
        
        // チャット画面を最下部にスクロール
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }
  } catch (error) {
    console.error("Dify権限更新通知エラー:", error);
  }
}

// ポーリング方式による権限更新（WebSocketフォールバック）
let pollingTimer = null;
let lastPermissionHash = null;

function initPollingPermissionUpdates() {
  // ログイン状態をチェック（テナント切り替え対応）
  const accessToken = localStorage.getItem('accessToken');
  if (!accessToken) {
    console.log('ポーリング権限チェック: ログインが必要です');
    return;
  }

  // 既存のポーリングタイマーをクリア
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  // 30秒ごとに権限状態をチェック
  pollingTimer = setInterval(async () => {
    // 各チェック時にもログイン状態を確認
    const currentToken = localStorage.getItem('accessToken');
    if (currentToken) {
      await checkPermissionUpdates();
    } else {
      console.log('ポーリング権限チェック停止: ログアウトされました');
      stopPollingPermissionUpdates();
    }
  }, 30000); // 30秒間隔

  // 初回チェック
  setTimeout(() => {
    const currentToken = localStorage.getItem('accessToken');
    if (currentToken) {
      checkPermissionUpdates();
    }
  }, 2000);
}

async function checkPermissionUpdates() {
  try {
    // テストモードではAPIコールをスキップ
    if (getConfig('APP_SETTINGS.FEATURES.SKIP_AUTH_FOR_TESTING')) {
      return;
    }

    // ログイン状態を再確認（テナント切り替え対応）
    const accessToken = localStorage.getItem('accessToken');
    if (!accessToken) {
      console.log('ポーリング権限チェック: トークンが見つかりません');
      stopPollingPermissionUpdates();
      return;
    }

    // TODO: 将来的にWorkersに権限チェックエンドポイントを実装
    console.log('🔓 テストモード: 権限チェックAPIコールをスキップ');
  } catch (error) {
    console.error("ポーリング権限チェックエラー:", error);
  }
}

function generatePermissionHash(permissionData) {
  // 権限データを文字列化してシンプルなハッシュを生成
  const dataString = JSON.stringify(permissionData.map(item => ({
    id: item.id,
    name: item.name,
    permission_level: item.permission_level
  })));
  
  // シンプルなハッシュ関数
  let hash = 0;
  for (let i = 0; i < dataString.length; i++) {
    const char = dataString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 32bit整数に変換
  }
  return hash.toString(36);
}

// ポーリングタイマーをクリア
function stopPollingPermissionUpdates() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// デバッグ機能を拡張
window.debugWebSocket.polling = {
  start: initPollingPermissionUpdates,
  stop: stopPollingPermissionUpdates,
  check: checkPermissionUpdates,
  status: () => pollingTimer ? "動作中" : "停止中"
};

// ================================
// デバッグ機能とエラー対策
// ================================

// API状態をチェックする関数
async function checkApiStatus() {
  try {
    const resp = await fetch(getConfig('ENDPOINTS.API_STATUS'), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${localStorage.getItem("accessToken") || ""}`,
        "X-API-Client": "sirusiru-chat",
        "X-Tenant-Domain": getConfig('TENANT_DOMAIN')
      }
    });
    
    if (!resp.ok) {
      console.error("API status check failed:", await resp.text());
      return false;
    }
    
    const data = await resp.json();
    
    // Dify APIの状態を確認
    const difyApiStatus = data.api_checks?.parameters?.status || "unknown";
    return difyApiStatus === "ok";
  } catch (err) {
    console.error("Error checking API status:", err);
    return false;
  }
}

// クライアントサイドのAPI呼び出しをデバッグするラッパー関数
async function debugApiCall(url, options = {}) {
  
  const startTime = performance.now();
  
  try {
    const response = await fetch(url, options);
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    
    // ステータスコードに応じたログ
    if (response.ok) {
    } else {
      console.error(`エラー: HTTP ${response.status} - ${response.statusText}`);
      
      try {
        // エラーレスポンスの中身を確認
        const errorText = await response.text();
        console.error("エラー詳細:", errorText);
        
        // JSONかどうか確認
        try {
          const errorJson = JSON.parse(errorText);
          console.error("エラーJSON:", errorJson);
        } catch (e) {
        }
      } catch (err) {
        console.error("エラーレスポンスの読み取りに失敗:", err);
      }
    }
    
    // レスポンスのクローンを作成して返す（元のレスポンスはすでに消費されている可能性がある）
    return response.clone();
  } catch (err) {
    throw err;
  }
}

// API呼び出しの改良バージョン
async function improvedApiFetch(url, options = {}) {
  // デバッグモードなら詳細なログを出力
  const isDebugMode = localStorage.getItem("debugMode") === "true";
  
  if (isDebugMode) {
    return debugApiCall(url, options);
  }
  
  // ネットワークが切断されている場合
  if (!navigator.onLine) {
    throw new Error("Network is offline");
  }
  
  // トークンの取得
  const token = localStorage.getItem("accessToken");
  if (!token && !url.includes("/login")) {
    throw new Error("No authentication token");
  }
  
  // リクエストヘッダーの設定
  const headers = {
    ...(options.headers || {}),
    "Authorization": token ? `Bearer ${token}` : "",
    "Content-Type": options.headers?.["Content-Type"] || "application/json"
  };
  
  // タイムアウト設定
  const timeout = options.timeout || 30000; // デフォルト30秒
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  // フェッチオプションの構築
  const fetchOptions = {
    ...options,
    headers,
    signal: controller.signal
  };
  
  try {
    // APIリクエスト実行
    const response = await fetch(url, fetchOptions);
    
    // ステータスコードが401（認証エラー）かつログインページでない場合
    if (response.status === 401 && !url.includes("/login")) {
      // トークンリフレッシュを試みる
      const refreshSuccess = await tryRefresh();
      
      if (refreshSuccess) {
        // 新しいトークンでリトライ
        headers.Authorization = `Bearer ${localStorage.getItem("accessToken")}`;
        return fetch(url, { ...fetchOptions, headers });
      } else {
        console.error("トークンのリフレッシュに失敗しました");
        throw new Error("Authentication failed");
      }
    }
    
    return response;
  } catch (err) {
    // タイムアウトエラー
    if (err.name === "AbortError") {
      console.error(`タイムアウト: ${timeout}ms経過`);
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    
    // その他のエラー
    console.error("API呼び出しエラー:", err);
    throw err;
  } finally {
    // タイムアウトIDをクリア
    clearTimeout(timeoutId);
  }
}


// デバッグモードの切り替え
function toggleDebugMode() {
  const currentMode = localStorage.getItem("debugMode") === "true";
  localStorage.setItem("debugMode", (!currentMode).toString());
  
  // デバッグモードが有効な場合、コンソールにヘルプメッセージを表示
  if (!currentMode) {
  }
  
  return !currentMode;
}


// 現在のキャッシュ内容を表示
function showApiCache() {
  
  if (!apiCache || !apiCache.data) {
    return;
  }
  
  const cacheEntries = [];
  apiCache.data.forEach((value, key) => {
    const ttl = apiCache.ttl.get(key);
    const remainingTime = ttl ? Math.max(0, ttl - Date.now()) : 0;
    
    cacheEntries.push({
      key,
      // valueの概要（完全な内容は大きすぎる可能性がある）
      valuePreview: typeof value === 'object' ? 
        `[Object] (${JSON.stringify(value).substring(0, 50)}...)` : 
        value,
      ttl: new Date(ttl).toLocaleTimeString(),
      remainingSecs: Math.floor(remainingTime / 1000),
      expired: Date.now() > ttl
    });
  });
  
}

/* ────────── お問い合わせ mailto リンク ────────── */
document.getElementById("contact-mail-link")?.addEventListener("click", e => {
  e.preventDefault();

  /* ① ログイン情報を取得 */
  const email   = localStorage.getItem("userEmail")        || "";
  const roles   = JSON.parse(localStorage.getItem("userRoles")||"[]").join(", ");
  const tenant  = localStorage.getItem("userTenant")       || "";
  const balance = localStorage.getItem("userTokenBalance") || "";

  /* ② 本文テンプレート */
  const body = [
    "◆ ログイン情報",
    `メールアドレス : ${email}`,
    `役職         : ${roles}`,
    `企業名       : ${tenant}`,
    `残会話数   : ${balance}`,
    "",
    "お問い合わせ内容を入力してください。原則、3営業日以内で返信します。"
  ].join("\n");

  /* ③ 件名・本文を URI エンコード (%20 でスペースを保持) */
  const subjectEnc = encodeURIComponent("SIRUSIRUからの問い合わせ");
  const bodyEnc = encodeURIComponent(body).replace(/%0A/g, "%0D%0A");

  /* ④ mailto リンクを生成してメーラーを呼び出し */
  window.location.href =
    `mailto:info@noce-creative.co.jp?subject=${subjectEnc}&body=${bodyEnc}`;
});

// ========= ファイル一覧表示関数（権限対応） =========

/**
 * ファイル一覧を表示（権限に基づいた表示制御付き）
 * @param {Array} files - ファイル一覧（権限情報付き）
 * @param {Object} knowledgeBase - 知識ベース情報
 * @param {Object} quotaInfo - クォータ情報
 */
function displayFilesList(files, knowledgeBase, quotaInfo) {
  const filesContainer = document.getElementById("files-container");
  
  if (!filesContainer) {
    console.warn("ファイル一覧表示エリアが見つかりません");
    return;
  }
  
  if (!files || files.length === 0) {
    filesContainer.innerHTML = `
      <div class="text-center text-muted py-4">
        <i class="fas fa-folder-open fa-3x mb-3"></i>
        <p>ファイルがありません</p>
        <small>選択された知識ベース "${knowledgeBase?.name || 'Unknown'}" にはファイルが登録されていません。</small>
      </div>
    `;
    return;
  }
  
  // クォータ情報の表示（存在する場合）
  let quotaHtml = '';
  if (quotaInfo) {
    const storagePercent = quotaInfo.storage_usage_percent || 0;
    const statusColor = quotaInfo.quota_status === 'exceeded' ? 'danger' : 
                       storagePercent > 80 ? 'warning' : 'success';
    
    quotaHtml = `
      <div class="alert alert-${statusColor} mb-3">
        <small>
          <i class="fas fa-database"></i> ストレージ使用率: ${storagePercent.toFixed(1)}%
          ${quotaInfo.quota_status === 'exceeded' ? '<br>⚠️ クォータを超過しています' : ''}
        </small>
      </div>
    `;
  }
  
  // Django仕様: 'none'権限のファイルは表示しない（フィルタリングを先に実行）
  const visibleFiles = files.filter(file => {
    // 複数のフィールドから権限を取得
    const permission = file.permission || file.permission_level || file.effective_permission || 'read';
    return permission !== 'none';
  });
  
  // ファイル一覧を構築（フィルタリング後のファイル数を使用）
  let htmlContent = `
    ${quotaHtml}
    <div class="mb-3">
      <h6>知識ベース: ${knowledgeBase?.name || 'Unknown'}</h6>
      <small class="text-muted">企業: ${knowledgeBase?.tenant_name || 'Unknown'} | 合計: ${visibleFiles.length}件のファイル</small>
    </div>
    <div class="list-group">
  `;
  
  if (visibleFiles.length === 0) {
    filesContainer.innerHTML = `
      <div class="text-center text-muted py-4">
        <i class="fas fa-lock fa-3x mb-3"></i>
        <p>アクセス可能なファイルがありません</p>
        <small>この知識ベース "${knowledgeBase?.name || 'Unknown'}" のファイルにアクセスする権限がありません。</small>
      </div>
    `;
    return;
  }
  
  visibleFiles.forEach(file => {
    // Django権限レベルに基づく設定を取得（複数フィールドから権限を取得）
    const filePermission = file.permission || file.permission_level || file.effective_permission || 'read';
    const permissionConfig = getFilePermissionConfig(filePermission);
    
    // Django仕様: 権限に基づいた表示制御
    const showDeleteButton = permissionConfig.canDelete;
    const showEditButton = permissionConfig.canEdit;
    const isClickableForDetail = permissionConfig.canViewDetail;
    
    const cursorStyle = isClickableForDetail ? 'cursor: pointer;' : 'cursor: default;';
    
    htmlContent += `
      <div class="list-group-item list-group-item-action file-item" 
           data-doc-id="${file.id}" 
           data-permission="${filePermission}"
           data-can-edit="${permissionConfig.canEdit}"
           data-can-delete="${permissionConfig.canDelete}"
           data-can-view="${permissionConfig.canViewDetail}"
           style="${cursorStyle}">
        <div class="d-flex justify-content-between align-items-start">
          <div class="flex-grow-1">
            <h6 class="mb-1">
              <i class="fas fa-file-alt me-2 text-muted"></i>
              ${file.name || '無題'}
            </h6>
            <p class="mb-1 text-muted small">${file.doc_form || 'テキスト'}</p>
            <small class="text-muted">
              ${file.word_count ? `${file.word_count}文字` : ''} 
              ${file.updated_at ? `• 更新: ${new Date(file.updated_at).toLocaleDateString('ja-JP')}` : ''}
            </small>
          </div>
          <div class="text-end d-flex align-items-center">
            <!-- 権限表示 -->
            <div class="me-3">
              <div class="mb-1">${permissionConfig.icon}</div>
              <small class="text-muted">${permissionConfig.label}</small>
            </div>
            <!-- アクションボタン群 (Django仕様準拠) -->
            <div class="btn-group btn-group-sm" role="group">
              ${showDeleteButton ? `
                <button class="btn btn-outline-danger delete-file-btn" 
                        data-doc-id="${file.id}" 
                        data-file-name="${file.name}"
                        title="ファイルを削除">
                  <i class="fas fa-trash"></i>
                </button>
              ` : ''}
              ${showEditButton ? `
                <button class="btn btn-outline-primary edit-file-btn" 
                        data-doc-id="${file.id}" 
                        title="ファイルを編集">
                  <i class="fas fa-edit"></i>
                </button>
              ` : ''}
              ${isClickableForDetail ? `
                <button class="btn btn-outline-info view-file-btn" 
                        data-doc-id="${file.id}" 
                        title="ファイル詳細">
                  <i class="fas fa-eye"></i>
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  });
  
  htmlContent += `</div>`;
  
  filesContainer.innerHTML = htmlContent;
  
  // Django仕様準拠のイベントリスナーを設定
  setupFileListEventListeners(filesContainer);
  
}

/**
 * Django権限レベルに基づく設定を取得
 * @param {string} permission - 権限レベル
 * @returns {Object} 権限設定オブジェクト
 */
function getFilePermissionConfig(permission) {
  switch(permission) {
    case 'none':
      return {
        icon: '<i class="fas fa-ban text-danger"></i>',
        label: 'アクセス不可',
        canViewDetail: false,
        canEdit: false,
        canDelete: false,
        canComment: false
      };
    case 'read':
      return {
        icon: '<i class="fas fa-eye text-info"></i>',
        label: '閲覧のみ',
        canViewDetail: true,
        canEdit: false,
        canDelete: false,
        canComment: false
      };
    case 'comment':
      return {
        icon: '<i class="fas fa-comment text-primary"></i>',
        label: 'コメント可能',
        canViewDetail: true,
        canEdit: false,
        canDelete: false,
        canComment: true
      };
    case 'contribute':
      return {
        icon: '<i class="fas fa-edit text-success"></i>',
        label: '編集・削除可能',
        canViewDetail: true,
        canEdit: true,
        canDelete: true,
        canComment: true
      };
    case 'inherit':
      return {
        icon: '<i class="fas fa-arrow-down text-warning"></i>',
        label: '権限継承',
        canViewDetail: true,
        canEdit: false,
        canDelete: false,
        canComment: false
      };
    default:
      return {
        icon: '<i class="fas fa-question text-muted"></i>',
        label: '権限不明',
        canViewDetail: false,
        canEdit: false,
        canDelete: false,
        canComment: false
      };
  }
}

/**
 * ファイル一覧のイベントリスナーを設定（Django仕様準拠・WebSocket連携）
 * @param {HTMLElement} container - ファイル一覧コンテナ
 */
function setupFileListEventListeners(container) {
  // ファイル詳細表示ボタン
  const viewButtons = container.querySelectorAll('.view-file-btn');
  viewButtons.forEach(button => {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const docId = button.getAttribute('data-doc-id');
      if (docId) {
        await showFileDetailWithPermission(docId);
      }
    });
  });

  // ファイル編集ボタン
  const editButtons = container.querySelectorAll('.edit-file-btn');
  editButtons.forEach(button => {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const docId = button.getAttribute('data-doc-id');
      if (docId) {
        await showFileDetailWithPermission(docId, true); // 編集モード
      }
    });
  });

  // ファイル削除ボタン
  const deleteButtons = container.querySelectorAll('.delete-file-btn');
  deleteButtons.forEach(button => {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const docId = button.getAttribute('data-doc-id');
      const fileName = button.getAttribute('data-file-name');
      
      if (docId && await confirmFileDelete(fileName || docId)) {
        await deleteFileWithPermissionCheck(docId);
      }
    });
  });

  // ファイル項目のクリック（詳細表示用 - ボタンが無い場合のフォールバック）
  const fileItems = container.querySelectorAll('.file-item');
  fileItems.forEach(item => {
    const canView = item.getAttribute('data-can-view') === 'true';
    
    item.addEventListener('click', async (e) => {
      // ボタンクリックの場合は処理しない
      if (e.target.closest('.btn')) return;
      
      const docId = item.getAttribute('data-doc-id');
      if (canView && docId) {
        await showFileDetailWithPermission(docId);
      } else if (!canView) {
        showNotification('このファイルの詳細を表示する権限がありません', 'warning');
      }
    });
  });

}

/**
 * ファイル削除確認ダイアログ
 * @param {string} fileName - ファイル名
 * @returns {boolean} - 削除を確認したか
 */
function confirmFileDelete(fileName) {
  return confirm(`「${fileName}」を削除してもよろしいですか？\n\nこの操作は元に戻せません。`);
}

/**
 * 権限チェック付きファイル削除
 * @param {string} docId - ドキュメントID
 */
async function deleteFileWithPermissionCheck(docId) {
  try {
    // 最新の権限情報を取得してチェック
    const hasDeletePermission = await checkCurrentFilePermission(docId, 'delete');
    
    if (!hasDeletePermission) {
      showNotification('このファイルを削除する権限がありません', 'error');
      return;
    }

    const response = await apiFetch(getConfig('ENDPOINTS.DOCUMENT_VIEW') ? getConfig('ENDPOINTS.DOCUMENT_VIEW')(docId) : `${API_BASE}/documents/${docId}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      showNotification('ファイルを削除しました', 'success');
      
      // ファイル一覧を自動更新（WebSocket対応）
      refreshFileList();
    } else {
      const errorData = await response.json();
      showNotification(`ファイル削除に失敗しました: ${errorData.error || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    console.error('ファイル削除エラー:', error);
    showNotification('ファイル削除中にエラーが発生しました', 'error');
  }
}

/**
 * リアルタイム権限チェック（WebSocket連携）
 * @param {string} docId - ドキュメントID
 * @param {string} action - チェックするアクション ('view', 'edit', 'delete', 'comment')
 * @returns {boolean} - アクション実行可能か
 */
async function checkCurrentFilePermission(docId, action = 'view') {
  try {
    // キャッシュバスターを使用して最新の権限情報を取得
    const cacheBuster = Date.now();
    const response = await apiFetch(getConfig('ENDPOINTS.ACCESSIBLE_KNOWLEDGE_BASES') + `?_=${cacheBuster}`);
    
    if (!response.ok) {
      console.warn('権限チェック失敗: APIエラー');
      return false;
    }

    const data = await response.json();
    
    // ファイルの現在の権限を検索
    if (data.knowledge_bases && Array.isArray(data.knowledge_bases)) {
      for (const kb of data.knowledge_bases) {
        if (kb.documents && Array.isArray(kb.documents)) {
          const doc = kb.documents.find(d => (d.document_id || d.id) === docId);
          if (doc) {
            const permission = doc.permission_level || doc.effective_permission || 'read';
            const permissionConfig = getFilePermissionConfig(permission);
            
            
            switch (action) {
              case 'view':
                return permissionConfig.canViewDetail;
              case 'edit':
                return permissionConfig.canEdit;
              case 'delete':
                return permissionConfig.canDelete;
              case 'comment':
                return permissionConfig.canComment;
              default:
                return false;
            }
          }
        }
      }
    }

    console.warn(`権限チェック: ファイル ${docId} が見つかりません`);
    return false;
  } catch (error) {
    console.error('権限チェックエラー:', error);
    return false;
  }
}

/**
 * ファイル詳細モーダル内の権限を更新（Django仕様準拠・WebSocket連携）
 * @param {string} docId - ドキュメントID
 */
async function refreshFileDetailPermissions(docId) {
  try {
    // 最新の権限情報を取得
    const currentPermission = await getCurrentFilePermissionLevel(docId);
    if (!currentPermission) {
      console.warn('ファイル詳細権限更新: 権限情報の取得に失敗');
      return;
    }

    const permissionConfig = getFilePermissionConfig(currentPermission);
    
    // モーダル内の編集ボタン群を取得
    const toggleEditBtn = document.getElementById("toggle-edit-mode-button");
    const updateFileBtn = document.getElementById("update-file-button");
    const deleteFileBtn = document.querySelector(".delete-file-btn[data-doc-id='" + docId + "']");
    
    // Django仕様: contribute権限のみ編集・削除可能
    if (toggleEditBtn) {
      toggleEditBtn.style.display = permissionConfig.canEdit ? 'inline-block' : 'none';
      toggleEditBtn.disabled = !permissionConfig.canEdit;
    }
    
    if (updateFileBtn) {
      updateFileBtn.style.display = permissionConfig.canEdit ? 'inline-block' : 'none';
      updateFileBtn.disabled = !permissionConfig.canEdit;
    }
    
    // モーダル内の削除ボタン（存在する場合）
    if (deleteFileBtn) {
      deleteFileBtn.style.display = permissionConfig.canDelete ? 'inline-block' : 'none';
      deleteFileBtn.disabled = !permissionConfig.canDelete;
    }

    // 権限状態をモーダルに表示
    const permissionStatus = document.getElementById('file-permission-status');
    if (permissionStatus) {
      permissionStatus.innerHTML = `
        <small class="text-muted">
          ${permissionConfig.icon} ${permissionConfig.label}
        </small>
      `;
    } else {
      // 権限ステータス表示がない場合は作成
      const modalHeader = document.querySelector('#file-detail-modal .modal-header');
      if (modalHeader) {
        // 既存の権限表示を削除
        const existingStatus = modalHeader.querySelector('.permission-status');
        if (existingStatus) {
          existingStatus.remove();
        }
        
        // 新しい権限表示を追加
        const statusElement = document.createElement('div');
        statusElement.className = 'permission-status ms-auto';
        statusElement.innerHTML = `
          <small class="text-muted">
            ${permissionConfig.icon} ${permissionConfig.label}
          </small>
        `;
        modalHeader.appendChild(statusElement);
      }
    }

    // 編集権限がない場合は編集モードを無効化
    if (!permissionConfig.canEdit) {
      const textarea = document.querySelector('#file-detail-modal textarea');
      if (textarea) {
        textarea.readOnly = true;
        textarea.style.backgroundColor = '#f8f9fa';
      }
      
      // 編集モードが有効な場合は無効化
      const isEditMode = document.body.classList.contains('edit-mode');
      if (isEditMode) {
        // 編集モードを無効化
        if (toggleEditBtn) {
          toggleEditBtn.click(); // 編集モードを切り替え
        }
        showNotification('編集権限が削除されました。編集モードを終了します。', 'warning');
      }
    }

  } catch (error) {
    console.error('ファイル詳細権限更新エラー:', error);
  }
}

/**
 * 現在のファイル権限レベルを取得
 * @param {string} docId - ドキュメントID
 * @returns {string|null} - 権限レベル
 */
async function getCurrentFilePermissionLevel(docId) {
  try {
    const cacheBuster = Date.now();
    const response = await apiFetch(getConfig('ENDPOINTS.ACCESSIBLE_KNOWLEDGE_BASES') + `?_=${cacheBuster}`);
    
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    if (data.knowledge_bases && Array.isArray(data.knowledge_bases)) {
      for (const kb of data.knowledge_bases) {
        if (kb.documents && Array.isArray(kb.documents)) {
          const doc = kb.documents.find(d => (d.document_id || d.id) === docId);
          if (doc) {
            return doc.permission_level || doc.effective_permission || 'read';
          }
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('権限レベル取得エラー:', error);
    return null;
  }
}

// ========= シンプルなファイル一覧取得 =========

/**
 * ファイル一覧取得（ユーザー権限ベース）
 */
async function fetchFilesList() {
  try {
    // Workers経由でDjango APIから権限フィルタリング適用済みファイル一覧を取得
    const cacheBuster = Date.now();
    const endpoint = getConfig('ENDPOINTS.FILE_LIST');

    // 認証トークンの状態を確認
    const token = localStorage.getItem("accessToken");

    const response = await apiFetch(`${endpoint}?_=${cacheBuster}`, {
      method: "GET",
      headers: {
        'X-API-Client': 'sirusiru-chat',
        'X-Tenant-Domain': getConfig('TENANT_DOMAIN')
      }
    });

    if (!response.ok) {
      console.error('❌ ファイル一覧取得失敗:', response.status);
      const errorData = await response.text();
      console.error('❌ エラー内容:', errorData);
      return [];
    }

    const data = await response.json();
    
    // Workers経由でユーザーの知識ベース権限情報を取得（キャッシュバスター付き）
    let userPermissions = {};
    try {
      const cacheBuster = Date.now();
      const permissionsResponse = await apiFetch(getConfig('ENDPOINTS.ACCESSIBLE_KNOWLEDGE_BASES') + `?_=${cacheBuster}`, {
        method: "GET"
      });
      
      if (permissionsResponse.ok) {
        const permissionsData = await permissionsResponse.json();
        
        // 権限データを処理してファイル別権限マップを作成
        if (permissionsData.knowledge_bases && Array.isArray(permissionsData.knowledge_bases)) {
          permissionsData.knowledge_bases.forEach((kb, kbIndex) => {
            
            // 知識ベース全体の権限を取得（継承権限のベースとなる）
            const basePermission = kb.permissions?.permission_level || kb.permission_level || kb.base_permission || 'read';
            
            
            if (kb.documents && Array.isArray(kb.documents)) {
              kb.documents.forEach((doc, docIndex) => {
                const docId = doc.document_id || doc.id;
                let permission = doc.permission_level || doc.effective_permission || basePermission;
                
                // 継承権限の場合は知識ベースの権限を使用
                if (permission === 'inherit' || permission === '継承') {
                  permission = basePermission;
                }
                
                userPermissions[docId] = permission;
                
              });
            } else {
              
              // documentsプロパティが別名の可能性を探る
              const possibleDocumentKeys = ['files', 'file_list', 'knowledge_documents', 'docs'];
              let foundDocuments = null;
              
              for (const key of possibleDocumentKeys) {
                if (kb[key] && Array.isArray(kb[key])) {
                  foundDocuments = kb[key];
                  break;
                }
              }
              
              if (foundDocuments) {
                foundDocuments.forEach((doc, docIndex) => {
                  const docId = doc.document_id || doc.id;
                  let permission = doc.permission_level || doc.effective_permission || basePermission;
                  
                  if (permission === 'inherit' || permission === '継承') {
                    permission = basePermission;
                  }
                  
                  userPermissions[docId] = permission;
                });
              }
            }
          });
          
        }
        
        // 権限マップが空の場合、知識ベース権限をファイルに適用
        if (Object.keys(userPermissions).length === 0 && data.data && Array.isArray(data.data)) {
          
          // 最初に見つかった知識ベースの権限を使用
          let defaultPermission = 'read';
          if (permissionsData.knowledge_bases && permissionsData.knowledge_bases.length > 0) {
            const firstKB = permissionsData.knowledge_bases.find(kb => kb.permissions?.permission_level);
            defaultPermission = firstKB?.permissions?.permission_level || 'read';
          }
          
          // 全ファイルに同じ権限を適用
          const filesList = data.files || data.data || [];
          filesList.forEach(file => {
            const fileId = file.id || file.document_id;
            if (fileId) {
              userPermissions[fileId] = defaultPermission;
            }
          });
          
        }
      } else {
      }
    } catch (permError) {
    }
    
    // 各ファイルに権限情報を追加
    // 新しいDjango API形式 (data.files) に対応
    const filesList = data.files || data.data || [];
    if (Array.isArray(filesList)) {
      const filesWithPermissions = filesList.map((file) => {
        // Django APIから直接取得した権限を優先（すでに権限フィルタリング済み）
        const fileId = file.id || file.document_id;
        
        // ファイル自体に権限情報が含まれている場合はそれを使用
        let permission = file.permission || file.permission_level || file.effective_permission;
        
        // ファイルに権限情報がない場合のみ、権限マップから取得
        if (!permission) {
          permission = userPermissions[fileId] || 'read';
        }
        
        
        return {
          ...file,
          permission: permission
        };
      });
      return filesWithPermissions;
    }
    
    // ファイル一覧が配列ではない場合のフォールバック
    return [];
  } catch (error) {
    // フォールバック: ローカル役職情報を使用
    try {
      const response = await apiFetch(getConfig('ENDPOINTS.FILE_LIST'), {
        method: "GET"
      });
      
      if (response.ok) {
        const data = await response.json();
        const userRoles = JSON.parse(localStorage.getItem("userRoles") || "[]");
        const hasAdminRole = userRoles.includes('役員') || userRoles.includes('管理者');
        
        // 新しいDjango API形式 (data.files) に対応
        const filesList = data.files || data.data || [];
        if (Array.isArray(filesList)) {
          return filesList.map((file) => {
            // Django APIからの権限情報を優先
            let permission = file.permission || file.permission_level || file.effective_permission;
            
            // 権限情報がない場合のみローカル役職から判定
            if (!permission) {
              permission = hasAdminRole ? 'contribute' : 'read';
            }
            
            
            return {
              ...file,
              permission: permission
            };
          });
        }
      }
    } catch (fallbackError) {
    }
    
    return [];
  }
}


