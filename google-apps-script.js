/**
 * Google Apps Script for Sooraj & Sreejaya: Wedding & Reception RSVPs
 * Automatically manages two tabs: "Wedding RSVPs" and "Reception RSVPs"
 *
 * HOW TO UPDATE YOUR EXISTING DEPLOYMENT (30 SECONDS):
 * 1. Open your Google Sheet: "Sooraj & Sreejaya - Wedding RSVPs"
 * 2. Click: Extensions -> Apps Script
 * 3. Replace all code in Code.gs with this entire script.
 * 4. Click the Save icon (Ctrl + S).
 * 5. Click "Deploy" (top right) -> "Manage deployments"
 * 6. Click the Pencil (Edit) icon next to your active deployment.
 * 7. In the "Version" dropdown, select "New version".
 * 8. Click "Deploy". (Your Web App URL stays exactly the same!)
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();

    // Parse incoming JSON or form-encoded payload
    var data = {};
    if (e && e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
      } catch (err) {
        data = e.parameter || {};
      }
    } else if (e && e.parameter) {
      data = e.parameter;
    }

    var isReception = (data.event && data.event.toLowerCase().indexOf("reception") !== -1);
    var targetSheetName = isReception ? "Reception RSVPs" : "Wedding RSVPs";

    // Find or create the dedicated tab for this event
    var sheet = doc.getSheetByName(targetSheetName);
    if (!sheet) {
      var allSheets = doc.getSheets();
      // If there's only one default Sheet1, rename it if it's the wedding tab
      if (!isReception && allSheets.length === 1 && allSheets[0].getName().toLowerCase().indexOf("sheet") === 0) {
        sheet = allSheets[0];
        sheet.setName(targetSheetName);
      } else {
        sheet = doc.insertSheet(targetSheetName);
      }
    }

    // Auto-create and style header row if the sheet is empty
    if (sheet.getLastRow() === 0) {
      var headers = [
        "Timestamp (IST)",
        "Guest Name",
        "Contact Info",
        "Attendance Status",
        "Total Guests",
        "Blessings & Wishes"
      ];
      sheet.appendRow(headers);
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold");
      // Wedding: Festive dark emerald green; Reception: Royal dark navy
      headerRange.setBackground(isReception ? "#1c2e4a" : "#2d4a22");
      headerRange.setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    }

    var now = new Date();
    var timeFormatted = Utilities.formatDate(now, "Asia/Kolkata", "dd MMM yyyy, hh:mm a");
    var name = (data.name || "A Guest").trim();
    var contact = data.contact || "Not provided";
    var attendance = data.attendance || "Joyfully accept";
    if (attendance === "yes") attendance = "Joyfully accept";
    if (attendance === "no") attendance = "Sending love from afar";
    var guests = (attendance === "Sending love from afar") ? "0" : (data.guests || "1 guest");
    var message = data.message || "";

    // Append RSVP row to the appropriate tab
    sheet.appendRow([
      timeFormatted,
      name,
      contact,
      attendance,
      guests,
      message
    ]);

    // Send instant notification email to Sooraj & Sreejaya
    try {
      var eventTitle = isReception ? "Wedding Reception (23 Dec 2026 @ Trinita Casa, Kochi)" : "Wedding Ceremony (19 Dec 2026 @ Dinesh Auditorium, Kannur)";
      var emailSubject = (isReception ? "Reception RSVP: " : "Wedding RSVP: ") + name + " (" + attendance + ")";
      var emailBody = "New RSVP received for Sooraj & Sreejaya!

" +
        "Event: " + eventTitle + "
" +
        "Guest Name: " + name + "
" +
        "Contact: " + contact + "
" +
        "Attendance: " + attendance + "
" +
        "Number of Guests: " + guests + "
" +
        "Blessings / Wishes: " + (message || "None") + "

" +
        "Timestamp: " + timeFormatted + " IST

" +
        "View both Wedding & Reception guest lists in your Google Sheet:
" + doc.getUrl();

      MailApp.sendEmail({
        to: "srijayalaxman@gmail.com, sooraj1119@gmail.com",
        subject: emailSubject,
        body: emailBody
      });
    } catch (mailError) {
      Logger.log("Email error: " + mailError.toString());
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        status: "success",
        event: targetSheetName,
        name: name,
        row: sheet.getLastRow()
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: "active",
      message: "Sooraj & Sreejaya Wedding & Reception RSVP Webhook is ready."
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
