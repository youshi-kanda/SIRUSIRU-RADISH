#!/usr/bin/env node
/**
 * CSVナレッジをベクトル化してD1にインポートするスクリプト
 * 
 * 使い方:
 * node scripts/import-csv-knowledge.js
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// CSVを構造化テキストに変換
function convertCSVToText(rows) {
  const chunks = [];
  
  for (const row of rows) {
    const text = `
【疾病情報】
疾病コード: ${row.疾病コード}
疾病名: ${row.疾病名}
状態: ${row.状態}

【引受判定結果】
主契約: ${formatResult(row.主契約)}
死亡特約: ${formatResult(row.死亡特約)}
P免特約: ${formatResult(row.P免特約)}
がん特約: ${formatResult(row.がん特約)}
先進医療特約: ${formatResult(row.先進医療特約)}
三大疾病特約: ${formatResult(row.三大疾病特約)}
八大疾病特約: ${formatResult(row.八大疾病特約)}
骨折特約: ${formatResult(row.骨折特約)}
女性特約: ${formatResult(row.女性特約)}
なないろセブン: ${formatResult(row.なないろセブン)}
なないろスリー: ${formatResult(row.なないろスリー)}

${row.備考 ? `【備考】\n${row.備考}\n` : ''}
---
`.trim();
    
    chunks.push(text);
  }
  
  return chunks;
}

// 記号を日本語に変換
function formatResult(symbol) {
  switch (symbol) {
    case '○': return '加入可能';
    case '×': return '加入不可';
    case '★': return '条件付き加入可（備考参照）';
    default: return symbol;
  }
}

// OpenAI Embeddings APIでベクトル化
async function createEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  
  return response.data[0].embedding;
}

// D1にインポート用のSQLを生成
async function generateImportSQL(
  csvPath,
  companyId,
  sourceFile
) {
  console.log(`📄 Processing: ${csvPath}`);
  
  const fileContent = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(fileContent, { 
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
  
  console.log(`   Found ${records.length} rows`);
  
  const textChunks = convertCSVToText(records);
  const sqls = [];
  
  for (let i = 0; i < textChunks.length; i++) {
    const chunk = textChunks[i];
    
    try {
      // ベクトル化（API制限対策で1秒待機）
      if (i > 0 && i % 10 === 0) {
        console.log(`   Vectorizing... ${i}/${textChunks.length}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const embedding = await createEmbedding(chunk);
      
      const sql = `
INSERT INTO knowledge_vectors (
  company_id, source_file, source_type, chunk_index, 
  chunk_text, embedding, metadata
) VALUES (
  ${companyId},
  '${sourceFile}',
  'csv',
  ${i},
  '${chunk.replace(/'/g, "''")}',
  '${JSON.stringify(embedding)}',
  '{}'
);

INSERT INTO knowledge_fts (chunk_text, source_file)
VALUES (
  '${chunk.replace(/'/g, "''")}',
  '${sourceFile}'
);`.trim();
      
      sqls.push(sql);
      
    } catch (error) {
      console.error(`   ❌ Error at row ${i}:`, error);
    }
  }
  
  console.log(`   ✅ Generated ${sqls.length} SQL statements\n`);
  return sqls;
}

// メイン処理
async function main() {
  console.log('🚀 SIRUSIRU Radish - CSV Knowledge Import\n');
  
  const dataDir = path.join(process.cwd(), 'data', 'raw', 'なないろメディアカル礎');
  const csvFiles = ['礎１.csv', '礎２.csv', '礎３.csv'];
  
  let allSQLs = [];
  
  for (const file of csvFiles) {
    const csvPath = path.join(dataDir, file);
    const sqls = await generateImportSQL(csvPath, 1, file);
    allSQLs = allSQLs.concat(sqls);
  }
  
  // SQLファイルに出力
  const outputPath = path.join(process.cwd(), 'database', 'seed-vectors.sql');
  fs.writeFileSync(outputPath, allSQLs.join('\n\n'));
  
  console.log(`\n✅ Import completed!`);
  console.log(`   Total records: ${allSQLs.length}`);
  console.log(`   Output: ${outputPath}`);
  console.log(`\n📌 Next step: Run the following command to import to D1:`);
  console.log(`   npx wrangler d1 execute radish-knowledge --file=database/seed-vectors.sql\n`);
}

main().catch(console.error);
