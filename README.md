# How the FSY Check-in app works (code guide)

This is a simple FSY Check-in App that is built around what check-in processes look like, what session and logistics committee leaders need to see from fsy data, and generation of companies and groups. All functions are programmed from this persepctive.

The whole app lives inside `app.js`; a simple monolith supported with pure html, css and js for simplicity. This guide explains how `app.js` is built and what every function does, grouped by the tab or part of the app it serves. The setup steps (Firebase, GitHub Pages, accounts) are in `README.md`.

Version described: **2026-11-19c**. Function names are the exact names in `app.js`, so you can search for them (Ctrl+F) in any editor.

---

## 1. The files

| File | What it is |
|---|---|
| `index.html` | The empty page shell. It loads Firebase, the spreadsheet reader (SheetJS), `config.js`, `app.js` and `styles.css`. |
| `config.js` | Your Firebase project keys, the owner emails, and the optional `NOTIFY_URL` for access-request emails. The API key is meant to be public. |
| `app.js` | The whole app: data, rules for groups and companies, every page, every button. |
| `styles.css` | All the looks: colours, banner, cards, the frosted banner buttons, phone layout. |
| `firestore.rules` | The server-side permissions. The database itself refuses anything a role is not allowed to do, even if someone edits the app in their browser. |
| `notify.gs` | Optional Google Apps Script that emails you when someone asks for access. |
| `assets/` | Logo, theme identifier and banner art. |

---

## 2. The big picture

```
 Firebase (live database)
        │  subscribe() listens to every collection
        ▼
 S  (one object holding all data in memory)
        │  recompute() rebuilds the working lists
        ▼
 S.P  (every participant, with group, company, flags, check-in state)
        │  render() draws the page
        ▼
 PAGE_IMPL[tab].frame()   → the page layout, drawn once
 PAGE_IMPL[tab].update()  → the numbers and lists, redrawn on every change
        ▲
        │  clicks, typing, forms
 one click / change / submit listener (the "events" section) → save functions → Firebase
```

The rules that matter:

- **One state object, `S`.** Everything loaded from Firebase lives in `S` (roster, check-ins, staff, groups, settings, accounts). `UI` holds screen-only things such as open panels, search text and filters.
- **Live everywhere.** When anyone checks someone in, Firebase pushes the change to every open phone, `recompute()` runs, and every page updates within a second.
- **Pages have two parts.** `frame()` draws the layout once, so typing in a search box is never interrupted. `update()` fills in the changing numbers and lists.
- **Buttons don't have their own code.** Each button carries `data-act="something"`, and a single listener at the bottom of `app.js` runs the matching `case 'something':`.
- **Sessions.** Most data sits under `sessions/<id>/…`, so one database can hold several sessions (see the Sessions tab).

---

## 3. Where the data lives in Firebase

| Path | What it holds |
|---|---|
| `config/session` | Session settings: name, first day, headcount nights, group sizes, "every counselor gets a group", excluded statuses and areas, unit aliases, other roles, the "companies are official" lock. |
| `roster/<bucket>` | Participants from the upload, split into small buckets so each document stays small. |
| `state/<bucket>` | What changes during the event: checked in or out, group, manual moves, include or exclude. |
| `medical/<bucket>` | Medical and dietary notes. Only admins, wellness and logistics read these. |
| `share/<user>` | A personal copy of medical notes for a counselor or AC, limited to their own youth. |
| `staff/all` | Every staff record (counselors, ACs, coordinators and more). |
| `org/structure` | Groups and companies, and the group-number lock. |
| `headcount/<night_group>` | Each group's nightly headcount. |
| `reports/<user>` | Health concerns reported by counselors. |
| `audit/…` | The audit log (reg admin only, append-only). |
| `invites/<email key>` | Accounts: the role, sessions and linked staff record for each email. |
| `requests/<user>` | People asking for access. |
| `profiles`, `meta/sessions` | Who has signed in, and the list of sessions. |

---

## 4. The foundation (used by every tab)

### 4.1 Settings and the Firebase layer

