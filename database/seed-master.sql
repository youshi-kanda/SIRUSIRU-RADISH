-- SIRUSIRU Radish - 初期マスタデータ

-- 保険会社マスタ
INSERT OR REPLACE INTO insurance_companies (id, company_code, company_name, display_order) VALUES
(1, 'NANAIRO', 'なないろ生命', 1),
(2, 'HANASAKU', 'はなさく生命', 2),
(3, 'NEOFIRST', 'ネオファースト生命', 3);

-- なないろ生命の商品マスタ
INSERT OR REPLACE INTO insurance_products (company_id, product_code, product_name, product_category, display_order) VALUES
(1, 'MAIN', '主契約', '主契約', 1),
(1, 'DEATH', '死亡特約', '特約', 2),
(1, 'P_EXEMPT', 'P免特約', '特約', 3),
(1, 'CANCER', 'がん特約', '特約', 4),
(1, 'ADVANCED', '先進医療特約', '特約', 5),
(1, 'THREE_MAJOR', '三大疾病特約', '特約', 6),
(1, 'EIGHT_MAJOR', '八大疾病特約', '特約', 7),
(1, 'FRACTURE', '骨折特約', '特約', 8),
(1, 'WOMEN', '女性特約', '特約', 9),
(1, 'SEVEN', 'なないろセブン', '特約', 10),
(1, 'THREE', 'なないろスリー', '特約', 11);

-- システムメタデータ
INSERT OR REPLACE INTO system_metadata (key, value) VALUES
('schema_version', '2.0'),
('last_migration', datetime('now')),
('vector_model', 'text-embedding-3-small'),
('vector_dimensions', '1536');
