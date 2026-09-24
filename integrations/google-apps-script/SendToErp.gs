/**
 * The Gmail side panel: "Send to ERP" (ADR-0023). Nothing is read until a button is pressed, and then only the mail that is open —
 * the add-on asks for access to the current message only, never the mailbox. The document goes to the ERP's `intake` function, which
 * reads it with Gemini and puts a PROPOSAL in the AI Inbox; nothing is posted until someone accepts it in the ERP.
 *
 * Which mails were already sent is remembered in YOUR Google account (user properties), not in the ERP, so sending one twice asks first.
 */

var KINDS_ = [
  { kind: 'salesOrder', label: 'Sales Order', hint: "a customer's PO" },
  { kind: 'purchase', label: 'Purchase Bill', hint: "a supplier's invoice" },
  { kind: 'sales', label: 'Sales Invoice', hint: 'goods to invoice to a customer' },
  { kind: 'receipt', label: 'Receipt', hint: "a customer's payment advice" },
  { kind: 'payment', label: 'Payment', hint: 'a payment we made to a supplier' },
  // read by the ERP's fixed rule from the PDF itself — no Gemini, so it is there in seconds; an advice the rule does not know is not guessed
  { kind: 'receipt', label: 'Eclipse Receipt', hint: "Eclipse Combustion's remittance advice (PDF)", rule: 'remittance' },
];
var READABLE_ = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
var MAX_BYTES_ = 10 * 1024 * 1024;
var BODY_ = '__body__';

/** Contextual trigger: a mail was opened. Shows what can be sent, and the buttons. Reads the attachment list, not their content. */
function onGmailMessageOpen(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  var message = GmailApp.getMessageById(e.gmail.messageId);
  var files = readableAttachments_(message);
  var section = CardService.newCardSection();

  var sent = sentBefore_(e.gmail.messageId);
  if (sent) section.addWidget(CardService.newDecoratedText().setText('Already sent to the ERP as ' + sent.label + ' on ' + sent.at + '.').setWrapText(true));

  var choice = CardService.newSelectionInput().setType(CardService.SelectionInputType.RADIO_BUTTON).setFieldName('source').setTitle('What to send');
  files.forEach(function (f, i) {
    choice.addItem(f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)', String(i), i === 0);
  });
  choice.addItem('The mail text', BODY_, files.length === 0);
  section.addWidget(choice);

  KINDS_.forEach(function (k) {
    section.addWidget(
      CardService.newTextButton()
        .setText('Send to ERP → ' + k.label)
        .setOnClickAction(CardService.newAction().setFunctionName('onSend').setParameters({ kind: k.kind, label: k.label, rule: k.rule || '' })),
    );
  });
  section.addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">It arrives in the ERP’s AI Inbox as a proposal. Nothing is posted until you accept it there.</font>'));

  return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Send to MinimalERP')).addSection(section).build();
}