| Function | What it does |
|---|---|
| `appConfig` | Reads the Firebase settings from `config.js`. |
| `ownerEmails` | Reads the owner emails from `config.js`. Owners always have full access. |
| `rawPath` | Turns a short path like `roster/a1` into the full path for a session. |
| `scoped` | The same, for the session that is open now. |
| `shimDoc` | Wraps one Firebase document so the rest of the app can use short paths. |
| `shimCol` | Wraps one Firebase collection the same way. |
| `wrapWrite` | Sends writes to the right session path. |
| `fbSnap` | Converts a Firebase result into the shape the app expects. |
| `fbErr` | Turns Firebase errors into readable ones. |

### 4.2 Cleaning and reading data

| Function | What it does |
|---|---|
| `fnv` | Makes a short fixed code from text. Used for IDs and to spot changes. |
| `bucketOf` | Decides which roster bucket a participant belongs in. |
| `rid` | Makes a new random ID, such as for a new group. |
| `clean` | Trims text and collapses spaces. |
| `titleCase` | Capitalises names properly. |
| `normGender` | Turns "Female", "F", "girl" and so on into F or M. |
| `normStatus` | Tidies the registration status from the portal. |
| `normSize` | Turns T-shirt sizes into XS, S, M, L, XL, XXL or 3XL. |
| `normType` | Turns the Type column into participant, counselor, AC, coordinator and so on. |
| `nn` | Writes a number with the right singular or plural ("1 group", "3 groups"). |
| `pad2` | Pads a number to two digits (7 → 07). |
| `parseDate` | Reads dates in any common format into YYYY-MM-DD. |
| `ageOn` | Works out age on a given day, usually the first day of the session. |
| `bandOfAge` | Puts an age in the 14–15 band (Y) or the 16–18 band (O). |
| `slug` | Makes a short safe code from text, used for links on the page. |
| `issueText` | Separates real medical or dietary issues from "none", "N/A" and similar. |
| `cats` | Sorts a medical or dietary note into categories (allergies, asthma and so on). |
| `sizeRank` | Gives each T-shirt size its place in the size order. |
| `largestRemainder` | Splits a total fairly across sizes. Used for T-shirt estimates. |
| `teeRedistribute` | Shares out the people with no T-shirt size in the same proportions as the known sizes. |
| `sha256` | A standard hash, used for email keys. |
| `emailKey` | Makes the database key for an email address. |
| `toCSV` | Turns rows into CSV text. |

### 4.3 Roles and permissions

`ROLES` lists every role's display name, and `can` is a set of small yes or no checks (for example `can.orgEdit()` means "may change groups and companies"). `PAGES` lists every tab and who may see it, and `NAV_ORDER` sets the menu order for each role.

| Function | What it does |
|---|---|
| `invSessions` | The sessions an account belongs to. |
| `invHere` | Whether an account belongs to the open session. |
| `roleAssignable` | Which roles the signed-in person may give to others. |
| `sessName` | A session's display name. |
| `inviteFor` | The account for a signed-in user. |
| `accountOf` | The account for any user ID. |
| `realRole` | The signed-in person's true role. |
| `role` | The role in use now. This differs from `realRole` only while previewing another role. |
| `myStaffId` | The staff record linked to the signed-in person. |
| `scopeCompanyIds` | The companies a counselor or AC is responsible for. |
| `inScopeFor` | Whether a participant is inside someone's scope (their group or company). |
| `seesPrivate` | Whether the signed-in person may see a participant's medical and dietary notes. |
| `allowedPages` | The tabs the current role may open. |
| `currentPage` | The tab that is open now, falling back to Check-in. |

### 4.4 Shared screen helpers

