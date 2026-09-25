/**
 * MinimalERP for Google Workspace — emailing a voucher to its party, from YOUR Gmail.
 *
 * The ERP (its post-voucher function, never the browser) POSTs a mail here: the party's addresses, the subject, the message as text and
 * as the formatted HTML the ERP built, and the PDF you attached (for example one you signed with your DSC). It is sent with MailApp, so
 * it goes from your own account and shows in your Gmail's Sent folder. Nothing is kept here.
 *
 * Deploy once: Deploy › New deployment › type "Web app" › Execute as: Me › Who has access: Anyone. The /exec address it gives is the
 * ERP's MAIL_SCRIPT_URL. Script property MAIL_SECRET must equal the ERP's MAIL_SCRIPT_SECRET: a request without it is refused.
 */
function doPost(e) {
  var answer;
  try {
    var mail = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!mail.secret || mail.secret !== prop_('MAIL_SECRET', true)) return json_({ ok: false, message: 'not permitted' });
    if (!mail.to || !mail.to.length || !mail.subject) return json_({ ok: false, message: 'no address or subject' });
    var options = { htmlBody: mail.html || undefined, name: mail.fromName || 'MinimalERP' };
    if (mail.attachment && mail.attachment.base64) {
      options.attachments = [Utilities.newBlob(Utilities.base64Decode(mail.attachment.base64), 'application/pdf', mail.attachment.name || 'document.pdf')];
    }
    MailApp.sendEmail(mail.to.join(','), mail.subject, mail.text || '', options);
    answer = { ok: true };
  } catch (err) {
    answer = { ok: false, message: String((err && err.message) || err) };
  }
  return json_(answer);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
