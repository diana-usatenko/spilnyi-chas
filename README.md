# Спільний час

Простий спосіб знайти час для дзвінка в спільноті без нескінченних голосувань.

1. **Організатор** обирає дні, години, тривалість і дедлайн голосування та вказує учасників з поштою.
2. Учасники отримують **лист з особистим посиланням**, одним кліком **підключають Google Calendar**
   (вільні слоти позначаються самі) або відмічають час вручну.
3. Організатор бачить **топ-3 слоти**, нагадує тим, хто не відповів (поштою чи у WhatsApp), і обирає час.

## Як це влаштовано

| Частина | Де живе | Що робить |
|---|---|---|
| `index.html`, `privacy.html`, `config.js` | GitHub Pages (безкоштовно) | сторінки для організатора й учасників |
| `apps-script/Code.gs` | Google Apps Script (безкоштовно) | зберігає дані в Google Таблиці, надсилає листи |
| Google Calendar | браузер учасника | читає лише «зайнято / вільно» (`calendar.freebusy`) |

Поки `config.js` не заповнено, сайт працює в **демо-режимі**: дані лишаються в браузері, а «календар» вигаданий.

---

## Встановлення

### Крок 1. Сайт на GitHub Pages (2 хв)
**Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**
За хвилину сайт буде доступний за адресою `https://<твій-логін>.github.io/spilnyi-chas/`.

### Крок 2. Сервер на Apps Script (5 хв)
1. Відкрий [script.google.com](https://script.google.com) → **Новий проєкт** → назви «Спільний час».
2. Встав увесь вміст `apps-script/Code.gs` замість заглушки → 💾.
3. Угорі вибери функцію **`setup`** → **▶ Виконати** → дозволь доступ
   (якщо Google напише «додаток не перевірено»: **Додатково → Перейти до проєкту**).
   У твоєму Google Drive з'явиться таблиця «Спільний час — дані».
4. **Розгорнути → Нове розгортання → ⚙ Веб-додаток.** Виконувати як: **Я**. Доступ: **Усі**. → **Розгорнути**.
5. Скопіюй URL веб-додатка (закінчується на `/exec`) і встав у `config.js` → `API_URL`.

Після кожної зміни `Code.gs`: **Розгорнути → Керувати розгортаннями → ✏️ → Нова версія → Розгорнути** (URL не зміниться).

### Крок 3. Кнопка «Підключити Google Calendar» (20 хв)
1. Відкрий [console.cloud.google.com](https://console.cloud.google.com) → створи проєкт «Spilnyi chas».
2. **APIs & Services → Library →** знайди **Google Calendar API → Enable**.
3. **APIs & Services → OAuth consent screen** (або **Google Auth Platform → Branding**):
   - User type: **External**
   - App name: **Spilnyi chas**, support email: твоя пошта
   - App domain: Home page `https://<логін>.github.io/spilnyi-chas/`,
     Privacy policy `https://<логін>.github.io/spilnyi-chas/privacy.html`
   - Authorized domain: `<логін>.github.io`
   - **Data access / Scopes → Add:** `https://www.googleapis.com/auth/calendar.freebusy` (лише його!)
4. **Clients (Credentials) → Create OAuth client ID → Web application.**
   Authorized JavaScript origins: `https://<логін>.github.io` (без шляху і без `/` в кінці).
5. Скопіюй **Client ID** (`…apps.googleusercontent.com`) у `config.js` → `GOOGLE_CLIENT_ID`.
6. **Audience → Publish app** (перевести з Testing у **In production**). Без перевірки Google
   кнопка вже працює для перших 100 людей, але показує попередження «додаток не перевірено».

### Крок 4. Перевірка Google (щоб прибрати попередження)
1. У `privacy.html` заміни `[КОНТАКТНА ПОШТА]` і `[CONTACT EMAIL]` на свою пошту для зв'язку.
2. Підтверди, що сайт твій: [Google Search Console](https://search.google.com/search-console) →
   Add property → URL prefix `https://<логін>.github.io/spilnyi-chas/` → спосіб «HTML-файл»:
   скачай файл і поклади його в корінь цього репозиторію.
3. Запиши коротке відео (1–2 хв) і завантаж на YouTube як «Доступ за посиланням»:
   - відкрити сайт → створити дзвінок → відкрити посилання учасника;
   - натиснути «Підключити Google Calendar», показати вікно згоди Google (видно адресу і назву);
   - показати, що вільні слоти позначились, і пояснити: «доступ лише freebusy, щоб автоматично
     позначити вільний час; назви подій не читаються й нічого не зберігається».
4. **Google Auth Platform → Verification Center → Submit for verification.** У полі
   «How will the scopes be used» можна написати:
   > The app reads only the free/busy information of the user's primary calendar, in the user's browser,
   > for the dates chosen by the call organizer, to pre-select the user's available time slots.
   > Event details are never accessed and free/busy data is not stored.
5. Розгляд триває від кількох днів до кількох тижнів. Поки він триває, усе працює з попередженням.

---

## Для розробки
- `index.html` — увесь інтерфейс; алгоритм підбору слотів: `rankSlots()`.
- `apps-script/Code.gs` — API (`doPost`, дії `create`, `get`, `respond`, `check`, `remind`, `close`, `finalize`).
- Дані в таблиці: вкладки `Polls` і `Responses`.
