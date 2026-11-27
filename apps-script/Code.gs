/**
 * «Спільний час» — сервер (Google Apps Script + Google Таблиця).
 * Сторінка живе на GitHub Pages і звертається сюди через POST-запити.
 *
 * ВСТАНОВЛЕННЯ — див. README.md у репозиторії. Коротко:
 *  1. script.google.com → Новий проєкт → встав цей код → 💾.
 *  2. Вибери функцію setup → ▶ Виконати → дозволь доступ (таблиці й надсилання пошти).
 *     Буде створено таблицю «Спільний час — дані» у твоєму Google Drive.
 *  3. Розгорнути → Нове розгортання → Веб-додаток. Виконувати як: Я. Доступ: Усі.
 *  4. URL веб-додатка (…/exec) встав у config.js на сайті (API_URL).
 *
 * ПІСЛЯ ЗМІН У КОДІ: Розгорнути → Керувати розгортаннями → ✏️ → Нова версія → Розгорнути.
 * Листи учасникам надсилаються з пошти власника скрипта (ліміт Google: ~100 адрес на день).
 */

var POLLS = 'Polls';
var RESP = 'Responses';
var POLL_COLS = ['id', 'adminToken', 'title', 'organizer', 'duration', 'dateFrom', 'dateTo', 'hourFrom', 'hourTo',
  'skipWeekends', 'deadline', 'tz', 'expected', 'createdAt', 'closedAt', 'final', 'deadlineText', 'days', 'invitees', 'siteUrl', 'repeat'];
var RESP_COLS = ['pollId', 'id', 'name', 'cells', 'source', 'updatedAt', 'slotsCount'];
var EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
var UK_WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
var UK_WD_FULL = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
var NTH_TEXT = { '1': '1-й', '2': '2-й', '3': '3-й', '4': '4-й', '-1': 'останній' };
var UK_MON = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
var CELL_RE = /^\d{4}-\d{2}-\d{2}\|\d{1,4}$/;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------- точки входу ---------------- */

/** Запусти один раз вручну: створює (або знаходить) таблицю з даними. */
function setup() {
  var ss = ss_();
  sheet_(POLLS, POLL_COLS);
  sheet_(RESP, RESP_COLS);
  Logger.log('Таблиця з даними: ' + ss.getUrl());
  Logger.log('Можна надіслати ще листів сьогодні: ' + MailApp.getRemainingDailyQuota());
}

function doGet() {
  return json_({ ok: true, service: 'spilnyi-chas' });
}

/** Усі запити сайту: POST text/plain з JSON {action, payload}. Відповідь — JSON (помилка в полі error). */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = api(String(body.action || ''), body.payload || {});
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return json_(out);
}

