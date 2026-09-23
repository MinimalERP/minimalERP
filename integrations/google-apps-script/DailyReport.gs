/**
 * The daily report (ADR-0023): every morning at 8, the ERP's figures by mail — to REPORT_TO only — and, if REPORT_SHEET_ID is set, into
 * a Google Sheet: the "Daily" tab gets a row per figure, the "Due items" tab a row per customer order line that is late or due within
 * the week (due date, customer PO, customer, item, pending quantity, order, status).
 *
 * It reads the ERP, never the mailbox. Run installDailyReport() once from the editor to start it; removeDailyReport() stops it.
 */

function sendDailyReport() {
  var answer = erpCall_('post-voucher', { action: 'digest', companyId: companyId_() });
  var to = prop_('REPORT_TO', true);
  if (!answer.ok) {
    MailApp.sendEmail({
      to: to,
      subject: 'MinimalERP daily report could not be made',
      htmlBody: 'The ERP said: ' + (answer.issues || []).map(function (i) { return escape_(i.message); }).join('; '),
    });
    return;
  }
  var v = answer.value;
  MailApp.sendEmail({ to: to, subject: v.subject, htmlBody: v.html, name: 'MinimalERP' });

  var sheetId = prop_('REPORT_SHEET_ID', false);
  if (!sheetId) return;
  var book = SpreadsheetApp.openById(sheetId);
  appendRows_(book, 'Daily', ['Date', 'Figure', 'Value'], v.sheetRows);
  appendRows_(book, 'Due items', ['Report date', 'Due date', 'Cust PO', 'Customer', 'Item', 'Pending', 'Order', 'Status'], v.dueItemRows);
}

function appendRows_(book, name, header, rows) {
  var sheet = book.getSheetByName(name) || book.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  if (!rows || rows.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/** Starts the 8 o'clock report (India time, from appsscript.json). Safe to run twice. */
function installDailyReport() {
  removeDailyReport();
  ScriptApp.newTrigger('sendDailyReport').timeBased().everyDays(1).atHour(8).create();
}

function removeDailyReport() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sendDailyReport'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}
