# Google Sheets RSVP Setup Guide (2 Minutes)

This setup records every guest RSVP into your private Google Sheet and immediately notifies **srijayalaxman@gmail.com**.

---

### Step 1: Create Your Google Sheet
1. Open [sheets.new](https://sheets.new) in your browser.
2. Rename the spreadsheet to: **Sooraj & Sreejaya - Wedding RSVPs** *(top left)*.
*(Note: You can leave the sheet blank — the script automatically creates and styles the headers for you!)*

---

### Step 2: Open Apps Script
1. In the Google Sheets top menu, click: **Extensions** &rarr; **Apps Script**.
2. A new tab will open with code editor.

---

### Step 3: Paste the Script
1. Delete any sample code inside `Code.gs`.
2. Copy the entire code from [`google-apps-script.js`](./google-apps-script.js) and paste it into the editor.
3. Click the **Save** icon (floppy disk) or press `Ctrl + S`.

---

### Step 4: Deploy as Web App
1. In the top right, click **Deploy** &rarr; **New deployment**.
2. Next to *Select type*, click the **Gear icon (âš™ï¸)** and choose **Web app**.
3. Fill in the fields:
   - **Description**: `Wedding RSVP Webhook`
   - **Execute as**: `Me (your email)`
   - **Who has access**: `Anyone` *(Crucial: must be "Anyone" so guests can RSVP without logging into Google)*
4. Click **Deploy**.
5. Click **Authorize access** &rarr; select your Google account &rarr; click **Advanced** &rarr; click **Go to Untitled project (unsafe)** &rarr; click **Allow**. *(This allows the script to append rows to your sheet and send notification emails to Sreejaya)*.

---

### Step 5: Copy the Web App URL
1. Copy the **Web app URL** (it looks like: `https://script.google.com/macros/s/AKfycb.../exec`).
2. Paste this URL into `main.js`:
   ```javascript
   const GOOGLE_SHEET_RSVP_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
   ```
3. Commit and push, or send the URL to your developer to plug it in!
