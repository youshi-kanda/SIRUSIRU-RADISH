-- SIRUSIRU Radish Knowledge Database - Sample Data
-- サンプル疾病データの投入

-- ===================================
-- 胃がん関連
-- ===================================
INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U001',
    '胃がん',
    '治療中',
    '加入不可',
    '加入不可',
    '加入不可',
    '加入不可',
    '治療終了後5年経過で再審査可能',
    '疾病コード: U001; 疾病名: 胃がん; 状態: 治療中; 主契約: 加入不可; 医療特約: 加入不可; がん特約: 加入不可; 収入保障特約: 加入不可; 備考: 治療終了後5年経過で再審査可能'
);

INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U002',
    '胃がん',
    '寛解（5年以上経過）',
    '条件付き加入可',
    '部位不担保（胃・消化器系）',
    '加入不可',
    '条件付き加入可',
    '定期的な検査結果の提出が必要',
    '疾病コード: U002; 疾病名: 胃がん; 状態: 寛解（5年以上経過）; 主契約: 条件付き加入可; 医療特約: 部位不担保（胃・消化器系）; がん特約: 加入不可; 収入保障特約: 条件付き加入可; 備考: 定期的な検査結果の提出が必要'
);

-- ===================================
-- 糖尿病関連
-- ===================================
INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U003',
    '糖尿病',
    '治療中（合併症なし）',
    '条件付き加入可',
    '条件付き加入可',
    '加入可',
    '条件付き加入可',
    'HbA1c 7.0%以下であること',
    '疾病コード: U003; 疾病名: 糖尿病; 状態: 治療中（合併症なし）; 主契約: 条件付き加入可; 医療特約: 条件付き加入可; がん特約: 加入可; 収入保障特約: 条件付き加入可; 備考: HbA1c 7.0%以下であること'
);

INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U004',
    '糖尿病',
    '治療中（合併症あり）',
    '加入不可',
    '加入不可',
    '条件付き加入可',
    '加入不可',
    '網膜症・腎症・神経障害のいずれかがある場合',
    '疾病コード: U004; 疾病名: 糖尿病; 状態: 治療中（合併症あり）; 主契約: 加入不可; 医療特約: 加入不可; がん特約: 条件付き加入可; 収入保障特約: 加入不可; 備考: 網膜症・腎症・神経障害のいずれかがある場合'
);

-- ===================================
-- 高血圧関連
-- ===================================
INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U005',
    '高血圧',
    '服薬コントロール良好',
    '加入可',
    '加入可',
    '加入可',
    '加入可',
    '血圧140/90未満であること',
    '疾病コード: U005; 疾病名: 高血圧; 状態: 服薬コントロール良好; 主契約: 加入可; 医療特約: 加入可; がん特約: 加入可; 収入保障特約: 加入可; 備考: 血圧140/90未満であること'
);

INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U006',
    '高血圧',
    'コントロール不良',
    '条件付き加入可',
    '部位不担保（心血管系）',
    '加入可',
    '条件付き加入可',
    '血圧160/100以上の場合は加入不可',
    '疾病コード: U006; 疾病名: 高血圧; 状態: コントロール不良; 主契約: 条件付き加入可; 医療特約: 部位不担保（心血管系）; がん特約: 加入可; 収入保障特約: 条件付き加入可; 備考: 血圧160/100以上の場合は加入不可'
);

-- ===================================
-- うつ病関連
-- ===================================
INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U007',
    'うつ病',
    '治療中',
    '加入不可',
    '加入不可',
    '加入可',
    '加入不可',
    '完治後2年経過で再審査可能',
    '疾病コード: U007; 疾病名: うつ病; 状態: 治療中; 主契約: 加入不可; 医療特約: 加入不可; がん特約: 加入可; 収入保障特約: 加入不可; 備考: 完治後2年経過で再審査可能'
);

INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U008',
    'うつ病',
    '完治（2年以上経過）',
    '条件付き加入可',
    '条件付き加入可',
    '加入可',
    '条件付き加入可',
    '再発歴がないことが条件',
    '疾病コード: U008; 疾病名: うつ病; 状態: 完治（2年以上経過）; 主契約: 条件付き加入可; 医療特約: 条件付き加入可; がん特約: 加入可; 収入保障特約: 条件付き加入可; 備考: 再発歴がないことが条件'
);

-- ===================================
-- 胃炎・胃潰瘍関連
-- ===================================
INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U009',
    '胃炎',
    '治療中',
    '加入可',
    '部位不担保（胃）',
    '加入可',
    '加入可',
    '慢性胃炎の場合、治療終了後1年で不担保解除',
    '疾病コード: U009; 疾病名: 胃炎; 状態: 治療中; 主契約: 加入可; 医療特約: 部位不担保（胃）; がん特約: 加入可; 収入保障特約: 加入可; 備考: 慢性胃炎の場合、治療終了後1年で不担保解除'
);

INSERT INTO knowledge (
    disease_code, 
    disease_name, 
    condition, 
    main_contract, 
    medical_rider, 
    cancer_rider, 
    income_rider, 
    remarks,
    content_full
) VALUES (
    'U010',
    '胃潰瘍',
    '治療中',
    '条件付き加入可',
    '部位不担保（胃・十二指腸）',
    '加入可',
    '加入可',
    '治療終了後6ヶ月で不担保解除可能',
    '疾病コード: U010; 疾病名: 胃潰瘍; 状態: 治療中; 主契約: 条件付き加入可; 医療特約: 部位不担保（胃・十二指腸）; がん特約: 加入可; 収入保障特約: 加入可; 備考: 治療終了後6ヶ月で不担保解除可能'
);

-- ===================================
-- 統計情報の更新
-- ===================================
INSERT OR REPLACE INTO system_metadata (key, value) 
VALUES ('total_diseases', (SELECT COUNT(*) FROM knowledge));

INSERT OR REPLACE INTO system_metadata (key, value) 
VALUES ('last_seed', datetime('now'));
