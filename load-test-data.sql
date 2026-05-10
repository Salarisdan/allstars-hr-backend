-- SQL script to add test candidates for the team dashboard
-- Run this in your PostgreSQL database

-- Add 5 test candidates to the agency (assuming agency_id = 1)
INSERT INTO candidates (name, tg, telegram, status, platform, experience_months, agency_id, created_at, updated_at)
VALUES
  ('Алёна Петрова', '@alena_petrova', '@alena_petrova', 'Работает', 'OnlyFans', 6, 1, NOW(), NOW()),
  ('Мария Смирнова', '@maria_smirnova', '@maria_smirnova', 'Работает', 'Fansly', 3, 1, NOW(), NOW()),
  ('Виктория Кузнецова', '@victoria_kuzn', '@victoria_kuzn', 'Ждет тест', 'OnlyFans', 0, 1, NOW(), NOW()),
  ('Анастасия Соколова', '@anastasia_sok', '@anastasia_sok', 'Ожидание старта', 'Fansly', 2, 1, NOW(), NOW()),
  ('Елена Волкова', '@elena_volkova', '@elena_volkova', 'Верификация', 'OnlyFans', 1, 1, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- Verify insert
SELECT status, COUNT(*) as cnt FROM candidates WHERE agency_id = 1 GROUP BY status ORDER BY status;
