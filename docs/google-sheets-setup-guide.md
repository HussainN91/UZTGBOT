# Connecting the bot to the MoPSE spreadsheet

**Who this is for:** the person at MoPSE who owns the Google account holding the
teacher spreadsheet. You do not need to write any code. Every command in this
guide can be copied and pasted exactly as it appears.

**Roughly 20 minutes.**

---

## What you are doing, and why

The bot reads three things out of one Google spreadsheet: the approved FAQ
answers, the teacher roster, and the list of document forms. It never writes
anything back. Everything the bot creates for itself lives in its own database on
the server.

To let a program read a spreadsheet, Google requires a **service account**. Think
of it as a robot user that belongs to your organisation. It gets its own email
address, and you share the spreadsheet with that address exactly as you would
share it with a colleague.

**By the end you will have produced two values**, and nothing else:

| Value | What it looks like |
|---|---|
| The **spreadsheet ID** | A long string of letters and numbers |
| The **service account key** | A single long line of text starting with `{` |

Hand both to whoever manages the server and you are finished.

> ⚠️ **The second value is a password.** Anybody holding it can read that
> spreadsheet. Send it through something private, and never put it in a group
> chat, a shared document or an email to a mailing list.

---

## Part 1 — Create a Google Cloud project

A project is just a container for the robot user. It is free.

1. Go to **https://console.cloud.google.com/**
2. Sign in with **the Google account that owns the spreadsheet**. This matters.
   If you use a different account, the sharing step later will not work.
3. At the very top of the page, next to the words "Google Cloud", there is a
   **project dropdown**. Click it.
4. In the window that opens, click **NEW PROJECT** in the top right.
5. For **Project name**, copy and paste this:

   ```
   MoPSE Teacher Bot
   ```

6. Leave **Location** as it is. Click **CREATE**.
7. Wait about ten seconds. A notification appears in the top right when it is
   ready. Click **SELECT PROJECT** in that notification.

**Before continuing, check the project dropdown at the top now says
"MoPSE Teacher Bot".** Every step below applies to whichever project is selected
there, and this is the single most common thing to get wrong.

---

## Part 2 — Switch on the Sheets API

By default a new project is not allowed to do anything. You have to enable the
one capability the bot needs.

1. Go to **https://console.cloud.google.com/apis/library/sheets.googleapis.com**
2. Check the project name at the top is still **MoPSE Teacher Bot**.
3. Click the blue **ENABLE** button.
4. Wait for the page to change. It will say the API is enabled.

That is the whole of Part 2.

---

## Part 3 — Create the robot user

1. Go to
   **https://console.cloud.google.com/iam-admin/serviceaccounts**
2. Check the project name at the top is still **MoPSE Teacher Bot**.
3. Click **+ CREATE SERVICE ACCOUNT** near the top.
4. For **Service account name**, copy and paste this:

   ```
   mopse-bot-reader
   ```

5. The **Service account ID** underneath fills in by itself. Leave it alone.
6. For **Service account description**, copy and paste this:

   ```
   Read-only access to the MoPSE teacher support spreadsheet
   ```

7. Click **CREATE AND CONTINUE**.
8. You now see a step called **Grant this service account access to project**.
   **Skip it.** Click **CONTINUE** without choosing a role. The robot needs no
   permissions over the project itself, only over one spreadsheet, and you will
   give it that in Part 5.
9. You now see **Grant users access to this service account**. Skip this too.
   Click **DONE**.

You are returned to a list with one row in it. **In that row is an email address
ending in `.iam.gserviceaccount.com`.**

**Copy that address now and paste it somewhere you can find again**, such as a
blank document. You need it in Part 5.

---

## Part 4 — Create the key

1. In that list, **click on the service account row** you just created.
2. Along the top, click the **KEYS** tab.
3. Click **ADD KEY**, then **Create new key** from the small menu.
4. A window appears asking for a key type. **Leave it on JSON.**
5. Click **CREATE**.

**A file downloads to your computer.** It is named something like
`mopse-teacher-bot-a1b2c3d4e5f6.json` and it will be in your Downloads folder.

> ⚠️ **This file is downloaded once and cannot be downloaded again.** If you lose
> it, you delete the key and create another one. That is normal and costs
> nothing, so do not worry if it happens.

Leave the file where it is. Part 7 turns it into the value you hand over.

---

## Part 5 — Share the spreadsheet with the robot

This is the step people forget, and when it is missed the bot reports that it
cannot find the spreadsheet at all.

1. Open the **MoPSE teacher spreadsheet** in Google Sheets. It is the one with
   the `FAQ`, `ROSTER` and `FORMS` tabs along the bottom.