function api(action, payload) {
  var b = payload || {};
  b.action = action;
  return handle_(b);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(b) {
  switch (b.action) {
    case 'health': return { ok: true };
    case 'create': return withLock_(function () { return createPoll_(b); });
    case 'get': return getPoll_(b.id);
    case 'respond': return withLock_(function () { return respond_(b); });
    case 'check': return adminInfo_(adminCheck_(b).poll);
    case 'remind': return remind_(b);
    case 'close': return withLock_(function () { return close_(b); });
    case 'finalize': return withLock_(function () { return finalize_(b); });
  }
  throw new Error('Невідома дія');
}

/* ---------------- дії ---------------- */

function createPoll_(b) {
  var d = validatePoll_(b);
  d.id = uid_(8);
  d.adminToken = uid_(16);
  d.createdAt = Date.now();
  d.closedAt = '';
  d.final = null;
  var sh = sheet_(POLLS, POLL_COLS);
  writeRow_(sh, sh.getLastRow() + 1, POLL_COLS, pollToRow_(d));
  var mail = sendMails_(d, d.invitees, false);
  return { id: d.id, adminToken: d.adminToken, mailed: mail.sent, mailFailed: mail.failed };
}

function getPoll_(id) {
  var found = findPoll_(id);
  var p = found.poll;
  delete p.adminToken;
  // пошта учасників не показується нікому; сторінці потрібні лише імена для особистих посилань
  p.invites = (p.invitees || []).map(function (i) { return { id: i.id, name: i.name }; });
  delete p.invitees;
  var responses = readAll_(sheet_(RESP, RESP_COLS), RESP_COLS)
    .filter(function (r) { return r.obj.pollId === p.id; })
    .map(function (r) { return respFromRow_(r.obj); });
  return { poll: p, responses: responses };
}

function respond_(b) {
  var p = findPoll_(b.id).poll;
  if (isClosed_(p)) throw new Error('Збір відповідей уже завершено');
  var name = str_(b.name, 60);
  if (!name) throw new Error("Вкажіть ім'я");
  var cells = [];
  var seen = {};
  (Array.isArray(b.cells) ? b.cells : []).forEach(function (c) {
    if (typeof c === 'string' && CELL_RE.test(c) && !seen[c] && cells.length < 3000) { seen[c] = 1; cells.push(c); }
  });
  var source = b.source === 'google' ? 'google' : 'manual';
  var rid = str_(b.responseId, 20);

  var sh = sheet_(RESP, RESP_COLS);
  var rows = readAll_(sh, RESP_COLS).filter(function (r) { return r.obj.pollId === p.id; });
  var hit = null;
  if (rid) hit = rows.filter(function (r) { return r.obj.id === rid; })[0] || null;
  if (!hit) hit = rows.filter(function (r) { return norm_(r.obj.name) === norm_(name); })[0] || null;

  var rec = { pollId: p.id, id: hit ? hit.obj.id : uid_(10), name: name, cells: cells, source: source, updatedAt: Date.now() };
  writeRow_(sh, hit ? hit.row : sh.getLastRow() + 1, RESP_COLS, [
    rec.pollId, rec.id, rec.name, JSON.stringify(rec.cells), rec.source, String(rec.updatedAt), String(cells.length)
  ]);
  return { id: rec.id };
}

function close_(b) {
  var found = adminCheck_(b);
  if (!found.poll.closedAt) found.poll.closedAt = Date.now();
  savePoll_(found);
  return { ok: true };
}

function finalize_(b) {
  var found = adminCheck_(b);
  var p = found.poll;
  var f = b.final;
  if (f === null) {
    p.final = null;
  } else {
    var start = Number(f && f.start);
    var link = str_(f && f.link, 300);
    if (!f || !DATE_RE.test(String(f.date)) || start !== Math.floor(start) || start < 0 || start >= 1440) throw new Error('Некоректний слот');
    if (link && !/^https?:\/\//i.test(link)) throw new Error('Некоректне посилання');
    p.final = { date: String(f.date), start: start, link: link };
    if (!p.closedAt) p.closedAt = Date.now();
  }
  savePoll_(found);
  return { ok: true };
}

/* ---------------- пошта ---------------- */

/** Для панелі організатора: у кого з учасників є пошта (самі адреси не віддаємо). */
function adminInfo_(p) {
  return { ok: true, emailNames: (p.invitees || []).filter(function (i) { return i.email; }).map(function (i) { return i.name; }) };
}

/** Нагадування поштою тим, хто ще не відповів. */
function remind_(b) {
  var p = adminCheck_(b).poll;
  if (isClosed_(p)) throw new Error('Збір відповідей уже завершено');
  var answered = {};
  readAll_(sheet_(RESP, RESP_COLS), RESP_COLS).forEach(function (r) { if (r.obj.pollId === p.id) answered[norm_(r.obj.name)] = 1; });
  var todo = (p.invitees || []).filter(function (i) { return i.email && !answered[norm_(i.name)]; });
  var mail = sendMails_(p, todo, true);
  return { ok: true, mailed: mail.sent, mailFailed: mail.failed };
}

function sendMails_(p, people, isReminder) {
  var res = { sent: 0, failed: [] };
  people = (people || []).filter(function (i) { return i.email; });
  if (!people.length) return res;
  var base = p.siteUrl + '?p=' + encodeURIComponent(p.id);
  var quota = MailApp.getRemainingDailyQuota();
  people.forEach(function (i) {
    if (res.sent >= quota) { res.failed.push(i.email); return; }
    try {
      var link = base + (i.id ? '&i=' + encodeURIComponent(i.id) : '');
      var m = inviteMail_(p, i.name, link, isReminder);
      MailApp.sendEmail({ to: i.email, subject: m.subject, body: m.text, htmlBody: m.html, name: 'Спільний час' });
      res.sent++;
    } catch (e) {
      res.failed.push(i.email);
    }
  });
  return res;
}

/** Стандартний лист-запрошення (або нагадування). */
function inviteMail_(p, name, link, isReminder) {
  var dur = durText_(p.duration);
  var days = p.repeat ? repeatText_(p.repeat) : (p.days && p.days.length ? p.days : [p.dateFrom]).map(dayText_).join(', ');
  var hours = pad_(p.hourFrom) + ':00–' + pad_(p.hourTo) + ':00';
  var until = deadlineText_(p.deadline, p.tz);
  var subject = (isReminder ? 'Нагадування: оберіть час для дзвінка «' : 'Оберіть зручний час для дзвінка «') + p.title + '»';
  var intro = isReminder
    ? 'Нагадуємо: ви ще не відмітили, коли вам зручно провести дзвінок «' + p.title + '». Голосування завершиться ' + until + '.'
    : p.organizer + ' запрошує вас на дзвінок «' + p.title + '» і пропонує обрати зручний час. Це займе близько хвилини.';

  var text = 'Привіт, ' + name + '!\n\n' + intro + '\n\n'
    + 'Тривалість: ' + dur + '\nМожливі дні: ' + days + '\nГодини: ' + hours + ' (за Києвом)\nВідповісти до: ' + until + '\n\n'
    + 'Обрати зручний час: ' + link + '\n'
    + 'На сторінці можна одним кліком підключити Google Calendar, і вільні слоти позначаться самі.\n\n'
    + 'Коли всі відповідять, організатор обере час, який підходить найбільшій кількості людей.\n\n'
    + 'Лист надіслано через «Спільний час». Організатор: ' + p.organizer + '.';

  var row = function (k, v) { return '<tr><td style="padding:4px 12px 4px 0;color:#5d6670;white-space:nowrap;vertical-align:top">' + k + '</td><td style="padding:4px 0;color:#15191e">' + esc_(v) + '</td></tr>'; };
  var html = '<div style="background:#f6f7f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dde2e7;border-radius:14px;padding:24px">'
    + '<div style="font-size:13px;color:#0f8a6c;font-weight:bold;margin-bottom:12px">⏱ Спільний час</div>'
    + '<p style="font-size:16px;color:#15191e;margin:0 0 12px">Привіт, ' + esc_(name) + '!</p>'
    + '<p style="font-size:15px;line-height:1.5;color:#15191e;margin:0 0 16px">' + esc_(intro) + '</p>'
    + '<table style="font-size:14px;border-collapse:collapse;margin:0 0 20px">'
    + row('Дзвінок', p.title) + row('Тривалість', dur) + row('Можливі дні', days) + row('Години', hours + ' (за Києвом)') + row('Відповісти до', until)
    + '</table>'
    + '<a href="' + esc_(link) + '" style="display:inline-block;background:#0f8a6c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px">Обрати зручний час</a>'
    + '<p style="font-size:13px;line-height:1.5;color:#5d6670;margin:16px 0 0">💡 На сторінці можна одним кліком підключити Google Calendar, і вільні слоти позначаться самі.</p>'
    + '<p style="font-size:13px;line-height:1.5;color:#5d6670;margin:12px 0 0">Коли всі відповідять, організатор обере час, який підходить найбільшій кількості людей. Якщо кнопка не працює, відкрийте посилання: <a href="' + esc_(link) + '" style="color:#0f8a6c">' + esc_(link) + '</a></p>'
    + '</div><p style="text-align:center;font-size:12px;color:#8a939c;margin:12px 0 0">Лист надіслано через «Спільний час». Організатор: ' + esc_(p.organizer) + '.</p></div>';
  return { subject: subject, text: text, html: html };
}

/** «Регулярно, щотижня: вівторок або четвер» */
function repeatText_(r) {
  var how = r.freq === 'month' ? 'щомісяця, ' + NTH_TEXT[String(r.nth)] + ' тиждень' : r.interval === 2 ? 'раз на 2 тижні' : 'щотижня';
  return 'регулярно (' + how + '): ' + r.wds.map(function (w) { return UK_WD_FULL[w]; }).join(' або ');
}

function durText_(m) {
  var h = Math.floor(m / 60), r = m % 60;
  if (!h) return m + ' хв';
  return h + ' год' + (r ? ' ' + r + ' хв' : '');
}
function dayText_(d) {
  var x = new Date(d + 'T12:00:00Z');
  return UK_WD[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + UK_MON[x.getUTCMonth()];
}
function deadlineText_(ms, tz) {
  var s = Utilities.formatDate(new Date(Number(ms)), tz || 'Europe/Kyiv', 'yyyy-MM-dd HH:mm');
  return dayText_(s.slice(0, 10)) + ' о ' + s.slice(11);
}
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ---------------- валідація ---------------- */

function validatePoll_(b) {
  var d = {
    title: str_(b.title, 120), organizer: str_(b.organizer, 60),
    duration: Number(b.duration), hourFrom: Number(b.hourFrom), hourTo: Number(b.hourTo), skipWeekends: false,
    deadline: Number(b.deadline), tz: str_(b.tz || 'Europe/Kyiv', 64)
  };
  var seen = {};
  d.days = (Array.isArray(b.days) ? b.days : []).map(function (x) { return String(x); })
    .filter(function (x) { if (!DATE_RE.test(x) || seen[x]) return false; seen[x] = 1; return true; }).sort();
  if (!d.days.length) throw new Error('Оберіть хоча б один день');
  if (d.days.length > 31) throw new Error('Можна обрати до 31 дня');
  d.dateFrom = d.days[0];
  d.dateTo = d.days[d.days.length - 1];
  var names = {};
  d.invitees = [];
  (Array.isArray(b.invitees) ? b.invitees : []).slice(0, 30).forEach(function (i) {
    var email = str_(i && i.email, 120);
    var name = str_(i && i.name, 60) || email.split('@')[0];
    if (!name) return;
    if (email && !EMAIL_RE.test(email)) throw new Error('Некоректна пошта: ' + email);
    if (names[norm_(name)]) return;
    names[norm_(name)] = 1;
    d.invitees.push({ id: uid_(6), name: name, email: email });
  });
  d.expected = d.invitees.map(function (i) { return i.name; });
  d.repeat = null;
  if (b.repeat) {
    var r = b.repeat, wds = (Array.isArray(r.wds) ? r.wds : []).map(Number).filter(function (w) { return w >= 0 && w <= 6 && w === Math.floor(w); });
    if (!wds.length) throw new Error('Оберіть хоча б один день тижня');
    if (r.freq === 'month') {
      var nth = Number(r.nth);
      if ([1, 2, 3, 4, -1].indexOf(nth) < 0) throw new Error('Некоректний тиждень місяця');
      d.repeat = { freq: 'month', interval: 1, nth: nth, wds: wds };
    } else {
      d.repeat = { freq: 'week', interval: Number(r.interval) === 2 ? 2 : 1, wds: wds };
    }
  }
  d.siteUrl = str_(b.siteUrl, 300);
  if (!/^https?:\/\/[^\s"'<>]+$/.test(d.siteUrl)) throw new Error('Некоректна адреса сайту');
  if (!d.title) throw new Error('Вкажіть тему дзвінка');
  if (!d.organizer) throw new Error("Вкажіть ім'я організатора");
  if (d.duration !== Math.floor(d.duration) || d.duration < 15 || d.duration > 480) throw new Error('Тривалість має бути від 15 хвилин до 8 годин');
  if (d.hourFrom !== Math.floor(d.hourFrom) || d.hourTo !== Math.floor(d.hourTo) || d.hourFrom < 0 || d.hourTo > 24 || d.hourTo <= d.hourFrom) throw new Error('Перевірте години');
  if (d.duration > (d.hourTo - d.hourFrom) * 60) throw new Error('Дзвінок довший, ніж вікно годин');
  if (!isFinite(d.deadline) || d.deadline < Date.now() || d.deadline > Date.now() + 30 * 864e5) throw new Error('Некоректний дедлайн');
  return d;
}

function adminCheck_(b) {
  var found = findPoll_(b.id);
  if (!b.adminToken || String(b.adminToken) !== found.poll.adminToken) throw new Error('Немає доступу');
  return found;
}

/* ---------------- таблиця ---------------- */

/** Таблиця з даними: прив'язана до скрипта, або створена функцією setup (ID у властивостях скрипта). */
var ssCache_ = null;
function ss_() {
  if (ssCache_) return ssCache_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) return (ssCache_ = SpreadsheetApp.openById(id));
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  ssCache_ = active || SpreadsheetApp.create('Спільний час — дані');
  props.setProperty('SHEET_ID', ssCache_.getId());
  return ssCache_;
}

function sheet_(name, cols) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setNumberFormat('@').setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getRange(1, 1, 1, cols.length).getValues()[0].join('|') !== cols.join('|')) {
    // таблицю створено старою версією: дописуємо нові назви колонок
    sh.getRange(1, 1, 1, cols.length).setNumberFormat('@').setValues([cols]).setFontWeight('bold');
  }
  return sh;
}

/** Повертає [{row, obj}] для всіх рядків з даними. */
function readAll_(sh, cols) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (!String(values[i][0] || '')) continue;
    var obj = {};
    for (var c = 0; c < cols.length; c++) obj[cols[c]] = String(values[i][c] === null || values[i][c] === undefined ? '' : values[i][c]);
    out.push({ row: i + 2, obj: obj });
  }
  return out;
}