function onSend(e) {
  var kind = e.parameters.kind;
  var label = e.parameters.label;
  var rule = e.parameters.rule || '';
  var messageId = e.gmail.messageId;
  var already = sentBefore_(messageId);
  if (already && e.parameters.confirmed !== 'yes') return confirmCard_(e, already);

  var t0 = Date.now();
  var lap = function (what) { console.log(what + ' after ' + (Date.now() - t0) + ' ms'); };
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  var message = GmailApp.getMessageById(messageId);
  var files = readableAttachments_(message);
  lap('mail opened, ' + files.length + ' readable attachment(s)');
  // what was chosen on the card — carried through the "send again?" card too; nothing chosen: the first PDF/image, else the text
  var source = (e.formInput && e.formInput.source) || e.parameters.source || (files.length > 0 ? '0' : BODY_);
  var document;
  if (source === BODY_) {
    document = { text: message.getPlainBody().slice(0, 200000) };
  } else {
    var f = files[Number(source)];
    if (!f) return notify_('That attachment cannot be read: send a PDF or an image.');
    if (f.size > MAX_BYTES_) return notify_('That file is larger than 10 MB.');
    if (rule && f.blob.getContentType() !== 'application/pdf') return notify_('Choose the remittance advice PDF.');
    document = { mimeType: f.blob.getContentType(), base64: Utilities.base64Encode(f.blob.getBytes()) };
  }
  lap('document ready (' + (source === BODY_ ? 'mail text' : files[Number(source)].name) + ')');

  // background: the ERP answers at once and reads the document afterwards (Gmail gives this button only ~30 seconds)
  if (rule && source === BODY_) return notify_('Choose the remittance advice PDF, not the mail text.');
  var request = {
    background: true,
    kind: kind,
    companyId: companyId_(),
    document: document,
    mail: { subject: message.getSubject().slice(0, 200), from: message.getFrom().slice(0, 200) },
  };
  if (rule) request.rule = rule;
  var answer = erpCall_('intake', request);
  lap('ERP answered ' + (answer.ok ? 'ok' : JSON.stringify(answer.issues)));
  if (!answer.ok) return resultCard_('Not sent', (answer.issues || []).map(function (i) { return i.message; }), true);

  remember_(messageId, label);
  var v = answer.value;
  if (v.background && rule) {
    return resultCard_('Sent to the ERP', ['The ERP reads it by its own rule (no Gemini): it will be in the AI Inbox as a Receipt in a few seconds.', 'If it is not an Eclipse remittance advice, or its rows do not add up, a line there will say so.'], false);
  }
  if (v.background) {
    return resultCard_('Sent to the ERP', ['It is being read now and will be in the AI Inbox (Transactions › AI Inbox) as a ' + label + ' in about a minute.', 'If Gemini is too busy, a line there will say so: then send the mail again.'], false);
  }
  var lines = ['Waiting in the AI Inbox as a ' + label + (v.party ? ' for ' + v.party : '') + '.'];
  if (v.notes && v.notes.length) lines.push('To check when you open it:');
  return resultCard_('Sent to the ERP', lines.concat(v.notes || []), false);
}

function readableAttachments_(message) {
  return message
    .getAttachments({ includeInlineImages: false })
    .filter(function (a) { return READABLE_.indexOf(a.getContentType()) >= 0; })
    .map(function (a) { return { name: a.getName(), size: a.getSize(), blob: a }; });
}

function resultCard_(title, lines, failed) {
  var section = CardService.newCardSection();
  lines.forEach(function (l) {
    section.addWidget(CardService.newTextParagraph().setText(failed ? '<font color="#b3261e">' + escape_(l) + '</font>' : escape_(l)));
  });
  var card = CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle(title)).addSection(section).build();
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(card)).build();
}

function confirmCard_(e, already) {
  var chosen = (e.formInput && e.formInput.source) || e.parameters.source || '';
  var params = { kind: e.parameters.kind, label: e.parameters.label, rule: e.parameters.rule || '', confirmed: 'yes', source: chosen };
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText('This mail was already sent as ' + escape_(already.label) + ' on ' + already.at + '. Send it again?'))
    .addWidget(CardService.newTextButton().setText('Send again').setOnClickAction(CardService.newAction().setFunctionName('onSend').setParameters(params)));
  var card = CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Already sent')).addSection(section).build();
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(card)).build();
}

function notify_(text) {
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(text)).build();
}

function escape_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- which mails were sent: remembered in the person's own Google account, at most the last 300 ----

function sentBefore_(messageId) {
  var raw = PropertiesService.getUserProperties().getProperty('sent');
  var sent = raw ? JSON.parse(raw) : {};
  return sent[messageId];
}

function remember_(messageId, label) {
  var props = PropertiesService.getUserProperties();
  var raw = props.getProperty('sent');
  var sent = raw ? JSON.parse(raw) : {};
  sent[messageId] = { label: label, at: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMM yyyy HH:mm') };
  var keys = Object.keys(sent);
  if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete sent[k]; });
  props.setProperty('sent', JSON.stringify(sent));
}