| Function | What it does |
|---|---|
| `toast` | Shows a short message at the bottom of the screen. |
| `fail` | Shows a friendly error message when a save fails. |
| `fmtTime` | Formats a time ("3:12 PM"). |
| `fmtWhen` | Formats a date and time ("Nov 18, 03:12 PM"). |
| `gLabel` / `cLabel` | Labels for a group ("G12") and a company ("Company 3"). |
| `sName` | A staff member's name from their ID. |
| `genderWord` | "young women" or "young men", with the age band. |
| `chipG` / `chipBand` | Small coloured chips for gender and age band. |
| `pct` | A percentage. |
| `opt` | One `<option>` in a dropdown. |
| `uniq` | Removes duplicates from a list. |
| `flagChips` | The warning chips on a participant (walk-in, cancelled, no gender and so on). |
| `confirmBox` | An "Are you sure?" box. |
| `confirmTyped` | A stronger confirmation that asks you to type a word, for actions that can't be undone. |
| `askText` | A box that asks for one line of text. |
| `openModal` / `closeModal` | Open and close the pop-up window. |
| `exportCSV` | Downloads rows as a CSV file. |
| `infoBtn` / `infoCard` | The round (i) button in a banner and the explanation card it opens. |
| `foldSec` / `foldOpen` / `openFold` | Sections that fold open and closed, and the KPI buttons that jump to them. |
| `areaTally` | The "by stake and unit" table used on several pages. |
| `fitWidth` | Widens the page on big screens to match the menu (between 1280 and 1680 pixels). |
| `pinSearch` | Keeps the Check-in search box in view when you scroll. |
| `loadScript` | Loads an extra script only when it's needed (such as the PDF maker). |

### 4.5 Saving

Every save goes through these. That keeps the audit log and the screen in step with the database.

| Function | What it does |
|---|---|
| `serial` | Saves to one document one change at a time, so quick taps never overwrite each other. |
| `upd` | Updates part of a document. |
| `setDoc` | Writes a whole document. |
| `audit` | Adds a line to the audit log (who, what, when). |
| `auditState` | Describes a participant change for the audit log ("checked in", "moved to G12"). |
| `setState` | Saves one participant's check-in, group or flags. |
| `setStates` | Saves many participants at once (after Rebalance, for example). |
| `saveOrg` | Saves all groups and companies. |
| `patchOrg` | Saves a change to one group or company. |
| `saveStaffRec` | Saves one staff record and logs a role change. |
| `saveSizes` | Saves group sizes and "every counselor gets a group". Coordinators may do this. |
| `saveConfig` | Saves session settings. |

### 4.6 Loading, sign-in and background jobs

| Function | What it does |
|---|---|
| `boot` | Starts the app: connects to Firebase, waits for sign-in, picks the session. |
| `signIn` | Opens Google sign-in. |
| `signInError` | Explains sign-in problems in plain words. |
| `subscribe` | Listens live to every collection of the open session and fills `S`. |
| `subscribeGuest` | The small listener for someone who has no access yet (so they can ask for it). |
| `loadedAll` | Whether every collection has loaded at least once. |
| `recompute` | Rebuilds the working lists (`S.staffList`, `S.P`, T-shirt estimates), then draws the page. |
| `derive` | The core merge. It joins the roster, check-in states, groups, companies, staff and settings into one record per participant, with age, band, flags and "expected or not". |
| `mergeMedical` | Adds medical notes to each participant from the protected store, or from the personal copy for counselors and ACs. |
| `adminSync` | Runs `runAdminSync` a moment after changes, only on an admin's device. |
| `runAdminSync` | Background housekeeping: moves old medical notes into the protected store, writes each counselor's or AC's personal medical copy, adds logistics, SDC and wellness accounts as staff, links accounts to staff records, and applies account roles. |
| `syncAccountStaff` | Adds a staff record for logistics, Session Directing Couple and wellness accounts, so they count on the Staff page. |
| `autoLinkStaff` | Links an account to its staff record by email, or else by the same name and role. |
| `syncLinkedRoles` | Makes the linked staff record use the role chosen on the Accounts page (an AC account makes the record an AC). |
| `unlinkDeleted` | Frees accounts whose staff record was deleted, so they can link again. |
| `autoClaim` | Old automatic linking step, now switched off (it returns straight away). |
| `notifyRequest` | Sends the access-request email through `notify.gs`, if set up. |

### 4.7 The app frame (header, menu, gate)

