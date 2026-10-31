/**
 * Mail Tracker – standalone Gmail add-on (no Google Sheet).
 * All data lives in the backend (Postgres). Set BACKEND_URL below.
 */
var BACKEND_URL = 'YOUR_RENDER_URL'; // no trailing slash

var GREEN = '#188038';
var RED = '#d93025';
var GREY = '#5f6368';

// ---------- helpers ----------
function api_(method, path, payload) {
  var opts = {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() },
    muteHttpExceptions: true
  };
  if (payload) opts.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(BACKEND_URL + path, opts);
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Backend ' + code + ': ' + res.getContentText().slice(0, 160));
  return JSON.parse(res.getContentText());
}

function fmt_(ms) {
  if (!ms) return '—';
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'd MMM, h:mm a');
}

function short_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function notify_(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text)).build();
}

function errorCard_(title, err) {
  var msg = String(err.message || err);
  var hint = /401/.test(msg)
    ? 'Sign-in check failed. The backend\'s ADDON_AUDIENCE setting does not match this add-on.'
    : 'Check your connection and try again.';
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(title))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        '<font color="' + RED + '"><b>Something went wrong</b></font><br>' + hint + '<br><br><i>' + msg + '</i>'))
      .addWidget(CardService.newTextButton().setText('Try again')
        .setOnClickAction(CardService.newAction().setFunctionName('refresh_'))))
    .build();
}

function goHome_() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(dashboardCard_()))
    .build();
}

// ---------- dashboard ----------
function onHomepage() { return dashboardCard_(); }
function onMessageOpen() { return dashboardCard_(); }

function dashboardCard_() {
  var data;
  try { data = api_('get', '/api/emails'); }
  catch (err) { return errorCard_('Mail Tracker', err); }

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Mail Tracker')
      .setSubtitle('See who opened your emails'));

  var s = data.summary;
  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newDecoratedText()
      .setText('<b>' + s.emails + '</b> emails tracked  ·  <b>' + s.opens + '</b> opens')
      .setWrapText(true)
      .setStartIcon(CardService.newIconImage().setIcon(CardService.Icon.DESCRIPTION))));

  var list = CardService.newCardSection().setHeader('Recent emails');
  if (!data.emails.length) {
    list.addWidget(CardService.newTextParagraph().setText(
      '<b>No tracked emails yet.</b><br>1. Click <b>Compose</b>.<br>2. Open the Mail Tracker icon in the compose window.<br>3. Press <b>Insert open tracking</b>, then send.'));
  }
  data.emails.forEach(function (e) {
    var title = e.subject || (e.recipients && e.recipients[0]) || '(untitled)';
    var status = e.opens > 0
      ? '<font color="' + GREEN + '"><b>Opened ' + e.opens + '×</b></font>  ·  last ' + fmt_(e.lastOpenAt)
      : '<font color="' + GREY + '">Not opened yet</font>';
    list.addWidget(CardService.newDecoratedText()
      .setTopLabel(fmt_(e.createdAt) + (e.recipients && e.recipients.length ? '  ·  to ' + short_(e.recipients[0], 28) : ''))
      .setText('<b>' + short_(title, 60).replace(/[<>&]/g, '') + '</b>')
      .setStartIcon(CardService.newIconImage().setIcon(
        e.opens > 0 ? CardService.Icon.EMAIL : CardService.Icon.CLOCK))
      .setWrapText(true)
      .setOnClickAction(CardService.newAction().setFunctionName('openDetail_')
        .setParameters({ id: e.id })));
    list.addWidget(CardService.newTextParagraph().setText(status));
    list.addWidget(CardService.newDivider());
  });
  card.addSection(list);

  card.addSection(CardService.newCardSection().setHeader('Data')
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton().setText('Refresh')
        .setOnClickAction(CardService.newAction().setFunctionName('refresh_')))
      .addButton(CardService.newTextButton().setText('Export emails')
        .setOnClickAction(CardService.newAction().setFunctionName('exportCsv_').setParameters({ kind: 'emails' })))
      .addButton(CardService.newTextButton().setText('Export opens')
        .setOnClickAction(CardService.newAction().setFunctionName('exportCsv_').setParameters({ kind: 'opens' }))))
    .addWidget(CardService.newTextButton().setText('Delete all my data')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor(RED)
      .setOnClickAction(CardService.newAction().setFunctionName('confirmDelete_').setParameters({ scope: 'all' }))));

  return card.build();
}

function refresh_() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(dashboardCard_())).build();
}