/** Пише рядок як простий текст, щоб Таблиця не перетворювала дати й числа. */
function writeRow_(sh, row, cols, values) {
  sh.getRange(row, 1, 1, cols.length).setNumberFormat('@').setValues([values.map(function (v) { return v === null || v === undefined ? '' : String(v); })]);
}

function findPoll_(id) {
  id = String(id || '');
  var rows = readAll_(sheet_(POLLS, POLL_COLS), POLL_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].obj.id === id) return { row: rows[i].row, poll: pollFromRow_(rows[i].obj) };
  }
  throw new Error('Дзвінок не знайдено');
}

function savePoll_(found) {
  writeRow_(sheet_(POLLS, POLL_COLS), found.row, POLL_COLS, pollToRow_(found.poll));
}

function pollToRow_(p) {
  return [p.id, p.adminToken, p.title, p.organizer, p.duration, p.dateFrom, p.dateTo, p.hourFrom, p.hourTo,
    p.skipWeekends ? 'TRUE' : 'FALSE', p.deadline, p.tz, JSON.stringify(p.expected || []), p.createdAt,
    p.closedAt || '', p.final ? JSON.stringify(p.final) : '',
    Utilities.formatDate(new Date(Number(p.deadline)), p.tz || 'Europe/Kyiv', 'yyyy-MM-dd HH:mm'),
    JSON.stringify(p.days || []), JSON.stringify(p.invitees || []), p.siteUrl || '', p.repeat ? JSON.stringify(p.repeat) : ''];
}