| Function | What it does |
|---|---|
| `render` | Draws the open tab. It calls `frame()` when the tab or role changes, and `update()` every time. |
| `renderHeader` | The top bar: title, Live dot, role chip and avatar. |
| `renderNav` | The tab menu, and the bottom bar on phones. |
| `navPages` | The tabs in menu order for the current role. |
| `openMore` | The "More" sheet on phones, for tabs that don't fit the bottom bar. |
| `openAccount` | The account menu: role, session switcher, role preview, audit log, sign out. |
| `initials` | The initials on the avatar. |
| `gateView` | The welcome, sign-in, "ask for access" and "finish setup" screens. |
| `lockReadOnly` | Hides admin-only buttons and locks fields for view-only roles such as logistics. |

### 4.8 Group and company rules (the engine)

These are used by Companies & groups, but also by check-in, headcount and the Tally checks.

| Function | What it does |
|---|---|
| `gsize` | The group size for young women or young men. |
| `staffAge` | A staff member's age, from the birthdate or from the age given. |
| `cPref` | How well a counselor's age suits a band (19–22 suit 14–15; 23 and over suit 16–18). |
| `sortForDeal` | Orders participants by stake, unit and name before they are dealt out. |
| `shuffled` | Shuffles a list, so every Regenerate mixes people differently. |
| `mixAssign` | Deals participants into groups so each group gets as few from the same district and ward as possible. |
| `pickMover` | Chooses who to move into a new or smaller group (the person who shares least with that group). |
| `assignCounselors` | Gives each group a counselor of the same gender, preferring the right age. |
| `placeGroupInCompany` | Puts a group in the company of its band with the fewest groups of that gender, and the least overlap of districts. |
| `bandCap` | How many groups a company of a band should hold. |
| `assignCoordinators` | Clears per-company coordinators (coordinators cover every company). |
| `renumber` | Numbers groups company by company (Company 1 gets G1 to G9, and so on). |
| `shadowedCounselors` | Finds counselor records that are really an AC or coordinator listed twice, so they never lead a group. |
| `fullGenerate` | **Regenerate all**: builds every group and company from scratch. |
| `rebalance` | **Rebalance, keep groups**: keeps current groups and moves as few youth as possible. It fills groups with no counselor, splits groups that are too big, gives spare counselors groups when "every counselor gets a group" is on, fixes gender mismatches, removes ACs and coordinators from leading groups, and gives companies their ACs. |
| `validate` | Builds the list of checks (groups over size, no counselor, mixed gender and so on). |
| `fitSizes` | Works out the group size that would give every counselor a group. |
| `fitHint` | The "Fit group sizes to your counselors" box. |
| `makeTestStaff` | Creates practice counselors and ACs for testing. They are marked as test records. |

---

## 5. Tab by tab

### Check-in (`PAGE_IMPL.checkin`)
Who sees it: everyone with a role. Wellness only views. It's the landing page for everyone.

What it does: search any participant, check them in or out, and browse by stake and ward. Counselors and ACs open on "Mine" (their own group or company).

| Function | What it does |
|---|---|
| `PAGE_IMPL.checkin.frame` / `.update` | The banner (checked in, expected, walk-ins), search box, filters and results. |
| `areaOf` | A participant's stake and ward, with "(No stake given)" when blank. |
| `areaBrowser` | The folding list of stakes and wards with checked-in and registered counts. |
| `ciRow` | One participant row with the Check in button. |
| `pCard` | A participant card (name, age, ward, group, flags). |
| `myGroups` / `myCompanies` | The counselor's own group or the AC's own company. |
| `inMine` | Whether a participant is in "Mine". |
| `isExpected` | Whether someone is expected: included, and not a walk-in. This one rule keeps every count the same across tabs. |
| `registered` | Everyone included or already checked in. |
| `openDetail` | The participant details window: contacts, medical (if allowed), group, move, check out. |
| `groupOptionsFor` / `moveSelect` | The "move to group" dropdown, showing only groups of the right gender and band. |
| `printForm` | Makes the printable PDF check-in form for a stake or ward. |
| `loadPdfLib` / `logoPngBytes` / `pdfSafe` | Load the PDF maker, add the logo, and remove characters a PDF can't show. |

