-- Get agency_id for salarisdan@gmail.com user
WITH user_agency AS (
  SELECT agency_id FROM users WHERE email = 'salarisdan@gmail.com' LIMIT 1
)
INSERT INTO candidates (
  name, tg, telegram, status, platform, experience_months, agency_id, created_at, updated_at
)
SELECT 
  name, tg, tg, status, platform, exp, ua.agency_id, NOW(), NOW()
FROM (VALUES
  ('Алёна Петрова', '@alena_petrova', 'Работает', 'OnlyFans', 6),
  ('Мария Смирнова', '@maria_smirnova', 'Работает', 'Fansly', 3),
  ('Виктория Кузнецова', '@victoria_kuzn', 'Ждет тест', 'OnlyFans', 0),
  ('Анастасия Соколова', '@anastasia_sok', 'Ожидание старта', 'Fansly', 2),
  ('Елена Волкова', '@elena_volkova', 'Верификация', 'OnlyFans', 1)
) AS t(name, tg, status, platform, exp)
CROSS JOIN user_agency ua
RETURNING id, name, status, platform;