function pollFromRow_(o) {
  return {
    id: o.id, adminToken: o.adminToken, title: o.title, organizer: o.organizer,
    duration: Number(o.duration), dateFrom: o.dateFrom, dateTo: o.dateTo,
    hourFrom: Number(o.hourFrom), hourTo: Number(o.hourTo), skipWeekends: o.skipWeekends === 'TRUE',
    deadline: Number(o.deadline), tz: o.tz || 'Europe/Kyiv', expected: parse_(o.expected, []),
    createdAt: Number(o.createdAt), closedAt: o.closedAt ? Number(o.closedAt) : null, final: parse_(o.final, null),
    days: parse_(o.days, []), invitees: parse_(o.invitees, []), siteUrl: o.siteUrl, repeat: parse_(o.repeat, null)
  };
}

function respFromRow_(o) {
  return { id: o.id, name: o.name, cells: parse_(o.cells, []), source: o.source, updatedAt: Number(o.updatedAt) };
}

/* ---------------- утиліти ---------------- */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}


function isClosed_(p) { return !!p.closedAt || Date.now() >= p.deadline; }
function str_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max); }
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function parse_(s, dflt) { if (!s) return dflt; try { return JSON.parse(s); } catch (e) { return dflt; } }

function uid_(n) {
  var alph = 'abcdefghijkmnpqrstuvwxyz23456789';
  var out = '';
  while (out.length < n) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    for (var i = 0; i + 1 < hex.length && out.length < n; i += 2) out += alph[parseInt(hex.substr(i, 2), 16) % 32];
  }
  return out;
}