Main buttons (`data-act`): `ciIn` (check in), `ciOut` (check out), `ciUndo`, `ciF` (filter), `ciPick`, `detail`, `ciPrint`.

### Tally (`PAGE_IMPL.tally`)
Who sees it: everyone except counselors and ACs.

What it does: the grand totals. Youth checked in, staff, other roles (DJs, sound team), the grand total, T-shirt tables, and the Checks panel.

| Function | What it does |
|---|---|
| `PAGE_IMPL.tally.frame` / `.update` | The totals, the tables by stake and band, the other-roles editor and the Checks. |
| `checksList` | The folding Checks list with links to the group, company or participant. |
| `checkHint` | The short advice under each check ("Press Rebalance…"). |

Main buttons: `chkGo` (jump to the problem), `orAdd` / `orInc` / `orDec` / `orDel` (other roles), `allWarn`, `tallyCsv`.

### Companies & groups (`PAGE_IMPL.companies`)
Who sees it: everyone with a check-in role. Only the reg admin, SDC, Seventy, Head of Logistics and coordinators can change things.

What it does: the leadership summary, group sizes, Checks, and every company with its groups and members.

| Function | What it does |
|---|---|
| `PAGE_IMPL.companies.frame` / `.update` | The banner buttons, Leadership box, Group sizes, Checks, search, and company cards. |
| `grpBlock` | One group: counselor picker, company picker and member list with move dropdowns. |
| `runRebalance` | The Rebalance button: runs `rebalance`, saves groups and moves, and shows what changed. |
| `runRegen` | Regenerate all, after a warning. It's blocked once companies are marked official. |
| `runRenumber` | Renumbers groups by company and locks the numbers ("Numbers locked" badge). |
| `resetPanel` / `resetOrg` | The "Start over" panel: undo all groups, or remove test staff. |

Main buttons: `rebalance`, `regen`, `renumber`, `regenLock` (mark official or unlock), `addCo`, `useAll` (give every counselor a group anyway), `fitSizes`, `coBand`, `spareToggle`, `grpCoun` / `grpCo` (counselor and company of a group), `moveP`, `delGrp`, `delCo`, `rosterCsv`, `logClose`.

### Walk-ins & exceptions (`PAGE_IMPL.exceptions`)
Who sees it: check-in roles and logistics.

What it does: record walk-ins (people not on the list) and handle exceptions such as cancelled, unapproved or excluded areas.

| Function | What it does |
|---|---|
| `PAGE_IMPL.exceptions.frame` / `.update` | The walk-in form and the exception lists. |
| `exRow` | One exception row with its fix button (include, exclude, check in now). |

Main buttons: the `wkForm` form (add a walk-in), `ovr` (include or leave out), `ciIn`, `exCsv`.

### Logistics (`PAGE_IMPL.logistics`)
Who sees it: every role except wellness.

What it does: T-shirts, medical and dietary counts, and the folding lists that the KPI buttons jump to. Counselors see their own group only.

| Function | What it does |
|---|---|
| `PAGE_IMPL.logistics.frame` / `.update` | The KPIs, T-shirt tables, medical and dietary lists. |
| `lgHash` | Opens the right list when you arrive from a KPI link. |
| `teeBlock` | The youth T-shirt table by band and gender, with estimates for blanks. |
| `sizesIn` | The T-shirt sizes present, in size order. |
| `staffTee` / `staffTeeBlock` | The staff T-shirt table. |

### Headcount (`PAGE_IMPL.headcount`)
Who sees it: counselors, ACs, coordinators, admins and logistics (view only).

What it does: each night, counselors mark youth present or missing and submit. ACs and coordinators watch live.