2. Click the green **Share** button in the top right.
3. In the box that says "Add people and groups", **paste the service account
   email address you saved in Part 3.** It ends in `.iam.gserviceaccount.com`.
4. To the right of it there is a dropdown, normally saying "Editor". **Change it
   to `Viewer`.**

   This matters. The bot only ever reads. Giving it Editor would let a fault in
   the bot damage the spreadsheet, and there is no reason to accept that risk.
5. **Untick "Notify people"** if that box appears. A robot cannot read email.
6. Click **Share**, or **Send**.

Google may warn you that you are sharing outside your organisation. That is
expected, because the service account belongs to the Cloud project rather than to
your domain. Continue.

---

## Part 6 — Get the spreadsheet ID

With that same spreadsheet open, look at the address bar of your browser. It
looks like this:

```
https://docs.google.com/spreadsheets/d/1KI8W18A4LUGo9X_voUz2DqEPoQfONf9Bzyl2jJH6xxU/edit#gid=0
```

**The spreadsheet ID is the part between `/d/` and `/edit`.** In the example
above it is:

```
1KI8W18A4LUGo9X_voUz2DqEPoQfONf9Bzyl2jJH6xxU
```

Copy yours and paste it next to the service account email in your notes. That is
the first of your two values.

---

## Part 7 — Turn the key file into one line

The bot needs the key as a **single line of text**. The downloaded file is spread
across many lines, so it has to be flattened first. This is what the command
below does. It changes nothing on your computer and creates no new files.

1. Click the **Start** menu, type `powershell`, and open **Windows PowerShell**.
2. Copy the command below.
3. **Before pasting it, replace `(PASTE THE FILE PATH HERE)` with the location of
   your downloaded file, including the round brackets.**

```powershell
(Get-Content "(PASTE THE FILE PATH HERE)" -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10) | Set-Clipboard
```

**To get the file path:** open your Downloads folder, hold **Shift**, right-click
the `.json` file, and choose **Copy as path**. That gives you the location with
quotation marks already around it. When you paste it in, delete the quotation
marks that came with it, because the command already has its own.

A correct command ends up looking like this:

```powershell
(Get-Content "C:\Users\Aziza\Downloads\mopse-teacher-bot-a1b2c3d4e5f6.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10) | Set-Clipboard
```

4. Press **Enter**.

**If nothing appears, it worked.** The one-line version is now on your clipboard,
ready to paste.

**If you see a red error**, the file path is wrong. The usual causes are leftover
quotation marks or a missing `.json` on the end. Try the Shift + right-click
method again.

To see what you have before sending it, run this:

```powershell
Get-Clipboard
```

You should get one very long line beginning with `{"type":"service_account"` and
ending with `}`. If it is spread over several lines, something went wrong; start
Part 7 again.

---

## Part 8 — Hand over the two values

Send these to whoever manages the server:

1. **The spreadsheet ID** from Part 6.
2. **The one-line key** now on your clipboard. Paste it into your message.

> ⚠️ Send them somewhere private, and treat the second one as a password.
> If it ever appears in a group chat, a screenshot or a shared document, say so.
> Replacing it takes five minutes: delete the key in Part 4 and make a new one.
> Saying nothing is the only expensive option.

You are finished. Nothing else is needed from you.

---

## For whoever manages the server

The two values go into `~/UZTGBOT/.env`:

```
GOOGLE_SHEET_ID=<the spreadsheet ID>
GOOGLE_SERVICE_ACCOUNT_JSON=<the one-line key>
```

Both on a single line each, with no quotation marks around either value.

Then recreate the containers, because `env_file` values are read when a container
is **created** and a plain `restart` keeps the old ones:

```bash
cd ~/UZTGBOT && docker compose up -d --force-recreate web worker
```

Then force a sync rather than waiting ten minutes for the scheduled one:

```bash
cd ~/UZTGBOT && docker compose exec worker node dist/scripts/sync-sheets.js
```

A working run reports `sync applied` for `FAQ`, `ROSTER` and `FORMS`, with the
number of rows taken from each.

**The three failures worth recognising**, because each points at a different
part of this guide:

| What you see | What it means |
|---|---|
| `Requested entity was not found` | The spreadsheet was never shared with the service account, or the ID is wrong. Part 5 or Part 6 |
| `Google Sheets API has not been used in project … before or it is disabled` | Part 2 was skipped, or it was done in a different project |
| `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. It must be the whole key file on one line.` | Part 7 did not complete. The value is still spread over several lines |
