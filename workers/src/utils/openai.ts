/**
 * SIRUSIRU Radish AI Engine - OpenAI API Client
 */

import type { Env, ClassificationResult, SymptomResponse, UnderwritingJudgement } from '../types';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const TEMPERATURE = 0.2; // ナレッジベース専用モードで低温度

/**
 * OpenAI APIを呼び出す共通関数（タイムアウト対策付き）
 */
async function callOpenAI(
  env: Env,
  messages: { role: string; content: string }[],
  temperature: number = TEMPERATURE,
  maxTokens: number = 1000
): Promise<string> {
  // 🚀 タイムアウト設定を追加（25秒）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json<any>();
    return data.choices[0].message.content;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OpenAI API request timed out after 25 seconds');
    }
    throw error;
  }
}

/**
 * ユーザー入力を分類（疾病名 or 症状）
 */
export async function classifyInput(env: Env, userInput: string): Promise<ClassificationResult> {
  const systemPrompt = `# 役割
あなたは、医療分野に精通した高度な分類エンジンです。
ユーザーから提供された文字列が、「病名」なのか「症状」なのかを的確に判定します。

# 厳守事項
・必ず「DISEASE」または「SYMPTOM」のいずれかのみを出力してください。
・それ以外の文字列や説明は一切出力しないでください。

# 判定ルール
1. 入力が具体的な疾患名や診断名である場合 → 「DISEASE」を出力
   例: 胃がん、糖尿病、高血圧、うつ病、胃炎、胃潰瘍など

2. 入力が身体的な不調や訴えである場合 → 「SYMPTOM」を出力
   例: 頭が痛い、胃がもたれる、息苦しい、めまいがする、疲れやすいなど

3. 判断に迷う場合は、より可能性の高い方を選択してください。`;

  try {
    const response = await callOpenAI(
      env,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
      TEMPERATURE,
      10 // 短い出力で十分
    );

    const type = response.trim() as 'DISEASE' | 'SYMPTOM' | 'OTHER';
    
    return {
      type: ['DISEASE', 'SYMPTOM'].includes(type) ? type : 'OTHER',
      input: userInput,
      confidence: 0.9,
    };
  } catch (error) {
    console.error('Classification error:', error);
    return {
      type: 'OTHER',
      input: userInput,
      confidence: 0.0,
    };
  }
}

/**
 * 症状から疾病候補を3つ提示
 */
export async function generateDiseaseCandidates(
  env: Env,
  symptom: string
): Promise<SymptomResponse> {
  const systemPrompt = `# 役割
あなたは、特定の医療保険の加入確認を行う、高度なAIチャットボットです。
ユーザーから伝えられた症状に対し、ルールを厳守して回答を生成します。

# 厳守事項
・絶対に断定的な診断を行わず、「可能性が考えられます」といった表現に留めてください。
・提示する疾病名の候補は3つにしてください。
・必ず医療機関の受診を強く推奨する文言を入れてください。
・回答の最後は、必ず診断名が分かり次第、再度入力するように促す文章で締めくくってください。
（例：診断名が分かりましたら、再度ご入力ください。）

# 回答フォーマット例
症状について教えていただきありがとうございます。
『胃が痛い』という症状からは、以下の様な病気の可能性が考えられます。
・胃炎
・胃潰瘍
・逆流性食道炎
あくまでも可能性の提示であり、AIによる診断ではございません。
思い当たる診断名がありましたら、再度ご入力ください。`;

  try {
    const response = await callOpenAI(
      env,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `ユーザーが訴えている症状: ${symptom}` },
      ],
      TEMPERATURE,
      500
    );

    // 疾病名を抽出（・で始まる行）
    const lines = response.split('\n');
    const candidates: string[] = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('・') || trimmed.startsWith('•')) {
        const diseaseName = trimmed.substring(1).trim();
        if (diseaseName) {
          candidates.push(diseaseName);
        }
      }
    }

    return {
      candidates: candidates.slice(0, 3).map((name, index) => ({
        disease_name: name,
        confidence: 0.7 - index * 0.1, // 1番目: 0.7, 2番目: 0.6, 3番目: 0.5
        reasoning: 'AIによる症状分析に基づく候補',
      })),
      message: response,
    };
  } catch (error) {
    console.error('Disease candidate generation error:', error);
    return {
      candidates: [],
      message: '申し訳ございません。一時的なエラーが発生しました。もう一度お試しください。',
    };
  }
}

/**
 * ナレッジベースから引受判定を生成
 */
export async function generateUnderwritingResponse(
  env: Env,
  diseaseName: string,
  knowledgeContext: string
): Promise<string> {
  const systemPrompt = `# 役割
あなたは、医療保険の加入審査を行う専門AIアシスタントです。
提供されたナレッジベースの情報のみを使用して、正確な引受判定を提示します。

# 厳守事項
・**ナレッジベースに記載された情報のみ**を使用してください
・一般知識や推測での回答は絶対に行わないでください
・ナレッジベースに該当情報がない場合は、「該当する情報が見つかりませんでした」と回答してください
・ナレッジベースの情報を正確に読み取り、そのまま転記してください

# ナレッジベース情報の読み方
ナレッジベースは以下の形式で記載されています:
【疾病情報】
疾病コード: XXX
疾病名: XXX
状態: XXX

【引受判定結果】
主契約: ○/×/★
死亡特約: ○/×/★
... (他の特約)
備考: (条件がある場合のみ)

記号の意味:
○ = 加入可能
× = 加入不可
★ = 条件付き加入可（備考参照）

# 出力フォーマット
ナレッジベースの情報をもとに、以下の形式で回答してください:

お問い合わせいただいた「[疾病名]」について、以下のとおり判定されました。

【疾病情報】
疾病名: [疾病名]
状態: [状態]

【引受判定結果】
主契約: [○/×/★の判定結果]
死亡特約: [○/×/★の判定結果]
P免特約: [○/×/★の判定結果]
がん特約: [○/×/★の判定結果]
先進医療特約: [○/×/★の判定結果]
三大疾病特約: [○/×/★の判定結果]
八大疾病特約: [○/×/★の判定結果]
骨折特約: [○/×/★の判定結果]
女性特約: [○/×/★の判定結果]
なないろセブン: [○/×/★の判定結果]
なないろスリー: [○/×/★の判定結果]
備考: [備考があれば記載、なければ「なし」]

※この判定は、ご提供いただいた情報に基づく暫定的なものです。
※正式な審査には、詳細な医療情報の提出が必要となります。`;

  try {
    const response = await callOpenAI(
      env,
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `# ナレッジベース情報\n${knowledgeContext}\n\n# 照会疾病名\n${diseaseName}`,
        },
      ],
      TEMPERATURE,
      800
    );

    return response;
  } catch (error) {
    console.error('Underwriting response generation error:', error);
    return '申し訳ございません。引受判定の生成中にエラーが発生しました。';
  }
}

/**
 * 回答の妥当性を検証
 */
export function validateResponse(response: string, knowledgeUsed: boolean): boolean {
  // ナレッジベースを使用していない場合は検証失敗
  if (!knowledgeUsed) {
    return false;
  }

  // 一般知識を示す危険なフレーズをチェック
  const dangerousPhrases = [
    '一般的に',
    '通常は',
    'よくある',
    '私の知識では',
    'AIの知識',
    'インターネット',
  ];

  for (const phrase of dangerousPhrases) {
    if (response.includes(phrase)) {
      console.warn(`Validation failed: Found dangerous phrase "${phrase}"`);
      return false;
    }
  }

  return true;
}