| Function | What it does |
|---|---|
| `PAGE_IMPL.headcount.frame` / `.update` | The night picker, your groups and the overview. |
| `hcChain` | Who you report to (your AC, your coordinator, the SDC). |
| `hcViewOnly` | Whether you only view. |
| `isoUTC` / `nightOf` | Today's night in Kenya time. After midnight and before 6 am still counts as the night before. |
| `hcNights` / `nightLabel` / `hcDay` | The list of headcount nights, their labels, and the chosen night. |
| `hcDoc` / `hcGroup` | One group's headcount for a night: present, missing, not counted. |
| `hcScopeGroups` | The groups you are responsible for. |
| `hcForm` | The present and missing form for one group. |
| `hcOverview` | The table of every group's status for the night. |
| `hcWrite` | Saves marks and submits. |
| `resetHeadcounts` | Clears headcounts for one night or all nights (admins). |

### Staff (`PAGE_IMPL.staff`)
Who sees it: admins, coordinators and logistics (logistics can search but not change).

What it does: every counselor, AC, coordinator and other leader. Import the sign-up form, add or edit people, and print counselor lists.

| Function | What it does |
|---|---|
| `PAGE_IMPL.staff.frame` / `.update` | The banner, KPIs, table by stake and unit, search, tabs by role, and the staff list (newest first or by area). |
| `openStaffForm` | The Add or Edit staff window. |
| `stAreas` | Official stakes and their wards, plus places already used on staff. |
| `stUnitOpts` | The ward dropdown for a chosen stake, with "+ Other ward or branch…". |
| `stAreaSync` | Shows the "Other" boxes when you pick Other. |
| `stAgeText` | The age shown under the birthdate. |
| `areaSort` / `staffByArea` | Sort and group staff by stake and ward. |
| `printStaffList` | The PDF counselor list per stake or ward. |
| **Import (sign-up form)** | |
| `sfRead` | Reads the chosen Excel or CSV file. |
| `sfMap` | Matches the file's column names to fields (name, email, phone, ward, Type…). |
| `sfRow` | Cleans one row (name, phone, email, birthdate, ward, size, food). |
| `sfName` / `nameTokens` | Tidy names, and break them into words for matching. |
| `sfPhone` / `sfEmail` / `sfStamp` / `sfDiet` | Clean the phone (07… or 01…), the email, the form timestamp and the food note. |
| `samePerson` | Decides whether two rows are the same person (email, phone or name). |
| `dedupeSubs` / `mergeSubs` | Merge people who sent the form more than once. The newest answer wins. |
| `unitCore` / `editDist` | Strip a ward name to its core and measure spelling differences. |
| `unitDirectory` / `matchUnit` | Match each ward or branch to its stake or district, including the Buruburu, Nairobi 1st Ward and South B rules. |
| `sfKnownUnits` | The known stake and ward pairs from the participant upload. |
| `staffIntake` | Runs the full clean-up on a file. |
| `intakeRecords` | Turns the cleaned people into staff records, updating people already on the list. Roles come from the Type column; anyone else keeps their current role. |
| `sfRun` / `renderSf` | Re-run the clean-up and draw the preview (counts and wards to confirm). |
| `sfDirOpts` | The "which stake is this ward in?" choices. |
| `sfImport` | Saves the import. |

Main buttons: `sfPick` (import), `sfGo`, `sfCancel`, `stAdd`, `stEdit`, `stDel`, `resetType` (delete by type), `stTab`, `stView`, `stCsv`, `stPdf`, `info`.

### Wellness (`PAGE_IMPL.wellness`)
Who sees it: wellness coordinators, admins and logistics (view only).

What it does: every medical and dietary note for youth and staff, and the health concerns counselors report.

| Function | What it does |
|---|---|
| `PAGE_IMPL.wellness.frame` / `.update` | The KPIs, open concerns, and folding medical and dietary lists. |
| `wlOpen` | Whether a folding list is open. |
| `allReports` | Every reported concern, open ones first. |
| `repChip` | The "open health concern" chip on a participant. |
| `repHistory` / `repCard` | A participant's concern history, and one concern card. |
| `openReportForm` | The "report a concern" window for counselors. |
| `saveReport` / `updateReport` | Save a new concern, and follow up or resolve one. |