// ---------- email detail ----------
function openDetail_(e) {
  var id = e.parameters.id;
  var d;
  try { d = api_('get', '/api/emails/' + id); }
  catch (err) { return notify_('Could not load: ' + err.message); }

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle(short_(d.subject || (d.recipients && d.recipients[0]) || 'Tracked email', 40))
      .setSubtitle('Sent ' + fmt_(d.createdAt)));

  var stats = CardService.newCardSection().setHeader('Summary')
    .addWidget(CardService.newDecoratedText().setTopLabel('Opens').setText('<b>' + d.opens + '</b>')
      .setBottomLabel('Last opened: ' + fmt_(d.lastOpenAt)));
  if (d.recipients && d.recipients.length) {
    stats.addWidget(CardService.newDecoratedText().setTopLabel('Recipients').setWrapText(true)
      .setText(d.recipients.join(', ').replace(/[<>&]/g, '')));
  }
  card.addSection(stats);

  var act = CardService.newCardSection().setHeader('Activity');
  if (!d.events || !d.events.length) {
    act.addWidget(CardService.newTextParagraph().setText('No activity yet.'));
  } else {
    d.events.forEach(function (ev) {
      var via = ev.client === 'google-proxy' ? 'Gmail image proxy'
        : ev.client === 'apple-or-proxy' ? 'mail proxy' : 'direct';
      act.addWidget(CardService.newDecoratedText()
        .setStartIcon(CardService.newIconImage().setIcon(
          ev.type === 'click' ? CardService.Icon.BOOKMARK : CardService.Icon.EMAIL))
        .setText(ev.type === 'click' ? 'Clicked a link' : 'Opened')
        .setBottomLabel(fmt_(ev.at) + (ev.type === 'open' ? '  ·  ' + via : '')));
    });
    act.addWidget(CardService.newTextParagraph().setText(
      '<font color="' + GREY + '"><i>Gmail and Apple Mail load images through proxies, so an "open" can be the mail app, not the person.</i></font>'));
  }
  card.addSection(act);

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newTextButton().setText('Delete this email\'s data')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor(RED)
      .setOnClickAction(CardService.newAction().setFunctionName('confirmDelete_')
        .setParameters({ scope: 'one', id: id }))));

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card.build())).build();
}

// ---------- delete (with confirmation) ----------
function confirmDelete_(e) {
  var scope = e.parameters.scope;
  var msg = scope === 'all'
    ? '<b>Delete ALL tracking data?</b><br>Every tracked email, link and activity record will be removed. Pixels already sent will stop counting. This cannot be undone.'
    : '<b>Delete this email\'s tracking data?</b><br>Its pixel and links will stop working and its activity will be removed. This cannot be undone.';
  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Please confirm'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(msg))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton().setText('Yes, delete')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor(RED)
          .setOnClickAction(CardService.newAction().setFunctionName('doDelete_').setParameters(e.parameters)))
        .addButton(CardService.newTextButton().setText('Cancel')
          .setOnClickAction(CardService.newAction().setFunctionName('cancel_')))))
    .build();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card)).build();
}

function cancel_() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popCard()).build();
}

function doDelete_(e) {
  try {
    if (e.parameters.scope === 'all') api_('delete', '/api/me');
    else api_('delete', '/api/emails/' + e.parameters.id);
  } catch (err) { return notify_('Delete failed: ' + err.message); }
  return goHome_();
}

// ---------- export ----------
function exportCsv_(e) {
  try {
    var r = api_('post', '/api/export-link', { kind: e.parameters.kind, tz: Session.getScriptTimeZone() });
    return CardService.newActionResponseBuilder()
      .setOpenLink(CardService.newOpenLink().setUrl(r.url)
        .setOpenAs(CardService.OpenAs.FULL_SIZE)
        .setOnClose(CardService.OnClose.NOTHING))
      .build();
  } catch (err) { return notify_('Export failed: ' + err.message); }
}

// ---------- compose ----------
function onComposeOpen(e) {
  // One tracking id per compose card, shared by the pixel and every tracked link.
  var id = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  var p = { id: id };

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Track this email')
      .setSubtitle('Know when it is opened'));

  var s1 = CardService.newCardSection().setHeader('1. Name it (optional)')
    .addWidget(CardService.newTextInput().setFieldName('label')
      .setTitle('Label shown in your dashboard')
      .setHint('e.g. "Quote for Acme". Blank uses the recipient.'));
  card.addSection(s1);

  var s2 = CardService.newCardSection().setHeader('2. Track opens')
    .addWidget(CardService.newTextParagraph().setText(
      'Adds an invisible 1-pixel image at the end of your message.'))
    .addWidget(CardService.newTextButton().setText('Insert open tracking')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('insertPixel_').setParameters(p)));
  card.addSection(s2);

  card.addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(
    '<font color="' + GREY + '"><i>Insert it once per email. Sending to several people gives one shared count; send separately to see who opened. Tell recipients you use read tracking where required by law.</i></font>')));
  return card.build();
}

function draftRecipients_(e) {
  var d = (e && e.draftMetadata) || {};
  return [].concat(d.toRecipients || [], d.ccRecipients || []);
}

function ensureEmail_(e) {
  var f = e.formInput || {};
  var rec = draftRecipients_(e);
  return api_('post', '/api/emails', {
    id: e.parameters.id,
    subject: (f.label || '').trim(),
    recipients: rec
  });
}

function insertHtml_(html) {
  return CardService.newUpdateDraftActionResponseBuilder()
    .setUpdateDraftBodyAction(CardService.newUpdateDraftBodyAction()
      .addUpdateContent(html, CardService.ContentType.MUTABLE_HTML)
      .setUpdateType(CardService.UpdateDraftBodyType.INSERT_AT_END))
    .build();
}

function insertPixel_(e) {
  try {
    var t = ensureEmail_(e);
    return insertHtml_('<img src="' + t.pixelUrl + '" width="1" height="1" alt="" style="display:none;border:0">');
  } catch (err) { return notify_('Error: ' + err.message); }
}
