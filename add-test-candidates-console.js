// Paste this into browser console (F12 > Console) on the team-dashboard page
// It will create 5 test candidates

(async function addTestCandidates() {
  const token = localStorage.getItem('allstars_token');
  if (!token) {
    console.error('❌ No auth token found');
    return;
  }

  const candidates = [
    { 'Имя': 'Алёна Петрова', 'Telegram': '@alena_petrova', 'Актуальный статус кандидата (Hr)': 'Работает', 'OnlyFans / Fansly': 'OnlyFans', 'Опыт, мес.': '6' },
    { 'Имя': 'Мария Смирнова', 'Telegram': '@maria_smirnova', 'Актуальный статус кандидата (Hr)': 'Работает', 'OnlyFans / Fansly': 'Fansly', 'Опыт, мес.': '3' },
    { 'Имя': 'Виктория Кузнецова', 'Telegram': '@victoria_kuzn', 'Актуальный статус кандидата (Hr)': 'Ждет тест', 'OnlyFans / Fansly': 'OnlyFans', 'Опыт, мес.': '0' },
    { 'Имя': 'Анастасия Соколова', 'Telegram': '@anastasia_sok', 'Актуальный статус кандидата (Hr)': 'Ожидание старта', 'OnlyFans / Fansly': 'Fansly', 'Опыт, мес.': '2' },
    { 'Имя': 'Елена Волкова', 'Telegram': '@elena_volkova', 'Актуальный статус кандидата (Hr)': 'Верификация', 'OnlyFans / Fansly': 'OnlyFans', 'Опыт, мес.': '1' }
  ];

  console.log('🔄 Adding 5 test candidates...\n');

  for (const candidate of candidates) {
    try {
      const response = await fetch('/api/team-member', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ values: candidate })
      });

      const data = await response.json();

      if (response.ok) {
        console.log(`✓ Added: ${candidate['Имя']} (${candidate['Актуальный статус кандидата (Hr)']})`);
      } else {
        console.warn(`⚠ Error adding ${candidate['Имя']}: ${data.error}`);
      }
    } catch (err) {
      console.error(`❌ ${candidate['Имя']}: ${err.message}`);
    }
  }

  console.log('\n✅ Done! Refresh the page to see the new candidates.');
})();