### Data & areas (`PAGE_IMPL.data`)
Who sees it: admins, and logistics (view only).

What it does: upload the portal export, export everything, session settings, statuses, and which stakes and wards belong to the session.

| Function | What it does |
|---|---|
| `PAGE_IMPL.data.frame` / `.update` | The banner (upload, exports, (i)), settings, statuses, data problems and area list. |
| `readFile` | Reads the uploaded Excel or CSV file. |
| `autoMap` | Matches column headers to fields (first name, birthday, Type…). |
| `rowsToRecords` | Turns rows into participants and staff, with Registration ID as the key. |
| `renderImport` | The upload preview with the column matches you can change. |
| `doImport` | Saves the upload without losing check-ins or groups. |
| `partValue` / `participantRows` / `exportParticipants` | The participants CSV, with the same columns as uploaded plus Company and Group. |
| `staffPlace` / `staffValue` / `staffRows` / `exportStaff` | The staff CSV, the same way. |
| `everyoneRows` / `exportWorkbook` | The Excel workbook with Everyone, Participants and Staff tabs. |

Main buttons: `impPick`, `impGo`, `impCancel`, `expAll`, `expPart`, `expStaff`, `stat`, `toggleStake` / `toggleArea`.

### Accounts (`PAGE_IMPL.access`)
Who sees it: reg admin, SDC, Area Seventy and Head of Logistics.

What it does: create accounts, give roles, answer access requests, link accounts to staff records, and search and fold the list by role.

| Function | What it does |
|---|---|
| `PAGE_IMPL.access.frame` / `.update` | Requests, the new-account form and the account list. |
| `setAccess` | Saves a role or session change for a signed-in user. |

Main buttons: the `invForm` form (create an account), `invRole`, `invStaff` (link a record), `invSess`, `invDel`, `reqRole` / `reqDel` (access requests), `accToggle`.

### Sessions (`PAGE_IMPL.sessions`)
Who sees it: reg admin, Area Seventy, Head of Logistics and SDC.

What it does: split a session by moving chosen stakes or wards to another or new session, and switch sessions.

| Function | What it does |
|---|---|
| `PAGE_IMPL.sessions.frame` / `.update` | Stake and ward picker, destination and counts. |
| `loadSessionCounts` | Counts participants in your other sessions, leaving out cancelled ones. |
| `moveParticipants` | Moves the chosen people, with their check-ins, to the other session. |

### Audit log (`PAGE_IMPL.audit`, in the account menu)
Who sees it: the registration admin only.

| Function | What it does |
|---|---|
| `PAGE_IMPL.audit.frame` / `.update` | The log with filters by kind and person. |
| `audSubscribe` | Loads the latest log entries only when the log is opened, so the app stays fast. |
| `audFiltered` | Applies the filters. |

---

## 6. The events section (bottom of `app.js`)

Three listeners handle everything you do on the page:

- **click**: reads `data-act` from the clicked button and runs the matching `case`. Examples are `case 'rebalance'`, `case 'ci'`, `case 'info'` and `case 'useAll'`.
- **change**: dropdowns and checkboxes, such as moving a participant to a group, choosing a counselor for a group, or ticking an area.
- **submit**: forms, such as the staff form (`stForm`), new account (`invForm`), settings (`cfgForm`), group sizes (`sizeForm`) and walk-in (`wkForm`).

At the very end, a small `pointerdown` listener gives the banner buttons their liquid glass press.

To add a new button: give it `data-act="myThing"`, then add `case 'myThing': … break;` to the click listener.

---

## 7. Tips for changing things safely

- **Change permissions in two places:** the `can` checks in `app.js` (what people see) and `firestore.rules` (what the database allows).
- **Counts:** use `isExpected(p)` for "expected" so every tab agrees.
- **Wording for numbers:** use `nn(count, 'group')` so you get "1 group" and "2 groups".
- **Saving:** always go through the save functions in section 4.5, so the audit log and the live updates keep working.
- **After every change:** update `APP_VERSION` near the top of `app.js`. Then upload, hard-refresh (Ctrl+Shift+R) and check the version in the footer.
