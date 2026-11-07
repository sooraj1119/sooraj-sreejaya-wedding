/**
 * Google Apps Script for Sooraj & Sreejaya Wedding RSVP
 *
 * HOW TO SET UP IN 2 MINUTES:
 * 1. Open Google Sheets (https://sheets.new) and name it: "Sooraj & Sreejaya - Wedding RSVPs"
 * 2. In Google Sheets top menu, click: Extensions -> Apps Script
 * 3. Delete any code in Code.gs and paste this entire file content.
 * 4. Click the Save icon (Floppy disk).
 * 5. Click "Deploy" (top right) -> "New deployment"
 *    - Click the Gear icon next to "Select type" -> choose "Web app"
 *    - Description: "Wedding RSVP Webhook"
 *    - Execute as: "Me" (your email)
 *    - Who has access: "Anyone" (VERY IMPORTANT: must be "Anyone" so guests can submit without Google login)
 * 6. Click "Deploy" -> Authorize access if prompted.
 * 7. Copy the "Web app URL" (starts with https://script.google.com/macros/s/.../exec)
 * 8. Paste that URL into main.js (GOOGLE_SHEET_RSVP_URL = "...")
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getActiveSheet();

    // Auto-create header row with nice styling if the sheet is fresh
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
      headerRange.setBackground("#2d4a22"); // Deep festive green
      headerRange.setFontColor("#ffffff"); // White text
      sheet.setFrozenRows(1);
    }

    // Parse incoming JSON payload
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

    var now = new Date();
    var timeFormatted = Utilities.formatDate(now, "Asia/Kolkata", "dd MMM yyyy, hh:mm a");
    var name = (data.name || "A Guest").trim();
    var contact = data.contact || "Not provided";
    var attendance = data.attendance || "Joyfully accept";
    var guests = (attendance === "Sending love from afar") ? "0" : (data.guests || "1 guest");
    var message = data.message || "";

    // Append new RSVP row to the Google Sheet
    sheet.appendRow([
      timeFormatted,
      name,
      contact,
      attendance,
      guests,
      message
    ]);

    // Send instant email notification to Sreejaya
    try {
      var emailSubject = "Wedding RSVP: " + name + " (" + attendance + ")";
      var emailBody = "New Wedding RSVP received for Sooraj & Sreejaya!\n\n" +
        "Guest Name: " + name + "\n" +
        "Contact: " + contact + "\n" +
        "Attendance: " + attendance + "\n" +
        "Number of Guests: " + guests + "\n" +
        "Blessings / Wishes: " + (message || "None") + "\n\n" +
        "Received on: " + timeFormatted + " IST\n\n" +
        "View the full guest list in your Google Sheet:\n" + doc.getUrl();

      MailApp.sendEmail({
        to: "srijayalaxman@gmail.com",
        subject: emailSubject,
        body: emailBody
      });
    } catch (mailError) {
      Logger.log("Email notification error: " + mailError.toString());
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success", name: name }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Simple healthcheck endpoint
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: "active",
      message: "Sooraj & Sreejaya Wedding RSVP Webhook is running and ready."
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
