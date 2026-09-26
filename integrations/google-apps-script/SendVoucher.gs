/**
 * MinimalERP for Google Workspace — emailing a voucher to its party, from YOUR Gmail.
 *
 * The ERP (its post-voucher function, never the browser) POSTs a mail here: the party's addresses, the subject, the message as text and
 * as the formatted HTML the ERP built, and the files you attached (the voucher's PDF, perhaps signed with your DSC, and supporting documents). It is sent with MailApp, so
 * it goes from your own account and shows in your Gmail's Sent folder. Nothing is kept here.
 *
 * Deploy once per company, in that company's own Google account: Deploy › New deployment › type "Web app" › Execute as: Me › Who has
 * access: Anyone. Enter the /exec address it gives, and this script's MAIL_SECRET property, in the ERP under that company's
 * Utilities › Company Gmail. A request without the secret is refused.
 */
function doPost(e) {
  var answer;
  try {
    var mail = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!mail.secret || mail.secret !== prop_('MAIL_SECRET', true)) return json_({ ok: false, message: 'not permitted' });
    if (!mail.to || !mail.to.length || !mail.subject) return json_({ ok: false, message: 'no address or subject' });
    var options = { htmlBody: mail.html || undefined, name: mail.fromName || 'MinimalERP' };
    var files = (mail.attachments || []).concat(mail.attachment ? [mail.attachment] : []);
    if (files.length) {
      options.attachments = files.map(function (f) {
        return Utilities.newBlob(Utilities.base64Decode(f.base64), mimeOf_(f.name), f.name || 'document.pdf');
      });
    }
    MailApp.sendEmail(mail.to.join(','), mail.subject, mail.text || '', options);
    answer = { ok: true };
  } catch (err) {
    answer = { ok: false, message: String((err && err.message) || err) };
  }
  return json_(answer);
}

/** The file's type, from its name: what the party's mail program opens it with. */
function mimeOf_(name) {
  var ext = String(name || '').toLowerCase().split('.').pop();
  return {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', csv: 'text/csv', zip: 'application/zip',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }[ext] || 'application/octet-stream';
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
