/**
 * Kwazy Korndog — staff app backend (Google Apps Script, bound to your KK Staff Google Sheet).
 *
 * First time:  Extensions → Apps Script → paste this whole file → Save → run `setup` once (allow Sheets, Drive, Gmail, triggers).
 *              setup creates the first admin account "jay" and prints its temporary password in the Execution log.
 * Then:        Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → copy the /exec URL
 *              into KK_API at the top of kk.js.
 * After edits: Deploy → Manage deployments → ✏️ → Version: New version → Deploy (keeps the same URL).
 *
 * Roles:  crew    — clock in/out, evidence, stop sale, stock take, my shifts and hours, notices, handbook, expense claims
 *         manager — everything an admin can do, except: approve their own claims or fix their own hours,
 *                   manage admins/managers or change roles, change settings or delete history
 *         admin   — everything (Jay, Hazel)
 *
 * A shift day at an event:  clock in → opening evidence → stop sale → stock take → closing evidence → clock out.
 * The roster only produces flags (late, no-show, left early). The last person clocked in at an event can't clock
 * out until stock take + closing evidence are in (or they give a reason, which is flagged).
 *
 * The Sheet is the database. Day-to-day editing happens in the app's Admin screens; you don't need to open it.
 */

const TZ = 'Asia/Singapore';
const PHOTO_FOLDER = 'KK Clock-in Photos';
const MAX_PHOTO_CHARS = 4e6;      // ~3 MB image; the page shrinks photos to ~200 KB first
const FIRST_ADMIN = 'jay';
const SESSION_DAYS = 30;
const MAX_LOGIN_TRIES = 5;        // wrong passwords per username before a 10-minute lockout
const ROLES = ['crew', 'manager', 'admin'];
const CLAIM_CATEGORIES = ['Ingredients', 'Packaging', 'Transport', 'Equipment', 'Other'];
const COLOURS = ['green', 'purple', 'orange', 'pink', 'blue', 'yellow', 'teal', 'grey'];

// Checklist Type: photo · tick · yesno · choice (Options split by |) · text · stock (the stock count) · cash (HitPay vs deposit)
const TABS = {
  users:     ['Username', 'Name', 'Role', 'Phone', 'Active', 'Must change password', 'Token version', 'Password hash', 'Salt', 'Created', 'Pay type', 'Rate'],
  events:    ['Event', 'Location', 'Start date', 'End date', 'Colour', 'Active', 'Stock template'],
  roster:    ['ID', 'Date', 'Event', 'Username', 'Start', 'End', 'Type', 'Note', 'Updated by', 'Lead'],   // Lead Y = in charge of the checklist
  checklist: ['Shift', 'Step', 'Item', 'Detail', 'Critical', 'Type', 'Options', 'Show if', 'Flag if', 'Handbook'],
  stock:     ['Category', 'Item', 'Unit', 'Minimum', 'Allow N/A', 'Active'],
  settings:  ['Setting', 'Value'],
  prompts:   ['Category', 'Prompt', 'Emoji', 'Active'],
  promptLog: ['Date', 'Category', 'Prompt', 'Emoji'],
  timesheet: ['Date', 'Staff', 'Event', 'Clock in', 'Clock out', 'Hours', 'Roster', 'Late (min)', 'Clock-out flag',
              'Prompt', 'In photo', 'Out photo', 'Note'],
  dayLog:    ['Date', 'Event', 'Status', 'First clock-in', 'Opening done', 'Opening by', 'Stop sale', 'Stop sale by',
              'Early stop reason', 'Stock take done', 'Stock take by', 'Closing done', 'Closing by', 'Mins stop sale → closing',
              'Last clock-out', 'Opening photos', 'Closing photos', 'Report sent'],
  alerts:    ['ID', 'Timestamp', 'Date', 'Event', 'Alert', 'Resolved by', 'Resolved at', 'Resolution note'],
  // Opening / Closing Log also grow one column per question (e.g. "Oil status") the first time it is answered.
  openLog:   ['Timestamp', 'Date', 'Event', 'Staff', 'Skipped', 'Photos', 'Notes'],
  closeLog:  ['Timestamp', 'Date', 'Event', 'Staff', 'HitPay total sales', 'HitPay cash sales', 'PayNow sales', 'Orders', 'Cash deposit', 'Cash difference',
              'Skipped', 'Photos', 'Remarks'],
  stockLog:  ['Timestamp', 'Date', 'Event', 'Staff', 'Category', 'Item', 'Unit', 'Count', 'Minimum', 'Below minimum', 'Type'],   // Type: opening (sent by manager) · closing (crew count)
  stockTpl:  ['Template', 'Category', 'Item', 'Minimum', 'Top up'],       // blank Minimum = not carried at that kind of event
  eventStock:['Event', 'Category', 'Item', 'Minimum', 'Top up'],
  photoLog:  ['Timestamp', 'Date', 'Event', 'Shift', 'Staff', 'Step', 'Item', 'File ID', 'Link'],
  audit:     ['Timestamp', 'By', 'Action', 'Details'],
  notices:   ['ID', 'Created', 'By', 'Title', 'Body', 'Photo', 'Pinned', 'Audience', 'Expires', 'Must acknowledge', 'Active'],
  noticeAcks:['Notice ID', 'Username', 'At'],
  handbook:  ['ID', 'Order', 'Section', 'Title', 'Body', 'Photos', 'Version', 'Updated', 'Updated by', 'Active', 'Pointers'],
  bookAcks:  ['Section ID', 'Version', 'Username', 'At'],
  payslips:  ['ID', 'Period', 'Username', 'Name', 'Status', 'Pay type', 'Rate', 'Hours', 'Basic', 'Allowances', 'Claims', 'Deductions',
              'CPF employee', 'CPF employer', 'Gross', 'Net', 'Total paid', 'Notes', 'Pay date', 'Published by', 'Published at'],
  cash:      ['ID', 'Date', 'Event', 'Closed by', 'Amount', 'Status', 'Received by', 'Received at', 'Received amount',
              'Banked by', 'Banked at', 'Banked amount', 'Slip', 'Notes', 'Method', 'Verified by', 'Verified at',
              'HitPay total sales', 'HitPay cash sales', 'PayNow sales', 'Orders', 'Sales checked by', 'Sales checked at', 'Cash difference',
              'Query', 'Reply', 'Query resolved'],
              // Status: with closer → received (manager has it) → banked, or with closer → deposited (crew banked/transferred) → banked once a manager verifies
  claims:    ['ID', 'Submitted', 'Username', 'Date', 'Amount', 'Category', 'Where', 'Description', 'Receipt', 'Status',
              'Decided by', 'Decided at', 'Reason', 'Paid note'],
};
const NAMES = {
  users: 'Users', events: 'Events', roster: 'Roster', checklist: 'Checklist', stock: 'Stock Items', settings: 'Settings',
  prompts: 'Prompts', promptLog: 'Prompt Log', timesheet: 'Timesheet', dayLog: 'Day Log', alerts: 'Alerts',
  openLog: 'Opening Log', closeLog: 'Closing Log', stockLog: 'Stock Count Log', photoLog: 'Photo Log', audit: 'Audit',
  stockTpl: 'Stock Templates', eventStock: 'Event Stock Levels', notices: 'Notices', noticeAcks: 'Notice Acks', handbook: 'Handbook', bookAcks: 'Handbook Acks', claims: 'Expense Claims', payslips: 'Payslips', cash: 'Cash Bags',
};
const TEXT_TABS = ['users', 'events', 'roster', 'dayLog', 'promptLog', 'notices', 'handbook', 'claims', 'payslips'];   // stored as plain text so dates/times aren't converted

// Starter content, written only into empty tabs by setup(). Edit it in the Sheet afterwards.
const STARTER = {
  prompts: [
    ['Sauce bottle', 'Hold up the Ketchup bottle', '🍅', 'Y'],
    ['Sauce bottle', 'Hold up the Mentaiko bottle', '🧴', 'Y'],
    ['Sauce bottle', 'Hold up the Chilli bottle', '🌶️', 'Y'],
    ['Sauce bottle', 'Hold up the Mayonnaise bottle', '🧴', 'Y'],
    ['Sauce bottle', 'Hold up the Truffle Mayo bottle', '🧴', 'Y'],
    ['Sauce bottle', 'Hold up the Mustard bottle', '🌭', 'Y'],
    ['Item', 'Hold up a paper towel', '🧻', 'Y'],
    ['Item', 'Hold up a plastic bag', '🛍️', 'Y'],
    ['Item', 'Hold up a takeaway box', '🥡', 'Y'],
    ['Item', 'Hold up a plastic spoon', '🥄', 'Y'],
    ['Hand gesture', 'Show a peace sign', '✌️', 'Y'],
    ['Hand gesture', 'Show an open palm', '✋', 'Y'],
    ['Hand gesture', 'Give a thumbs up', '👍', 'Y'],
    ['Hand gesture', 'Show an OK sign', '👌', 'Y'],
    ['Hand gesture', 'Do a fist bump at the camera', '👊', 'Y'],
    ['Other', 'Selfie with the booth behind you', '🤳', 'Y'],
    ['Other', 'Hold a packet of corndogs', '🌭', 'Y'],
    ['Other', 'Hold a sauce or seasoning packet (Mala, sugar or sour cream)', '🧂', 'Y'],
    ['Other', 'Hold a Nutella tub', '🍫', 'Y'],
    ['Other', 'Hold a pair of tongs', '🥢', 'Y'],
  ],
  // [Shift, Step, Item, Detail, Critical, Type, Options, Show if, Flag if] — Shift is Opening, Closing or Stock
  checklist: [
    // Opening evidence — Event Crew Handbook v1.0 steps 2–8, as revised by Jay
    ['Opening', 'Canvas', 'Photo of the canvas', '', 'Y', 'photo'],
    ['Opening', 'Canvas', 'Canvas removed and neatly folded', '', 'Y', 'tick'],
    ['Opening', 'Fryer & oil', 'Photo of the oil in the fryer', 'Show the oil level and colour', 'Y', 'photo'],
    ['Opening', 'Fryer & oil', 'Oil OK?', 'OK → refill to the MAX line. Not OK → change the oil.', 'Y', 'yesno'],
    ['Opening', 'Fryer & oil', 'Oil changed?', '', 'Y', 'yesno', '', 'Oil OK? = No', 'No'],
    ['Opening', 'Sauces & powders', 'Photo of the sauces and powders', '', 'Y', 'photo'],
    ['Opening', 'Sauces & powders', 'Sauces and powders refilled', '', 'Y', 'tick'],
    ['Opening', 'Cashier / POS', 'Photo of the cashier station', '', 'Y', 'photo'],
    ['Opening', 'Cashier / POS', 'HitPay on, battery or power OK', '', 'Y', 'tick'],
    ['Opening', 'Cashier / POS', 'Internet connected', 'Offline → reconnect Wi-Fi or mobile data and retry', 'Y', 'tick'],
    ['Opening', 'Cashier / POS', 'Receipt printer has paper', '', 'Y', 'tick'],
    ['Opening', 'Fryer station', 'Photo of the fryer station', '', 'Y', 'photo'],
    ['Opening', 'Fryer station', 'Fryer table set up', '', 'N', 'tick'],
    ['Opening', 'Fryer station', 'Tongs and tools ready', '', 'N', 'tick'],
    ['Opening', 'Fryer station', 'Station clean and organised', '', 'N', 'tick'],
    ['Opening', 'Saucing station', 'Photo of the saucing station', '', 'Y', 'photo'],
    ['Opening', 'Saucing station', 'Sauces, powders and packaging arranged', '', 'N', 'tick'],
    ['Opening', 'Saucing station', 'Station clean and organised', '', 'N', 'tick'],
    ['Opening', 'Freezer & FIFO', 'Photo inside the freezer', 'Show how the stock is arranged', 'Y', 'photo'],
    ['Opening', 'Freezer & FIFO', 'Oldest stock (by MFG date) moved to the top / front', '', 'Y', 'tick'],
    ['Opening', 'Freezer & FIFO', 'Flavours separated and clearly identified', '', 'N', 'tick'],

    // Closing evidence — Event Closing Checklist, sections B–G (stock take has its own tab)
    ['Closing', 'Utensils & equipment', 'Photo of the washed utensils and equipment', '', 'Y', 'photo'],
    ['Closing', 'Utensils & equipment', 'All used utensils, containers and removable equipment washed, rinsed and dried', '', 'Y', 'tick'],
    ['Closing', 'Fryer & fryer table', 'Photo of the fryer area', '', 'Y', 'photo'],
    ['Closing', 'Fryer & fryer table', 'Fryer exterior, fryer table and crumbs cleaned safely', '', 'Y', 'tick'],
    ['Closing', 'POS / cashier table', 'Photo of the cashier station', '', 'Y', 'photo'],
    ['Closing', 'POS / cashier table', 'Cashier area wiped and organised', '', 'Y', 'tick'],
    ['Closing', 'Saucing table', 'Photo of the saucing table', '', 'Y', 'photo'],
    ['Closing', 'Saucing table', 'Table, sauce bottles and powder containers wiped, residue removed', '', 'Y', 'tick'],
    ['Closing', 'Sink', 'Photo of the sink', '', 'Y', 'photo'],
    ['Closing', 'Sink', 'Sink cleaned, food debris removed', '', 'Y', 'tick'],
    ['Closing', 'Rubbish', 'Photo of the rubbish area', '', 'Y', 'photo'],
    ['Closing', 'Rubbish', 'Rubbish bags tied and disposed', '', 'Y', 'tick'],
    ['Closing', 'Rubbish', 'New bag put in', '', 'Y', 'tick'],
    ['Closing', 'Fryer oil & power', 'Photo of the fryer oil', '', 'Y', 'photo'],
    ['Closing', 'Fryer oil & power', 'Oil status', 'TBC: exact filtering, refilling and changing procedure. Ask the manager, do not improvise.', 'Y', 'choice',
      'Filtered — refill needed | Filtered — no refill needed | Oil needs changing', '', 'Oil needs changing'],
    ['Closing', 'Fryer oil & power', 'Fryer switched OFF', '', 'Y', 'tick'],
    ['Closing', 'Fryer oil & power', 'Non-essential electrical equipment switched OFF', '', 'Y', 'tick'],
    ['Closing', 'Fryer oil & power', 'Freezer is still ON', 'Never switch the freezer off', 'Y', 'tick'],
    ['Closing', 'Sauces & powders', 'Photo of the stored sauces and powders', '', 'Y', 'photo'],
    ['Closing', 'Sauces & powders', 'Sauces stored properly', 'TBC: exact overnight storage. Ask the manager.', 'Y', 'tick'],
    ['Closing', 'Sauces & powders', 'Seasoning powders', '', 'Y', 'choice', 'All dry and fine | Clumpy or wet — emptied and washed'],
    ['Closing', 'Sauces & powders', 'Which powders?', '', 'Y', 'text', '', 'Seasoning powders = Clumpy or wet — emptied and washed'],
    ['Closing', 'Cash deposit', 'Photo of the cash deposit', '', 'Y', 'photo'],
    ['Closing', 'Cash deposit', 'Cash check', 'TBC: exact cash deposit and handover procedure. Ask the manager.', 'Y', 'cash'],
    ['Closing', 'Damage & incidents', 'Any damaged or missing equipment, discrepancies or other incidents?', 'Serious or unresolved → tell the manager now', 'Y', 'yesno', '', '', 'Yes'],
    ['Closing', 'Final inspection', 'Photo of the whole booth before leaving', '', 'Y', 'photo'],
    ['Closing', 'Final inspection', 'Booth clean, tidy and safely secured', 'TBC: exact locking / security procedure. Ask the manager.', 'Y', 'tick'],

    // Stock take tab
    ['Stock', 'Stock count', 'Count all stock', 'Count 8-piece and 5-piece packs separately. Enter what is really there, never guess.', 'Y', 'stock'],
    ['Stock', 'Damaged stock', 'Any damaged, thawed or unsafe stock?', 'Yes → separate it, do not sell it, tell the manager', 'Y', 'yesno', '', '', 'Yes'],
  ],
  // [Category, Item, Unit, Minimum, Allow N/A, Active] — a count BELOW the minimum is flagged (equal is fine)
  stock: [
    ['Event corndogs (8-piece packs)', 'Classic', 'packs', 12, 'N', 'Y'],
    ['Event corndogs (8-piece packs)', 'Cheesy', 'packs', 8, 'N', 'Y'],
    ['Event corndogs (8-piece packs)', 'Potato', 'packs', 5, 'N', 'Y'],
    ['Event corndogs (8-piece packs)', 'Ramen', 'packs', 2, 'N', 'Y'],
    ['Event corndogs (8-piece packs)', 'Sausage', 'packs', 2, 'N', 'Y'],
    ['Event corndogs (8-piece packs)', 'Cheesy Sausage', 'packs', 2, 'N', 'Y'],
    ['Frozen corndogs (5-piece packs)', 'Classic', 'packs', 6, 'N', 'Y'],
    ['Frozen corndogs (5-piece packs)', 'Cheesy', 'packs', 6, 'N', 'Y'],
    ['Frozen corndogs (5-piece packs)', 'Potato', 'packs', 3, 'N', 'Y'],
    ['Frozen corndogs (5-piece packs)', 'Ramen', 'packs', 1, 'N', 'Y'],
    ['Frozen corndogs (5-piece packs)', 'Sausage', 'packs', 1, 'N', 'Y'],
    ['Frozen corndogs (5-piece packs)', 'Cheesy Sausage', 'packs', 2, 'N', 'Y'],
    ['Sauces & seasonings', 'Sugar', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Ketchup', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Chilli', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Mustard', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Mayo', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Mentaiko', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Buldak', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Truffle', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Nacho', 'packets', 2, 'Y', 'Y'],
    ['Sauces & seasonings', 'Mala', 'packets', 1, 'Y', 'Y'],
    ['Sauces & seasonings', 'Sour Cream', 'packets', 1, 'Y', 'Y'],
    ['Sauces & seasonings', 'Cheesy Powder', 'packets', 1, 'Y', 'Y'],
    ['Sauces & seasonings', 'Nutella', 'tubs', 1, 'Y', 'Y'],
    ['Sauces & seasonings', 'Sprinkles', 'packets', 1, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Gloves M', 'boxes', 1, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Gloves L', 'boxes', 1, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Paper towel', 'rolls', 2, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Plastic spoon', 'packs', 0, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Soap', 'bottles', 0, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Takeaway box', 'rolls', 3, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Plastic bag', 'rolls', 4, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Receipt roll', 'rolls', 2, 'Y', 'Y'],
    ['Miscellaneous supplies', 'Oil tin', 'tins', 1, 'Y', 'Y'],
  ],
  // Starter handbook, from the Event Crew Handbook v1.0 (13 Oct 2026), with clock-in/closing steps updated for this app.
  // [ID, Order, Section, Title, Intro, Photos, Version, Updated, Updated by, Active, Pointers (JSON: [{t: text, p: photo link}])]
  handbook: [
    ['hb01', 1, 'Start here', 'Quick answers', '**TBC** means the procedure has not been confirmed yet. Don\'t guess; ask the manager.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Where do I clock in?** Scan the booth QR, log in, pick the event and take today\'s selfie check. Then upload your opening evidence.", "p": ""}, {"t": "**Where do I clock out?** At the end: tap **Stop sale**, do the stock take and closing evidence, then clock out. Opening and closing staff can be different people.", "p": ""}, {"t": "**Fryer temperature?** **170°C**. Duration **TBC**. Corndogs must be **fully submerged**.", "p": ""}, {"t": "**How to sauce?** Neat **zigzag** pattern. Photo reference **TBC**.", "p": ""}, {"t": "**How to powder?** Apply inside a container; coat **all sides** evenly.", "p": ""}, {"t": "**How many sauces?** **Maximum 2 standard sauces**. More than 2 only when additional special sauces are purchased.", "p": ""}, {"t": "**When to warn about delays?** If waiting time is **more than 10 minutes**, tell the customer politely before payment.", "p": ""}, {"t": "**When to report low stock?** **ASAP when any corndog flavour falls below 3 packets**.", "p": ""}, {"t": "**FIFO rule?** Use the **MFG date**; oldest stock first, oldest stock **on top**.", "p": ""}, {"t": "**Stock counts?** Count **8-piece** and **5-piece** packs separately.", "p": ""}, {"t": "**Thawed or damaged stock?** Separate it, **do not sell**, tell the manager.", "p": ""}, {"t": "**HitPay offline?** Reconnect Wi-Fi or mobile data and retry; escalate if unresolved.", "p": ""}, {"t": "**Customer says they paid but HitPay shows no payment?** Check transaction history; **do not release the order until verified**.", "p": ""}, {"t": "**Who can refund?** The cashier or manager, if they know the correct procedure.", "p": ""}, {"t": "**What to do during downtime?** Wipe tables, make sure there are no crumbs, restock and organise.", "p": ""}, {"t": "**When to wash utensils?** At closing, except contaminated utensils, which must be cleaned before reuse.", "p": ""}, {"t": "**Who to contact in emergencies?** First contact **TBC**. For fire or serious medical emergencies call **995**.", "p": ""}]'],
    ['hb02', 2, 'Start here', 'Staff responsibilities & basic rules', '', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "Arrive punctually and be ready to work at the scheduled shift time.", "p": ""}, {"t": "Complete the clock-in before starting opening duties.", "p": ""}, {"t": "Maintain personal hygiene and wear the required work attire.", "p": ""}, {"t": "Keep all stations clean, organised and stocked throughout the shift.", "p": ""}, {"t": "Do not sit around or use personal phones unnecessarily during working hours.", "p": ""}, {"t": "During quiet periods, proactively clean, replenish stock and prepare for customers.", "p": ""}, {"t": "Follow the assigned frying, saucing and cashier responsibilities.", "p": ""}, {"t": "Treat customers politely and communicate issues promptly.", "p": ""}, {"t": "Do not leave the booth unattended.", "p": ""}, {"t": "Complete all required opening or closing photos and checklists accurately.", "p": ""}]'],
    ['hb03', 3, 'Daily SOPs', 'Opening SOP', 'Check-in time and opening completion time are recorded separately.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Arrive and clock in:** Scan the booth QR, log in, pick the event and take today\'s selfie check.", "p": ""}, {"t": "**Canvas & Booth Setup:** Unfold and secure canvas. Ensure booth is clean and ready. Upload canvas photo.", "p": ""}, {"t": "**Fryer & Oil:** Check oil condition and level, select oil status and upload photo. Prepare fryer.", "p": ""}, {"t": "**Sauces & Powders:** Refill and arrange sauces and powders; clean bottles and containers. Upload photo.", "p": ""}, {"t": "**Cashier / POS:** Set up cashier, check POS and payment station. Upload photo.", "p": ""}, {"t": "**Fryer Station:** Set up fryer table, tongs and tools; clean and organise. Upload photo.", "p": ""}, {"t": "**Saucing Station:** Arrange sauces, powders and packaging. Upload photo.", "p": ""}, {"t": "**Freezer & FIFO:** Check frozen stock, rotate older stock to front/top by MFG date. Upload photo.", "p": ""}, {"t": "**Upload opening evidence:** In the app, add the photos and ticks (any order), submit and check it says submitted.", "p": ""}]'],
    ['hb04', 4, 'Daily SOPs', 'Frying SOP', '**Temperature: 170°C. Duration: TBC. Corndogs must be fully submerged in oil.**\n\n**TBC — exact frying duration.** Until confirmed, ask the manager for the approved timing; do not invent one.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Prepare the Fryer:** Check cleanliness, correct oil level and temperature before frying.", "p": ""}, {"t": "**Retrieve Frozen Corndogs:** Take only required quantity; keep remaining stock frozen; follow FIFO.", "p": ""}, {"t": "**Fry the Corndogs:** Lower carefully using approved method; fully submerge. Follow confirmed cooking time when available.", "p": ""}, {"t": "**Monitor During Frying:** Check for even frying; do not overcrowd fryer.", "p": ""}, {"t": "**Check Product Quality:** Evenly golden and fully cooked; never serve burnt, damaged or undercooked products.", "p": ""}, {"t": "**Drain Excess Oil:** Drain before passing to saucing station.", "p": ""}, {"t": "**Hand Over for Saucing:** Confirm correct customer order.", "p": ""}, {"t": "**Maintain Frying Station:** Remove crumbs safely with strainer, clean oil stains safely, monitor oil condition.", "p": ""}]'],
    ['hb05', 5, 'Daily SOPs', 'Saucing SOP', '**Sauce policy:** Maximum **2 standard sauces**. More than 2 only if customer purchases additional special sauces. **TBC — photo of correct zigzag pattern.**', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Confirm Customer Order:** Check sauce/seasoning requested.", "p": ""}, {"t": "**Prepare Corndog:** Drain excess oil first.", "p": ""}, {"t": "**Apply Sauces:** Apply evenly and neatly in **zigzag pattern**.", "p": ""}, {"t": "**Apply Powders:** Apply **inside a container**, coating **all sides** evenly; avoid clumps or excessive powder.", "p": ""}, {"t": "**Maintain Presentation:** Appetising finish, without unnecessary drips on packaging.", "p": ""}, {"t": "**Special Requests:** Follow permitted combinations and reduced sauce requests.", "p": ""}, {"t": "**Serve Correct Order:** Double-check flavour and sauces.", "p": ""}, {"t": "**Maintain Station:** Wipe spills and bottle nozzles; refill supplies.", "p": ""}]'],
    ['hb06', 6, 'Daily SOPs', 'Cashier & HitPay POS SOP', '**System:** HitPay. **Payments:** Cash, PayNow. **Refund/void/discount authority:** Cashier or manager if they know the correct procedure.\n\n**HitPay quick fixes:** Offline → reconnect mobile data/Wi-Fi. No paper → correctly replace receipt roll. Logged out → log in again. Payment not showing → check transaction history and withhold order until verified.\n\n**TBC — screenshots** for login, order entry, payment check, refunds/voids and receipt paper replacement.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Prepare POS:** Switch on, check battery/power, internet and receipt printer.", "p": ""}, {"t": "**Greet Customer:** Welcome them; recommend if needed.", "p": ""}, {"t": "**Take Order:** Confirm flavours, quantities, sauces and charges.", "p": ""}, {"t": "**Enter Order:** Select correct products and quantities; double-check before payment.", "p": ""}, {"t": "**Collect Payment:** Confirm total and chosen method.", "p": ""}, {"t": "**Cash:** Enter received amount and give correct change.", "p": ""}, {"t": "**Cashless:** Verify successful payment before releasing order; do not rely solely on screenshot.", "p": ""}, {"t": "**Communicate to Crew:** Make order clear to fryer/saucing staff.", "p": ""}, {"t": "**Handle Mistakes:** Correct order/payment using approved method. Cashier or manager may process refund if competent in procedure.", "p": ""}, {"t": "**Keep Area Organised:** Keep POS, printer, cash drawer and table tidy.", "p": ""}]'],
    ['hb07', 7, 'Daily SOPs', 'Customer service SOP', '**Food quality complaint:** Inspect, apologise, offer appropriate **refund or replacement** and report recurring issues. **Wrong order:** Verify, apologise and replace or refund. **Difficult customer:** Remain calm and reasonable, apologise where appropriate. If beyond your ability, step away and ask manager to assist.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Greet Every Customer:** Acknowledge politely, even when busy.", "p": ""}, {"t": "**Know Menu:** Understand flavours, fillings, sauces, seasonings and prices.", "p": ""}, {"t": "**Recommend Products:** Help without pressuring.", "p": ""}, {"t": "**Confirm Orders:** Repeat when needed, especially large or special orders.", "p": ""}, {"t": "**Waiting Times:** If **over 10 minutes**, politely inform **before payment**; update if longer.", "p": ""}, {"t": "**Complaints:** Listen, remain polite; do not argue or blame customer.", "p": ""}, {"t": "**Order Mistakes:** Check and arrange appropriate replacement, refund or escalation.", "p": ""}, {"t": "**Professional Behaviour:** No arguments, work complaints or inappropriate language in front of customers.", "p": ""}, {"t": "**Busy Periods:** Coordinate clearly and do not neglect customers.", "p": ""}, {"t": "**Thank Customers:** Thank after serving.", "p": ""}]'],
    ['hb08', 8, 'Daily SOPs', 'Stock management & FIFO', '**Important:** During-service **below-3-packet** warning is separate from automated closing stock take minimums (see Restock minimums).', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Opening Stock Check:** Check flavours, sauces, powders and essential supplies.", "p": ""}, {"t": "**FIFO:** Use **MFG date**. Oldest first; place oldest **on top**.", "p": ""}, {"t": "**Frozen Storage:** Keep frozen until needed; do not leave unused frozen stock out.", "p": ""}, {"t": "**Freezer Organisation:** Separate and identify flavours clearly.", "p": ""}, {"t": "**Monitor Stock:** Check regularly; tell manager **ASAP below 3 packets** for any flavour.", "p": ""}, {"t": "**Replenish:** Check incoming flavour, quantity and condition; place newer stock behind/below older.", "p": ""}, {"t": "**Damaged/Thawed:** Separate, **do not sell**, inform manager.", "p": ""}, {"t": "**Closing Count:** Count **8-piece** and **5-piece** packs separately, plus sauces, powders and supplies in the app.", "p": ""}, {"t": "**Low Stock:** Enter accurate counts so the app generates alerts.", "p": ""}, {"t": "**Avoid Wastage:** Do not take out excessive frozen stock or handle carelessly.", "p": ""}]'],
    ['hb09', 9, 'Daily SOPs', 'Clean-as-you-go SOP', '', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Clean Throughout Shift:** Do not wait until closing.", "p": ""}, {"t": "**Wipe Spills Immediately:** Safely clean sauces, oil, sugar and powder.", "p": ""}, {"t": "**Fryer Station:** Remove crumbs with strainer and clean oil stains safely.", "p": ""}, {"t": "**Saucing Station:** Clean nozzles, powder spills and table.", "p": ""}, {"t": "**Cashier Station:** Keep POS and customer-facing table tidy.", "p": ""}, {"t": "**Wash Equipment:** Wash, rinse and dry utensils/containers **at closing**. Contaminated utensils must be cleaned before reuse.", "p": ""}, {"t": "**Rubbish:** Tie bags properly, dispose of them and **replace bag immediately**.", "p": ""}, {"t": "**Downtime:** Wipe tables, ensure **no crumbs**, restock and organise.", "p": ""}, {"t": "**Hygiene:** Wash hands when needed; avoid cross-contamination.", "p": ""}, {"t": "**Shared Responsibility:** Everyone cleans regardless of assigned station.", "p": ""}]'],
    ['hb10', 10, 'Daily SOPs', 'Closing SOP', '**Four closing procedures TBC:** oil filtering/refill/change; overnight sauce/powder storage; cash deposit; securing/locking booth. Ask manager until confirmed.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Stop sale:** Tap **Stop sale** on the hub when you stop serving. Before the stop-sale time you\'ll need a reason.", "p": ""}, {"t": "**Wash & Dry:** Wash, rinse, dry utensils, containers and removable equipment. Upload photo.", "p": ""}, {"t": "**Fryer & Table:** Clean fryer exterior, table and debris; follow oil procedure. Upload photo.", "p": ""}, {"t": "**POS & Cashier:** Wipe and organise. Upload photo.", "p": ""}, {"t": "**Saucing Table:** Wipe table, bottles and containers. Upload photo.", "p": ""}, {"t": "**Sink:** Clean sink, remove debris and dirty equipment. Upload photo.", "p": ""}, {"t": "**Oil:** Choose correct status: filtered/refill to MAX line; filtered/no refill; or need to change. Upload photo. **Exact oil handling procedure **TBC**.**", "p": ""}, {"t": "**Sauces & Powders:** Store sauces correctly. If powder is wet/clumpy, empty and wash container. Upload photo. **Exact overnight storage TBC.**", "p": ""}, {"t": "**Rubbish:** Tie/dispose of bags; replace bag. Upload photo.", "p": ""}, {"t": "**Equipment & Freezer:** Switch off fryer and non-essential equipment; **freezer remains ON**.", "p": ""}, {"t": "**Stock Count:** Count 8-piece and 5-piece packs separately plus sauces, powders and supplies; enter accurately.", "p": ""}, {"t": "**Cash Deposit:** Count cash, enter amount and upload required photo. **Exact deposit procedure TBC.**", "p": ""}, {"t": "**Damage/Issues:** Record damaged or missing equipment and other issues.", "p": ""}, {"t": "**Final Inspection:** Leave booth clean, tidy and secured; upload final photo. **Exact locking/security procedure TBC.**", "p": ""}, {"t": "**Submit and clock out:** Submit the stock take and closing evidence in the app, check both say submitted, then clock out. The last person on site can\'t clock out until both are in.", "p": ""}]'],
    ['hb11', 11, 'Troubleshooting', 'Common questions & problems', '', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**POS has no internet:** Reconnect to mobile data or Wi-Fi. Check connection and retry. If still not working, contact manager.", "p": ""}, {"t": "**Receipt printer has no paper:** Replace receipt roll correctly and check paper feeds properly.", "p": ""}, {"t": "**HitPay keeps logging out:** Log back into HitPay and check internet connection.", "p": ""}, {"t": "**Customer says they paid, but POS shows no payment:** Check transaction history. **Do not release order until payment is verified.** Escalate if unclear.", "p": ""}, {"t": "**Customer wants refund:** Check reason and transaction. Cashier or manager may process if they know correct procedure.", "p": ""}, {"t": "**Wrong corndog:** Verify order, apologise and arrange replacement or refund.", "p": ""}, {"t": "**Complaint that corndog is raw/undercooked:** Inspect, apologise, offer suitable resolution; report recurring quality problems.", "p": ""}, {"t": "**More than 2 sauces requested:** Standard maximum is 2; additional special sauces may be purchased.", "p": ""}, {"t": "**Flavour running low:** Inform manager ASAP below 3 packets; check count accurately.", "p": ""}, {"t": "**Thawed/damaged packaging:** Separate, do not sell and inform manager.", "p": ""}, {"t": "**Fryer not heating:** Stop frying, check only obvious power issues without opening/repairing equipment; contact manager if unresolved.", "p": ""}, {"t": "**Oil looks dirty/unsuitable:** Stop using questionable oil; inform manager; follow approved replacement procedure.", "p": ""}, {"t": "**App won\'t load:** Check internet and refresh; inform manager if still failing.", "p": ""}, {"t": "**App won\'t submit:** Check required fields/photos, retry once, then inform manager if still failing.", "p": ""}, {"t": "**Aggressive customer:** Stay calm, avoid argument, step away if needed and contact manager; prioritise safety.", "p": ""}]'],
    ['hb12', 12, 'Emergencies', 'Emergency & escalation', '**Escalation details still TBC** (see the last three pointers).\n\nAlready approved: cashiers/managers competent in the procedure can process refunds, voids and discounts; appropriate refunds/replacements can be arranged for wrong orders and food complaints. For unsafe food/equipment or emergencies, stop affected operations and escalate.', '', 1, '2026-10-13', 'jay', 'Y', '[{"t": "**Fire or Smoke:** Stop operations, alert people, evacuate if necessary and call **995** for fire emergency. Use suitable extinguisher only if trained and safe. **Never use water on oil fire.**", "p": ""}, {"t": "**Hot Oil Burns:** Stop work, cool burn under **cool running water for 20 minutes**, seek medical assistance; no ice or creams. Notify manager.", "p": ""}, {"t": "**Electrical Fault / Power Trip:** Stop using affected equipment. Do not touch exposed wiring or attempt repairs. Notify manager and event organiser.", "p": ""}, {"t": "**Fryer Malfunction:** Stop frying if overheating or behaving unusually. No internal repairs. Inform manager.", "p": ""}, {"t": "**Freezer Stops:** Check obvious power issues safely; keep closed; notify manager immediately and isolate potentially thawed stock.", "p": ""}, {"t": "**Food Contamination:** Stop serving affected items; separate and notify manager. Never sell questionable food.", "p": ""}, {"t": "**Staff Injury/Illness:** Stop work, give appropriate first aid if safe, notify manager. Call **995** for serious emergency.", "p": ""}, {"t": "**Threatening Customer:** Do not argue or confront; move to safety, contact manager, seek security/police assistance if needed.", "p": ""}, {"t": "**Missing Cash/Suspected Theft:** Do not accuse without evidence. Record discrepancy, secure cash, inform manager immediately.", "p": ""}, {"t": "**Booth Damage/Missing Equipment:** Photograph, record and report; do not use unsafe equipment.", "p": ""}, {"t": "**Cannot Open On Time:** Inform manager as early as possible.", "p": ""}, {"t": "**Unexpected Event Closure:** Follow organiser instructions, secure food/equipment and notify manager.", "p": ""}, {"t": "**First contact and phone number: TBC**", "p": ""}, {"t": "**When to call versus WhatsApp: TBC**", "p": ""}, {"t": "**Full staff decision authority: TBC**", "p": ""}]'],
    ['hb13', 13, 'Reference', 'Restock minimums', 'These are the **automated restock minimums** used by the closing stock take. They\'re separate from the during-service rule to tell the manager when any corndog flavour falls below 3 packets. Counts **below** the minimum are flagged; a count equal to the minimum is fine.\n\n**Event corndogs (8-piece packs):** Classic 12 · Cheesy 8 · Potato 5 · Ramen 2 · Sausage 2 · Cheesy Sausage 2\n\n**Frozen corndogs (5-piece packs):** Classic 6 · Cheesy 6 · Potato 3 · Ramen 1 · Sausage 1 · Cheesy Sausage 2\n\n**Sauces and seasonings (packets):** Sugar 2 · Ketchup 2 · Chilli 2 · Mustard 2 · Mayonnaise 2 · Mentaiko 2 · Buldak Mayo 2 · Truffle Mayo 2 · Nacho Cheese 2 · Mala Powder 1 · Sour Cream Powder 1 · Cheesy Powder 1 · Nutella 1 · Sprinkles 1\n\n**Miscellaneous supplies:** Gloves M 1 box · Gloves L 1 box · Paper towel 2 rolls · Plastic spoon 0 · Soap 0 · Takeaway box 3 rolls · Plastic bag 4 rolls · Receipt roll 2 · Oil tin 1\n\nItems with a zero minimum still need accurate counts. Use **N/A** only where the stock take allows it.', '', 1, '2026-10-13', 'jay', 'Y', '[]'],
  ],
  settings: [
    ['Cash tolerance ($)', 5],
    ['Late after (min)', 5],              // clock-in more than this after roster start = late
    ['Stop sale before end (min)', 30],   // stop sale unlocks this long before the latest roster end at the event
    ['Report email to', ''],              // comma-separated; blank = the Google account that deployed the script
    ['Company name', 'Kwazy Korndog'],    // shown on payslips (use the registered name, e.g. ... Pte Ltd)
    ['Cash hand-in days', 3],             // crew must hand cash to a manager or bank it within this many days of closing
    ['Closing target (min)', 30],         // stop sale → clock out; closers are told if they beat it
    ['Bank transfer details', ''],        // shown to crew banking cash themselves, e.g. "PayNow UEN 202312345A (Kwazy Korndog Pte Ltd)"
  ],
};

STARTER.stockTpl = starterTemplates();

// Starting points to edit: Bazaar and 3-day use the handbook minimums; 1-day halves the corndog minimums.
// Top up = what to order up to (corndogs: double the minimum; supplies: minimum + 1).
function starterTemplates() {
  const out = [];
  [['Bazaar', 1], ['3-day event', 1], ['1-day event', 0.5]].forEach(function (t) {
    STARTER.stock.forEach(function (s) {
      const corndog = /corndogs/i.test(s[0]), min = corndog ? Math.ceil(s[3] * t[1]) : s[3];
      out.push([t[0], s[0], s[1], min, min === 0 ? 0 : corndog ? min * 2 : min + 1]);
    });
  });
  return out;
}

// ---------------------------------------------------------------- setup & menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Kwazy Korndog')
    .addItem('Set up / repair tabs', 'setup')
    .addItem('Send a test report email', 'testEmail')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(TABS).forEach(function (key) {
    let sh = ss.getSheetByName(NAMES[key]);
    if (!sh) sh = ss.insertSheet(NAMES[key]);
    if (sh.getLastRow() === 0) {
      if (TEXT_TABS.indexOf(key) >= 0) sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
      if (key === 'timesheet') sh.getRange('A:A').setNumberFormat('@');
      sh.getRange(1, 1, 1, TABS[key].length).setValues([TABS[key]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      if (STARTER[key]) {
        const w = TABS[key].length;
        const data = STARTER[key].map(function (r) { const x = r.slice(0, w); while (x.length < w) x.push(''); return x; });
        sh.getRange(2, 1, data.length, w).setValues(data);
      }
    }
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  photoFolder();   // creates the Drive folder (and asks for Drive permission on first run)
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'nightlySweep'; })) {
    ScriptApp.newTrigger('nightlySweep').timeBased().everyDays(1).atHour(3).create();
  }
  if (!readRows('users').length) {
    const temp = tempPassword();
    createUser({ username: FIRST_ADMIN, name: 'Jay', role: 'admin' }, temp);
    const msg = 'First admin login → username: ' + FIRST_ADMIN + '   temporary password: ' + temp + '   (you will set your own after logging in)';
    Logger.log(msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (err) { /* run from the editor: read it in the Execution log */ }
  }
}

function testEmail() {
  MailApp.sendEmail({ to: reportTo(), subject: 'Kwazy Korndog: test report email',
    htmlBody: '<p>Daily event reports will arrive at this address. 🌭</p>' });
}

// 3am: send the report for any earlier day nobody finished (e.g. nobody clocked out).
function nightlySweep() {
  const today = fmt(new Date(), 'yyyy-MM-dd');
  readRows('dayLog').forEach(function (r) {
    if (!r['Report sent'] && dstr(r.Date) < today) { try { sendReport(String(r.Event), dstr(r.Date)); } catch (err) {} }
  });
}

// ---------------------------------------------------------------- web app

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'config';
  if (action === 'config') return json(getConfig());
  return json({ ok: false, error: 'Unknown action' });
}

// Actions for managers and admins. Finer limits for managers are inside each function.
const MGR_ACTIONS = ['rosterWeek', 'rosterSave', 'rosterDelete', 'rosterCopyWeek', 'users', 'userSave', 'userReset', 'events', 'eventSave', 'audit',
                     'hoursList', 'fixShift', 'payrollList', 'payslipSave', 'payrollPublish', 'cashList', 'cashReceive', 'cashBank', 'cashVerify', 'cashSalesCheck', 'cashResolve', 'salesSummary',
                     'live', 'fixClockOut', 'resolveAlert', 'stockOverview', 'stockLevelsSave', 'templates', 'templateSave', 'openingStock', 'noticeSave', 'noticeAcks', 'handbookSave', 'claimsAll', 'claimDecide', 'claimPaid'];
function isMgr(u) { return u.role === 'admin' || u.role === 'manager'; }

// Actions that only read. They skip the lock so several can run at once (the lock is only for saving).
const READ_ACTIONS = ['login', 'me', 'home', 'myShifts', 'status', 'live', 'rosterWeek', 'users', 'events', 'audit', 'notices', 'noticeAcks',
                      'handbook', 'claims', 'claimsAll', 'stockItems', 'stockOverview', 'templates', 'hoursList', 'payrollList', 'myPayslips',
                      'cashList', 'myCash', 'salesSummary'];

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'Bad request' }); }

  const lock = READ_ACTIONS.indexOf(d.action) >= 0 ? null : LockService.getScriptLock();
  if (lock) { try { lock.waitLock(25000); } catch (err) { return json({ ok: false, error: 'Busy, please tap again.' }); } }
  try {
    if (d.action === 'login') return json(login(d));
    const a = auth(d.token);
    if (a.error) return json({ ok: false, auth: true, error: a.error });
    const u = a.user;
    if (d.action === 'changePassword') return json(changePassword(u, d));
    if (u.mustChange) return json({ ok: false, mustChange: true, error: 'Set your own password first.' });
    if (MGR_ACTIONS.indexOf(d.action) >= 0 && !isMgr(u)) return json({ ok: false, error: 'Only managers and admins can do that.' });
    const event = clean(d.event);
    switch (d.action) {
      case 'me':             return json(meInfo(u));
      case 'home':           return json(home(u));
      case 'myShifts':       return json(myShifts(u));
      case 'clock':          return json(clock(u, d));
      case 'status':         return json(status(u, event));
      case 'live':           return json(live(u));
      case 'fixClockOut':    return json(fixClockOut(u, d));
      case 'resolveAlert':   return json(resolveAlert(u, d));
      case 'rosterWeek':     return json(rosterWeek(d));
      case 'rosterSave':     return json(rosterSave(u, d));
      case 'rosterDelete':   return json(rosterDelete(u, d));
      case 'rosterCopyWeek': return json(rosterCopyWeek(u, d));
      case 'users':          return json(usersList());
      case 'userSave':       return json(userSave(u, d));
      case 'userReset':      return json(userReset(u, d));
      case 'events':         return json({ ok: true, events: eventsList(false), colours: COLOURS });
      case 'eventSave':      return json(eventSave(u, d));
      case 'audit':          return json(auditList());
      case 'notices':        return json(noticesList(u));
      case 'noticeAck':      return json(noticeAck(u, d));
      case 'noticeSave':     return json(noticeSave(u, d));
      case 'noticeAcks':     return json(noticeAcks(d));
      case 'handbook':       return json(handbookList(u));
      case 'handbookAck':    return json(handbookAck(u, d));
      case 'handbookSave':   return json(handbookSave(u, d));
      case 'claims':         return json(claimsMine(u));
      case 'claimSubmit':    return json(claimSubmit(u, d));
      case 'claimsAll':      return json(claimsAll(u));
      case 'claimDecide':    return json(claimDecide(u, d));
      case 'claimPaid':      return json(claimPaid(u, d));
      case 'stockItems':     return json({ ok: true, items: eventLevels(event).map(function (s) {                 // crew just count; minimums are for managers
                               return isMgr(u) ? s : { category: s.category, item: s.item, unit: s.unit, na: s.na, min: '', top: '' }; }) });
      case 'stockOverview':  return json(stockOverview());
      case 'stockLevelsSave':return json(stockLevelsSave(u, d));
      case 'templates':      return json(templatesList());
      case 'templateSave':   return json(templateSave(u, d));
      case 'openingStock':   return json(openingStock(u, d));
      case 'hoursList':      return json(hoursList(d));
      case 'fixShift':       return json(fixShift(u, d));
      case 'payrollList':    return json(payrollList(u, d));
      case 'payslipSave':    return json(payslipSave(u, d));
      case 'payrollPublish': return json(payrollPublish(u, d));
      case 'myPayslips':     return json(myPayslips(u));
      case 'cashList':       return json(cashList());
      case 'cashReceive':    return json(cashReceive(u, d));
      case 'cashBank':       return json(cashBank(u, d));
      case 'cashVerify':     return json(cashVerify(u, d));
      case 'cashSalesCheck': return json(cashSalesCheck(u, d));
      case 'cashResolve':    return json(cashResolve(u, d));
      case 'cashReply':      return json(cashReply(u, d));
      case 'myCash':         return json(myCash(u));
      case 'cashDeposit':    return json(cashDeposit(u, d));
      case 'salesSummary':   return json(salesSummary(d));
    }
    // Everything below needs the person to be clocked in at that event today.
    if (!clockedIn(u.username, event)) return json({ ok: false, error: 'You are not clocked in at ' + event + ' today. Clock in first.' });
    switch (d.action) {
      case 'photo':     return json(savePhotoItem(u.username, event, d));
      case 'stopSale':  return json(stopSale(u.username, event, d));
      case 'checklist': return json(saveChecklist(u.username, event, d, isMgr(u)));
    }
    return json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

// Settings, events, checklist and stock items change rarely, so they're kept in the script cache for 10 minutes
// (edits made straight in the Sheet show up within 10 minutes; edits made in the app clear it at once).
function getConfig() {
  const cache = CacheService.getScriptCache(), key = 'cfg_' + fmt(new Date(), 'yyyy-MM-dd');
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (err) { /* rebuild */ } }
  const c = buildConfig();
  try { cache.put(key, JSON.stringify(c), 600); } catch (err) { /* too big to cache: fine */ }
  return c;
}
function clearConfig() { CacheService.getScriptCache().remove('cfg_' + fmt(new Date(), 'yyyy-MM-dd')); }

function buildConfig() {
  const s = settingsMap();
  delete s['Report email to'];                                       // not for the public page
  return { ok: true, events: eventsList(true), checklist: checklistRows(), stock: stockRows(), settings: s, prompt: todayPrompt(true) };
}

function checklistRows() {
  const TYPES = ['photo', 'tick', 'yesno', 'choice', 'text', 'stock', 'cash'];
  return readRows('checklist').filter(function (r) { return r.Shift && r.Item; }).map(function (r) {
    const type = String(r.Type || 'tick').trim().toLowerCase();
    return { shift: String(r.Shift).trim(), step: String(r.Step || 'General').trim(), item: String(r.Item).trim(),
             detail: String(r.Detail || ''), critical: isYes(r.Critical), type: TYPES.indexOf(type) >= 0 ? type : 'tick',
             options: String(r.Options || '').split('|').map(function (o) { return o.trim(); }).filter(String),
             showIf: String(r['Show if'] || '').trim(), flagIf: String(r['Flag if'] || '').trim(),
             handbook: String(r.Handbook || '').trim() || { Opening: 'Opening SOP', Closing: 'Closing SOP', Stock: 'Stock management & FIFO' }[String(r.Shift).trim()] || '' };
  });
}

function stockRows() {
  return readRows('stock').filter(function (r) { return r.Item && isActive(r.Active); }).map(function (r) {
    return { category: String(r.Category || 'Other').trim(), item: String(r.Item).trim(), unit: String(r.Unit || ''),
             min: r.Minimum === '' ? '' : Number(r.Minimum), na: isYes(r['Allow N/A']) };
  });
}

// ---------------------------------------------------------------- accounts & sessions

function findUser(username) {
  const un = String(username || '').trim().toLowerCase(), rs = readRows('users');
  for (let i = 0; i < rs.length; i++) {
    if (String(rs[i].Username).trim().toLowerCase() === un) {
      const r = rs[i];
      return { username: String(r.Username).trim(), name: String(r.Name || r.Username), role: ROLES.indexOf(String(r.Role)) >= 0 ? String(r.Role) : 'crew',   // e.g. old 'lead' → crew
               phone: String(r.Phone || ''), active: isActive(r.Active), mustChange: isYes(r['Must change password']),
               ver: Number(r['Token version']) || 1, hash: String(r['Password hash']), salt: String(r.Salt), row: i + 2,
               payType: String(r['Pay type']) === 'monthly' ? 'monthly' : 'hourly', rate: Number(r.Rate) || 0 };
    }
  }
  return null;
}
function pub(u) { return { username: u.username, name: u.name, role: u.role, mustChange: u.mustChange }; }
function nameOf(username) { const u = findUser(username); return u ? u.name : String(username); }

function login(d) {
  const un = String(d.username || '').trim().toLowerCase();
  const cache = CacheService.getScriptCache(), key = 'fail_' + un, tries = Number(cache.get(key) || 0);
  if (tries >= MAX_LOGIN_TRIES) return { ok: false, error: 'Too many wrong passwords. Wait 10 minutes or ask an admin to reset it.' };
  const u = findUser(un);
  if (!u || !u.active || hashPw(String(d.password || ''), u.salt) !== u.hash) {
    cache.put(key, String(tries + 1), 600);
    return { ok: false, error: 'Wrong username or password.' };
  }
  cache.remove(key);
  return { ok: true, token: newToken(u), user: pub(u) };
}

function changePassword(u, d) {
  if (hashPw(String(d.old || ''), u.salt) !== u.hash) return { ok: false, error: 'Your current password is wrong.' };
  const pw = String(d.password || '');
  if (pw.length < 6) return { ok: false, error: 'Use at least 6 characters.' };
  if (pw === String(d.old)) return { ok: false, error: 'Pick a new password, not the same one.' };
  const salt = Utilities.getUuid();
  logRow('users', { 'Password hash': hashPw(pw, salt), 'Salt': salt, 'Must change password': 'N', 'Token version': u.ver + 1 }, u.row);
  const fresh = findUser(u.username);
  return { ok: true, token: newToken(fresh), user: pub(fresh) };
}

// Token = username|expiry|signature. The signature covers the user's token version, so a password reset,
// role change or deactivation logs that person out everywhere.
function auth(token) {
  const p = String(token || '').split('|');
  if (p.length !== 3) return { error: 'Please log in.' };
  if (Date.now() > Number(p[1])) return { error: 'Your session expired. Please log in again.' };
  const u = findUser(p[0]);
  if (!u || !u.active) return { error: 'This account is not active. Ask an admin.' };
  if (sign(p[0] + '|' + p[1] + '|' + u.ver) !== p[2]) return { error: 'Please log in again.' };
  return { user: u };
}
function newToken(u) { const exp = Date.now() + SESSION_DAYS * 864e5; return u.username + '|' + exp + '|' + sign(u.username + '|' + exp + '|' + u.ver); }
function sign(s) { return hex(Utilities.computeHmacSha256Signature(s, secret())); }
function secret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('SESSION_SECRET', s); }
  return s;
}
function hashPw(pw, salt) {
  let h = salt + ':' + pw;
  for (let i = 0; i < 200; i++) h = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h));
  return h;
}
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; for (let i = 0; i < 8; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return s;
}
function createUser(o, temp) {
  const salt = Utilities.getUuid();
  logRow('users', { 'Username': o.username, 'Name': o.name || o.username, 'Role': o.role || 'crew', 'Phone': o.phone || '', 'Active': 'Y',
    'Must change password': 'Y', 'Token version': 1, 'Password hash': hashPw(temp, salt), 'Salt': salt, 'Created': fmt(new Date(), 'yyyy-MM-dd') });
}

// ---------------------------------------------------------------- admin: people

function usersList() {
  return { ok: true, users: readRows('users').map(function (r) {
    return { username: String(r.Username), name: String(r.Name), role: String(r.Role), phone: String(r.Phone || ''),
             active: isActive(r.Active), mustChange: isYes(r['Must change password']),
             payType: String(r['Pay type']) === 'monthly' ? 'monthly' : 'hourly', rate: r.Rate === '' ? '' : Number(r.Rate) };
  }) };
}

function userSave(actor, d) {
  const role = ROLES.indexOf(d.role) >= 0 ? d.role : 'crew', name = clean(d.name), phone = clean(d.phone);
  if (!name) return { ok: false, error: 'Enter their name.' };
  if (actor.role !== 'admin') {                    // managers look after crew only
    if (role !== 'crew') return { ok: false, error: 'Only an admin can give someone manager or admin access.' };
    const t = d.isNew ? null : findUser(d.username);
    if (t && t.role !== 'crew') return { ok: false, error: 'Only an admin can edit managers and admins.' };
  }
  if (d.isNew) {
    const un = String(d.username || '').trim().toLowerCase();
    if (!/^[a-z0-9.]{2,20}$/.test(un)) return { ok: false, error: 'Username: 2–20 lowercase letters, numbers or dots (e.g. khin, amir.k).' };
    if (findUser(un)) return { ok: false, error: 'That username is taken. Try adding an initial, e.g. ' + un + '.k' };
    const temp = tempPassword();
    createUser({ username: un, name: name, role: role, phone: phone }, temp);
    if (actor.role === 'admin') logRow('users', payFields(d), findUser(un).row);          // only admins set pay
    audit(actor, 'Added user', un + ' (' + role + ')');
    return { ok: true, username: un, temp: temp };
  }
  const u = findUser(d.username);
  if (!u) return { ok: false, error: 'User not found.' };
  const active = d.active !== false;
  if (u.username === actor.username && (role !== 'admin' || !active)) return { ok: false, error: 'You can\'t remove your own admin access.' };
  const relog = role !== u.role || active !== u.active;
  logRow('users', Object.assign({ 'Name': name, 'Role': role, 'Phone': phone, 'Active': active ? 'Y' : 'N', 'Token version': relog ? u.ver + 1 : u.ver },
                                actor.role === 'admin' ? payFields(d) : {}), u.row);
  audit(actor, 'Edited user', u.username + ': ' + [name, role, active ? 'active' : 'deactivated'].join(', '));
  return { ok: true };
}

function payFields(d) {
  const rate = d.rate === '' || d.rate === undefined || d.rate === null ? '' : money2(d.rate);
  return { 'Pay type': d.payType === 'monthly' ? 'monthly' : 'hourly', 'Rate': rate === '' || rate < 0 ? '' : rate };
}
function userReset(actor, d) {
  const u = findUser(d.username);
  if (!u) return { ok: false, error: 'User not found.' };
  if (actor.role !== 'admin' && u.role !== 'crew') return { ok: false, error: 'Only an admin can reset a manager\'s or admin\'s password.' };
  const temp = tempPassword(), salt = Utilities.getUuid();
  logRow('users', { 'Password hash': hashPw(temp, salt), 'Salt': salt, 'Must change password': 'Y', 'Token version': u.ver + 1 }, u.row);
  audit(actor, 'Reset password', u.username);
  return { ok: true, username: u.username, temp: temp };
}

// ---------------------------------------------------------------- admin: events

function eventsList(activeOnly) {
  return readRows('events').filter(function (r) { return r.Event && (!activeOnly || isActive(r.Active)); }).map(function (r) {
    return { name: String(r.Event).trim(), location: String(r.Location || ''), start: dstr(r['Start date']), end: dstr(r['End date']),
             colour: COLOURS.indexOf(String(r.Colour)) >= 0 ? String(r.Colour) : 'grey', active: isActive(r.Active), template: String(r['Stock template'] || '') };
  });
}
function findEvent(name) {
  const rs = readRows('events');
  for (let i = 0; i < rs.length; i++) if (String(rs[i].Event).trim() === String(name).trim()) return { r: rs[i], row: i + 2 };
  return null;
}
function eventSave(actor, d) {
  const name = clean(d.name), start = String(d.start || ''), end = String(d.end || '');
  if (!name) return { ok: false, error: 'Give the event a name.' };
  if ((start && !isDay(start)) || (end && !isDay(end))) return { ok: false, error: 'Dates must look like 2026-10-20.' };
  if (start && end && end < start) return { ok: false, error: 'The end date is before the start date.' };
  const obj = { 'Event': name, 'Location': clean(d.location), 'Start date': start, 'End date': end,
                'Colour': COLOURS.indexOf(d.colour) >= 0 ? d.colour : 'grey', 'Active': d.active === false ? 'N' : 'Y' };
  const found = findEvent(name);
  if (d.isNew && found) return { ok: false, error: 'An event with that name already exists.' };
  if (d.isNew && d.template) {
    const tpl = templateRows().filter(function (t) { return t.template === d.template; });
    if (tpl.length) { setEventLevels(name, tpl); obj['Stock template'] = d.template; }
  }
  logRow('events', obj, found && !d.isNew ? found.row : undefined);
  clearConfig(); clearRestock();
  audit(actor, d.isNew ? 'Added event' : 'Edited event', name + ' ' + start + '–' + end);
  return { ok: true };
}

// ---------------------------------------------------------------- admin: roster

// Roster rows for a day: [{ id, event, staff, start, end, type, note }], start/end in minutes after midnight.
function rosterRows(day) {
  return readRows('roster').filter(function (r) { return r.Username && dstr(r.Date) === day; }).map(function (r) {
    return { id: String(r.ID), date: day, event: String(r.Event || '').trim(), staff: String(r.Username).trim().toLowerCase(),
             start: tmin(r.Start), end: tmin(r.End), type: String(r.Type) === 'standby' ? 'standby' : 'shift', note: String(r.Note || ''), lead: isYes(r.Lead) };
  });
}
function rosterFor(day) { return rosterRows(day).filter(function (r) { return r.type === 'shift'; }); }
function rosterOf(name, event, day) { return rosterFor(day).filter(function (r) { return r.staff === name && r.event === event; })[0] || null; }
function stopSaleUnlock(event, day) {
  const ends = rosterFor(day).filter(function (r) { return r.event === event && r.end !== null; }).map(function (r) { return r.end; });
  if (!ends.length) return null;
  return Math.max.apply(null, ends) - (Number(setting('Stop sale before end (min)')) || 30);
}

function rosterWeek(d) {
  const start = isDay(d.start) ? d.start : fmt(new Date(), 'yyyy-MM-dd');
  const days = []; for (let i = 0; i < 7; i++) days.push(addDays(start, i));
  const shifts = [];
  days.forEach(function (day) { rosterRows(day).forEach(function (r) {
    shifts.push({ id: r.id, date: day, event: r.event, username: r.staff, start: hm(r.start), end: hm(r.end), type: r.type, note: r.note, lead: r.lead });
  }); });
  const events = eventsList(true).filter(function (e) { return (!e.start || e.start <= days[6]) && (!e.end || e.end >= days[0]); });
  return { ok: true, days: days, events: events, users: usersList().users.filter(function (u) { return u.active; }), shifts: shifts };
}

function rosterSave(actor, d) {
  const date = String(d.date || ''), un = String(d.username || '').toLowerCase(), type = d.type === 'standby' ? 'standby' : 'shift';
  if (!isDay(date)) return { ok: false, error: 'Pick a date.' };
  if (!findUser(un)) return { ok: false, error: 'Unknown staff member.' };
  const event = clean(d.event);
  let s = tmin(d.start), e = tmin(d.end);
  if (type === 'shift') {
    if (!event || !findEvent(event)) return { ok: false, error: 'Pick the event.' };
    if (s === null || e === null) return { ok: false, error: 'Enter start and end times, e.g. 15:00 and 22:00.' };
    if (e <= s) return { ok: false, error: 'The end time is before the start time. Check AM/PM.' };
    const clash = rosterRows(date).filter(function (r) {
      return r.staff === un && r.type === 'shift' && r.id !== d.id && s < r.end && r.start < e; })[0];
    if (clash) return { ok: false, error: un + ' already has a shift then (' + clash.event + ' ' + hm(clash.start) + '–' + hm(clash.end) + ').' };
  }
  const obj = { 'ID': d.id || Utilities.getUuid().slice(0, 8), 'Date': date, 'Event': event, 'Username': un,
                'Start': s === null ? '' : hm(s), 'End': e === null ? '' : hm(e), 'Type': type, 'Note': clean(d.note), 'Updated by': actor.username,
                'Lead': type === 'shift' && d.lead ? 'Y' : '' };
  const found = d.id ? findRow('roster', 'ID', d.id) : null;
  logRow('roster', obj, found ? found.row : undefined);
  audit(actor, found ? 'Edited shift' : 'Added shift', un + ' ' + date + ' ' + (type === 'standby' ? 'standby' : event + ' ' + obj.Start + '–' + obj.End));
  return { ok: true, id: obj.ID };
}

function rosterDelete(actor, d) {
  const f = findRow('roster', 'ID', d.id);
  if (!f) return { ok: false, error: 'Shift not found.' };
  sheet('roster').deleteRow(f.row);
  _cache.roster = null;
  audit(actor, 'Removed shift', f.r.Username + ' ' + dstr(f.r.Date) + ' ' + (f.r.Event || 'standby'));
  return { ok: true };
}

function rosterCopyWeek(actor, d) {
  if (!isDay(d.from) || !isDay(d.to)) return { ok: false, error: 'Bad week.' };
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const src = addDays(d.from, i), dst = addDays(d.to, i), have = rosterRows(dst);
    rosterRows(src).forEach(function (r) {
      if (have.some(function (h) { return h.staff === r.staff && h.event === r.event && h.type === r.type; })) return;
      logRow('roster', { 'ID': Utilities.getUuid().slice(0, 8), 'Date': dst, 'Event': r.event, 'Username': r.staff, 'Start': hm(r.start),
                         'End': hm(r.end), 'Type': r.type, 'Note': r.note, 'Updated by': actor.username, 'Lead': r.lead ? 'Y' : '' });
      n++;
    });
  }
  audit(actor, 'Copied roster week', d.from + ' → ' + d.to + ' (' + n + ' shifts)');
  return { ok: true, copied: n };
}

// ---------------------------------------------------------------- me

function meInfo(u) {
  const day = fmt(new Date(), 'yyyy-MM-dd'), o = openShift(u.username);
  const today = rosterRows(day).filter(function (r) { return r.staff === u.username; })
    .map(function (r) { return { event: r.event, start: hm(r.start), end: hm(r.end), type: r.type, note: r.note }; });
  return { ok: true, user: pub(u), today: today, unreadNotices: noticesList(u).unread, handbookToRead: handbookList(u).toRead,
           pendingClaims: isMgr(u) ? claimsAll(u).pending : 0, restock: isMgr(u) ? restockCount() : 0,
           cash: isMgr(u) ? (function () { const c = cashList(); return { notBanked: c.notBanked, toReceive: c.toReceive, overdue: c.overdue, toVerify: c.toVerify, toCheck: c.toCheck, queries: c.queries }; })() : null,
           myCash: (function () { const c = myCash(u); return { holding: c.holding, due: c.due, overdue: c.overdue, pending: c.pending,
                     count: c.bags.filter(function (b) { return b.status === 'with closer'; }).length, queries: c.queries.filter(function (q) { return !q.reply; }).length }; })(),
           clockedIn: o && fmt(o.r['Clock in'], 'yyyy-MM-dd') === day ? { event: String(o.r.Event), time: fmt(o.r['Clock in'], 'HH:mm') } : null };
}

// Everything the Today screen needs, in one round trip.
function home(u) {
  const me = meInfo(u);
  return { ok: true, me: me, status: me.clockedIn ? status(u, me.clockedIn.event) : null, live: isMgr(u) ? live(u) : null, week: myShifts(u) };
}

function myShifts(u) {
  const today = fmt(new Date(), 'yyyy-MM-dd'), month = today.slice(0, 7), upcoming = [];
  for (let i = 0; i < 21; i++) {
    const day = addDays(today, i);
    rosterRows(day).forEach(function (r) {
      if (r.staff === u.username) upcoming.push({ date: day, event: r.event, start: hm(r.start), end: hm(r.end), type: r.type, note: r.note, lead: r.lead });
    });
  }
  const mine = readRows('timesheet').filter(function (t) { return String(t.Staff) === u.username; });
  const hours = mine.filter(function (t) { return dstr(t.Date).slice(0, 7) === month && t['Clock out']; }).reduce(function (s, t) { return s + roundQ(t.Hours); }, 0);   // same rounding as payroll
  const recent = mine.slice(-10).reverse().map(function (t) {
    return { date: dstr(t.Date), event: String(t.Event), in: t['Clock in'] ? fmt(t['Clock in'], 'HH:mm') : '', out: t['Clock out'] ? fmt(t['Clock out'], 'HH:mm') : '',
             hours: t.Hours, late: t['Late (min)'] };
  });
  return { ok: true, upcoming: upcoming, monthHours: Math.round(hours * 100) / 100, month: month, recent: recent };
}

// ---------------------------------------------------------------- clock in / out

function clock(u, d) {
  const name = u.username;
  if (!isPhoto(d.photo)) return { ok: false, error: 'Take the photo first (or retake it if it was too big).' };
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd'), nowMin = minOfDay(now);
  const open = openShift(name);

  if (d.type === 'in') {
    const event = clean(d.event);
    if (!event || !findEvent(event)) return { ok: false, error: 'Pick the event.' };
    if (open) {
      if (fmt(open.r['Clock in'], 'yyyy-MM-dd') === day) {
        return { ok: false, error: 'You are already clocked in since ' + fmt(open.r['Clock in'], 'HH:mm') + ' (' + open.r.Event + '). Clock out first.' };
      }
      logRow('timesheet', { 'Clock-out flag': 'No clock-out recorded' }, open.row);
    }
    const ros = rosterOf(name, event, day);
    const elsewhere = ros ? null : rosterFor(day).filter(function (r) { return r.staff === name; })[0];
    const lateBy = ros && ros.start !== null ? nowMin - ros.start : null;
    const grace = Number(setting('Late after (min)')) || 0;
    const earlierToday = readRows('timesheet').some(function (r) { return r.Staff === name && r.Event === event && dstr(r.Date) === day; });
    const late = !earlierToday && lateBy !== null && lateBy > grace ? lateBy : 0;
    logRow('timesheet', {
      'Date': day, 'Staff': name, 'Event': event, 'Clock in': now,
      'Roster': ros ? hm(ros.start) + '–' + hm(ros.end) : elsewhere ? 'Rostered at ' + elsewhere.event : 'Not rostered',
      'Late (min)': late || '', 'Prompt': todayPrompt(false).prompt, 'In photo': savePhoto(d.photo, now, name, event, 'in'),
    });
    fixTimeFormat();
    const dl = dayRow(event, day, true);
    if (!dl.r['First clock-in']) logRow('dayLog', { 'First clock-in': fmt(now, 'HH:mm'), 'Status': 'OPEN' }, dl.row);
    return { ok: true, name: u.name, time: fmt(now, 'HH:mm'), event: event, roster: ros ? hm(ros.start) + '–' + hm(ros.end) : '', late: late,
             note: ros ? '' : elsewhere ? 'You are rostered at ' + elsewhere.event + ' today, not here.' : 'You are not on the roster for this event today.' };
  }

  if (d.type === 'out') {
    if (!open) return { ok: false, error: 'You are not clocked in.' };
    const event = String(open.r.Event), inAt = open.r['Clock in'], sday = fmt(inAt, 'yyyy-MM-dd');
    const others = onSite(event, sday).filter(function (n) { return n !== name; });
    const dl = dayRow(event, sday, true);
    const closed = !!dl.r['Stock take done'] && !!dl.r['Closing done'];
    const reason = clean(d.override);
    if (!others.length && !closed && !reason) {
      const need = [!dl.r['Stock take done'] ? 'stock take' : '', !dl.r['Closing done'] ? 'closing evidence' : ''].filter(String).join(' and ');
      return { ok: false, blocked: true, error: 'You are the last one at ' + event + '. Submit the ' + need + ' before clocking out.' };
    }
    const flags = [];
    if (!others.length && !closed) flags.push('Clocked out without closing: ' + reason);
    const ros = rosterOf(name, event, sday), grace = Number(setting('Late after (min)')) || 0;
    if (ros && ros.end !== null && sday === day) {
      const early = ros.end - nowMin, excused = !!dl.r['Early stop reason'] && closed;
      if (early > grace && !excused) flags.push('Left ' + early + ' min early');
      else if (-early > grace) flags.push((-early) + ' min past roster');
    }
    const hours = Math.round((now - inAt) / 36e5 * 100) / 100;
    logRow('timesheet', { 'Clock out': now, 'Hours': hours, 'Clock-out flag': flags.join('; '),
                          'Out photo': savePhoto(d.photo, now, name, event, 'out') }, open.row);
    fixTimeFormat();
    if (flags.length && /without closing/.test(flags[0])) addAlert(event, sday, u.name + ' clocked out without closing: ' + reason);
    if (!others.length) finishDay(event, sday, closed, now);
    let closingMins = null;
    if (dl.r['Stop sale'] && sday === day) closingMins = nowMin - tmin(dl.r['Stop sale']);
    return { ok: true, name: u.name, time: fmt(now, 'HH:mm'), hours: hours, event: event, flags: flags,
             closingMins: closingMins, closingTarget: Number(setting('Closing target (min)')) || 30 };
  }
  return { ok: false, error: 'Unknown clock type' };
}

// Last one out: the event day is finished, so the report goes.
function finishDay(event, day, closed, when) {
  const dl = dayRow(event, day, true);
  logRow('dayLog', { 'Last clock-out': fmt(when, 'HH:mm'), 'Status': closed ? 'SHIFT COMPLETE' : 'NOT CLOSED' }, dl.row);
  try { sendReport(event, day); } catch (err) {}
}

function fixTimeFormat() { sheet('timesheet').getRange('D:E').setNumberFormat('HH:mm'); }

// The newest timesheet row for this person with a clock-in and no clock-out.
function openShift(name) {
  const rs = readRows('timesheet');
  for (let i = rs.length - 1; i >= 0; i--) {
    if (rs[i].Staff === name && rs[i]['Clock in'] && !rs[i]['Clock out']) return { r: rs[i], row: i + 2 };
  }
  return null;
}
// Clock-in time if this person is clocked in today at this event, else null.
function clockedIn(name, event) {
  const o = openShift(name);
  return o && String(o.r.Event) === event && fmt(o.r['Clock in'], 'yyyy-MM-dd') === fmt(new Date(), 'yyyy-MM-dd') ? o.r['Clock in'] : null;
}
function onSite(event, day) {
  return readRows('timesheet').filter(function (r) {
    return String(r.Event) === event && r['Clock in'] && !r['Clock out'] && fmt(r['Clock in'], 'yyyy-MM-dd') === day;
  }).map(function (r) { return r.Staff; });
}

// One prompt per day, picked at random by the server (never the same as yesterday) and logged in Prompt Log.
function todayPrompt(useLock) {
  const day = fmt(new Date(), 'yyyy-MM-dd'), found = promptFor(day);
  if (found) return found;
  const lock = useLock ? LockService.getScriptLock() : null;
  if (lock) lock.waitLock(20000);
  try {
    const again = promptFor(day);                    // someone else may have just picked it
    if (again) return again;
    const sh = sheet('promptLog'), last = sh.getLastRow() > 1 ? sh.getRange(sh.getLastRow(), 1, 1, 4).getValues()[0] : null;
    let pool = readRows('prompts').filter(function (r) { return r.Prompt && isActive(r.Active); });
    if (!pool.length) pool = [{ Category: 'Other', Prompt: 'Selfie with the booth behind you', Emoji: '🤳' }];
    const fresh = pool.filter(function (r) { return !last || String(r.Prompt) !== String(last[2]); });
    const from = fresh.length ? fresh : pool;
    const pick = from[Math.floor(Math.random() * from.length)];
    const p = { category: String(pick.Category || ''), prompt: String(pick.Prompt), emoji: String(pick.Emoji || '📸') };
    sh.appendRow([day, p.category, p.prompt, p.emoji]);
    _cache.promptLog = null;
    return p;
  } finally {
    if (lock) lock.releaseLock();
  }
}
function promptFor(day) {
  const sh = sheet('promptLog');
  if (sh.getLastRow() < 2) return null;
  const last = sh.getRange(sh.getLastRow(), 1, 1, 4).getValues()[0];
  return dstr(last[0]) === day ? { category: String(last[1]), prompt: String(last[2]), emoji: String(last[3] || '📸') } : null;
}

// Clock-in time if this person is clocked in today at this event, else null.
function clockedIn(name, event) {
  const o = openShift(name);
  return o && String(o.r.Event) === event && fmt(o.r['Clock in'], 'yyyy-MM-dd') === fmt(new Date(), 'yyyy-MM-dd') ? o.r['Clock in'] : null;
}
function onSite(event, day) {
  return readRows('timesheet').filter(function (r) {
    return String(r.Event) === event && r['Clock in'] && !r['Clock out'] && fmt(r['Clock in'], 'yyyy-MM-dd') === day;
  }).map(function (r) { return r.Staff; });
}

// One prompt per day, picked at random by the server (never the same as yesterday) and logged in Prompt Log.
function todayPrompt(useLock) {
  const lock = useLock ? LockService.getScriptLock() : null;
  if (lock) lock.waitLock(20000);
  try {
    const sh = sheet('promptLog'), day = fmt(new Date(), 'yyyy-MM-dd');
    const last = sh.getLastRow() > 1 ? sh.getRange(sh.getLastRow(), 1, 1, 4).getValues()[0] : null;
    if (last && dstr(last[0]) === day) return { category: String(last[1]), prompt: String(last[2]), emoji: String(last[3] || '📸') };
    let pool = readRows('prompts').filter(function (r) { return r.Prompt && isActive(r.Active); });
    if (!pool.length) pool = [{ Category: 'Other', Prompt: 'Selfie with the booth behind you', Emoji: '🤳' }];
    const fresh = pool.filter(function (r) { return !last || String(r.Prompt) !== String(last[2]); });
    const from = fresh.length ? fresh : pool;
    const pick = from[Math.floor(Math.random() * from.length)];
    const p = { category: String(pick.Category || ''), prompt: String(pick.Prompt), emoji: String(pick.Emoji || '📸') };
    sh.appendRow([day, p.category, p.prompt, p.emoji]);
    _cache.promptLog = null;
    return p;
  } finally {
    if (lock) lock.releaseLock();
  }
}

// ---------------------------------------------------------------- day status & stop sale

function status(u, event) {
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd'), name = u.username;
  const dl = dayRow(event, day, false), r = dl ? dl.r : {};
  const unlock = stopSaleUnlock(event, day), ros = rosterOf(name, event, day);
  const since = clockedIn(name, event), site = onSite(event, day);
  return Object.assign({
    ok: true, now: fmt(now, 'HH:mm'),
    clockedIn: since ? fmt(since, 'HH:mm') : '',
    roster: ros ? hm(ros.start) + '–' + hm(ros.end) : '',
    onSite: site.map(nameOf), last: !!since && site.length === 1,
    opening: r['Opening done'] ? { time: String(r['Opening done']), by: nameOf(r['Opening by']) } : null,
    stopSale: r['Stop sale'] ? { time: String(r['Stop sale']), by: nameOf(r['Stop sale by']), reason: String(r['Early stop reason'] || '') } : null,
    unlockAt: unlock === null ? '' : hm(unlock), unlocked: unlock === null || minOfDay(now) >= unlock,
    stock: r['Stock take done'] ? { time: String(r['Stock take done']), by: nameOf(r['Stock take by']) } : null,
    closing: r['Closing done'] ? { time: String(r['Closing done']), by: nameOf(r['Closing by']) } : null,
  }, duty(name, event, day, site));
}
// The checklist belongs to whoever is rostered "in charge". If nobody is, or they aren't on site, it's everyone's.
function duty(name, event, day, site) {
  const leads = rosterFor(day).filter(function (r) { return r.event === event && r.lead; }).map(function (r) { return r.staff; });
  const leadHere = leads.filter(function (l) { return site.indexOf(l) >= 0; });
  return { leads: leads.map(nameOf), leadOnSite: leadHere.map(nameOf), iAmLead: leads.indexOf(name) >= 0,
           myDuty: !leads.length || leads.indexOf(name) >= 0 || !leadHere.length };
}

function stopSale(name, event, d) {
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd'), dl = dayRow(event, day, true);
  if (dl.r['Stop sale']) return { ok: true, time: String(dl.r['Stop sale']), by: nameOf(dl.r['Stop sale by']), already: true };
  const unlock = stopSaleUnlock(event, day), early = unlock !== null && minOfDay(now) < unlock, reason = clean(d.reason);
  if (early && !reason) return { ok: false, early: true, error: 'Stop sale is from ' + hm(unlock) + '. Stopping earlier needs a reason.' };
  logRow('dayLog', { 'Stop sale': fmt(now, 'HH:mm'), 'Stop sale by': name, 'Early stop reason': early ? reason : '', 'Status': 'CLOSING' }, dl.row);
  if (early) addAlert(event, day, 'Stopped sale early at ' + fmt(now, 'HH:mm') + ' (from ' + hm(unlock) + '): ' + reason);
  return { ok: true, time: fmt(now, 'HH:mm'), by: nameOf(name), early: early };
}

// The Day Log row for an event + day, created on demand.
function dayRow(event, day, create) {
  const rs = readRows('dayLog');
  for (let i = rs.length - 1; i >= 0; i--) {
    if (String(rs[i].Event) === event && dstr(rs[i].Date) === day) return { r: rs[i], row: i + 2 };
  }
  if (!create) return null;
  const row = logRow('dayLog', { 'Date': day, 'Event': event, 'Status': 'OPEN' });
  return { r: { Date: day, Event: event, Status: 'OPEN' }, row: row };
}
function addAlert(event, day, text) {
  logRow('alerts', { 'ID': Utilities.getUuid().slice(0, 8), 'Timestamp': new Date(), 'Date': day, 'Event': event, 'Alert': text });
}
function alertsFor(event, day) {
  return readRows('alerts').filter(function (a) { return String(a.Event) === event && dstr(a.Date) === day; }).map(function (a) {
    return { id: String(a.ID), text: String(a.Alert), time: a.Timestamp ? fmt(a.Timestamp, 'HH:mm') : '',
             resolvedBy: a['Resolved by'] ? nameOf(a['Resolved by']) : '', note: String(a['Resolution note'] || '') };
  });
}

// ---------------------------------------------------------------- live view (admin: all events today · lead: their event)

function live(u) {
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd'), nowMin = minOfDay(now), grace = Number(setting('Late after (min)')) || 0;
  const roster = rosterRows(day), sheetRows = readRows('timesheet').filter(function (t) { return dstr(t.Date) === day; });
  let events;
  if (isMgr(u)) {
    events = [];
    roster.concat(sheetRows.map(function (t) { return { event: String(t.Event) }; })).forEach(function (r) {
      if (r.event && events.indexOf(r.event) < 0) events.push(r.event);
    });
  } else return { ok: false, error: 'Only managers and admins can see the live view.' };

  const colour = {}; eventsList(false).forEach(function (e) { colour[e.name] = e.colour; });
  const out = events.map(function (ev) {
    const shifts = roster.filter(function (r) { return r.event === ev && r.type === 'shift'; });
    const people = [];
    shifts.forEach(function (r) { if (people.indexOf(r.staff) < 0) people.push(r.staff); });
    sheetRows.forEach(function (t) { if (String(t.Event) === ev && people.indexOf(String(t.Staff)) < 0) people.push(String(t.Staff)); });
    const crew = people.map(function (p) {
      const ros = shifts.filter(function (r) { return r.staff === p; })[0];
      const rows = sheetRows.filter(function (t) { return String(t.Event) === ev && String(t.Staff) === p; });
      const last = rows[rows.length - 1];
      let state, text;
      if (last && !last['Clock out']) { state = 'on'; text = 'On site since ' + fmt(last['Clock in'], 'HH:mm'); }
      else if (last) { state = 'left'; text = 'Left at ' + fmt(last['Clock out'], 'HH:mm'); }
      else if (ros && ros.start !== null && nowMin > ros.start + grace) { state = 'missing'; text = 'Not in yet · ' + dur(nowMin - ros.start) + ' late'; }
      else { state = 'due'; text = ros ? 'Due at ' + hm(ros.start) : ''; }
      const flags = rows.map(function (t) { return [t['Late (min)'] ? 'late ' + t['Late (min)'] + ' min' : '', t['Clock-out flag']].filter(String).join('; '); }).filter(String);
      return { username: p, name: nameOf(p), roster: ros ? hm(ros.start) + '–' + hm(ros.end) : 'Not rostered', state: state, text: text, flags: flags.join('; '), lead: !!(ros && ros.lead) };
    });
    const dl = dayRow(ev, day, false), r = dl ? dl.r : {}, unlock = stopSaleUnlock(ev, day);
    return { event: ev, colour: colour[ev] || 'grey', crew: crew, alerts: alertsFor(ev, day),
             progress: { opening: r['Opening done'] || '', stopSale: r['Stop sale'] || '', stopReason: r['Early stop reason'] || '',
                         unlockAt: unlock === null ? '' : hm(unlock), stock: r['Stock take done'] || '', closing: r['Closing done'] || '',
                         status: r.Status || 'Not started' } };
  });
  const standby = roster.filter(function (r) { return r.type === 'standby'; }).map(function (r) { return { name: nameOf(r.staff), note: r.note, event: r.event }; });
  return { ok: true, now: fmt(now, 'HH:mm'), events: out, standby: standby };
}

function canManage(u) { return isMgr(u); }

function fixClockOut(u, d) {
  const target = findUser(d.username);
  if (!target) return { ok: false, error: 'User not found.' };
  const o = openShift(target.username), now = new Date(), day = fmt(now, 'yyyy-MM-dd');
  if (!o) return { ok: false, error: target.name + ' is not clocked in.' };
  const event = String(o.r.Event);
  if (!canManage(u)) return { ok: false, error: 'Only managers and admins can do that.' };
  if (target.username === u.username) return { ok: false, error: 'Use the normal clock out for yourself.' };
  const t = tmin(d.time), reason = clean(d.reason), inAt = o.r['Clock in'], sday = fmt(inAt, 'yyyy-MM-dd');
  if (t === null) return { ok: false, error: 'Enter the time they left, e.g. 18:05.' };
  if (!reason) return { ok: false, error: 'Say why you are clocking them out.' };
  const out = new Date(inAt.getTime() + (t - minOfDay(inAt)) * 6e4);      // same day as clock-in, timezone-safe
  if (out < inAt || out > now) return { ok: false, error: 'The time must be between their clock-in (' + fmt(inAt, 'HH:mm') + ') and now.' };
  const hours = Math.round((out - inAt) / 36e5 * 100) / 100;
  logRow('timesheet', { 'Clock out': out, 'Hours': hours, 'Clock-out flag': 'Clocked out by ' + u.name + ': ' + reason }, o.row);
  fixTimeFormat();
  addAlert(event, sday, target.name + ' was clocked out at ' + fmt(out, 'HH:mm') + ' by ' + u.name + ': ' + reason);
  audit(u, 'Fixed clock-out', target.username + ' at ' + fmt(out, 'HH:mm') + ' — ' + reason);
  if (!onSite(event, sday).length) {
    const dl = dayRow(event, sday, true);
    finishDay(event, sday, !!dl.r['Stock take done'] && !!dl.r['Closing done'], out);
  }
  return { ok: true, hours: hours };
}

function resolveAlert(u, d) {
  const f = findRow('alerts', 'ID', d.id);
  if (!f) return { ok: false, error: 'Alert not found.' };
  if (!canManage(u)) return { ok: false, error: 'Only managers and admins can resolve alerts.' };
  const note = clean(d.note);
  if (!note) return { ok: false, error: 'Add a short note on how it was sorted.' };
  logRow('alerts', { 'Resolved by': u.username, 'Resolved at': new Date(), 'Resolution note': note }, f.row);
  audit(u, 'Resolved alert', String(f.r.Alert) + ' — ' + note);
  return { ok: true };
}

// ---------------------------------------------------------------- audit trail

function audit(u, action, details) { logRow('audit', { 'Timestamp': new Date(), 'By': u.username, 'Action': action, 'Details': details }); }
function auditList() {
  return { ok: true, items: readRows('audit').slice(-150).reverse().map(function (a) {
    return { time: a.Timestamp ? fmt(a.Timestamp, 'd MMM HH:mm') : '', by: String(a.By), action: String(a.Action), details: String(a.Details) };
  }) };
}

// ---------------------------------------------------------------- notices

function noticeRows() {
  return readRows('notices').filter(function (n) { return n.ID && isActive(n.Active); }).map(function (n) {
    return { id: String(n.ID), created: dstr(n.Created), by: String(n.By), title: String(n.Title), body: String(n.Body || ''),
             photo: String(n.Photo || ''), pinned: isYes(n.Pinned), audience: String(n.Audience || 'All'), expires: dstr(n.Expires || ''),
             mustAck: isYes(n['Must acknowledge']) };
  });
}
// Everyone sees "All" notices. Event notices go to crew rostered there in the last day or next week (and to managers).
function noticeAudience(n, day) {
  if (n.audience === 'All') return null;
  const people = {};
  for (let i = -1; i <= 7; i++) rosterRows(addDays(day, i)).forEach(function (r) { if (r.event === n.audience) people[r.staff] = true; });
  return people;
}
function noticesList(u) {
  const day = fmt(new Date(), 'yyyy-MM-dd'), acks = {};
  readRows('noticeAcks').forEach(function (a) { if (String(a.Username) === u.username) acks[String(a['Notice ID'])] = a.At ? fmt(a.At, 'd MMM HH:mm') : 'yes'; });
  const list = noticeRows().filter(function (n) {
    if (n.expires && n.expires < day && !isMgr(u)) return false;
    const who = noticeAudience(n, day);
    return isMgr(u) || !who || who[u.username];
  }).map(function (n) { return Object.assign(n, { byName: nameOf(n.by), acked: acks[n.id] || '', expired: !!n.expires && n.expires < day }); });
  list.sort(function (a, b) { return (b.pinned - a.pinned) || b.created.localeCompare(a.created); });
  return { ok: true, notices: list, unread: list.filter(function (n) { return !n.acked && !n.expired; }).length, canEdit: isMgr(u) };
}
function noticeAck(u, d) {
  const ids = Array.isArray(d.ids) ? d.ids : [d.id];
  const have = {};
  readRows('noticeAcks').forEach(function (a) { if (String(a.Username) === u.username) have[String(a['Notice ID'])] = true; });
  ids.forEach(function (id) { if (id && !have[id]) logRow('noticeAcks', { 'Notice ID': String(id), 'Username': u.username, 'At': new Date() }); });
  return { ok: true };
}
function noticeSave(u, d) {
  const title = clean(d.title);
  if (d.remove) {
    const f = findRow('notices', 'ID', d.id);
    if (!f) return { ok: false, error: 'Notice not found.' };
    logRow('notices', { 'Active': 'N' }, f.row);
    audit(u, 'Removed notice', String(f.r.Title));
    return { ok: true };
  }
  if (!title) return { ok: false, error: 'Give the notice a title.' };
  if (d.expires && !isDay(d.expires)) return { ok: false, error: 'Pick a valid expiry date.' };
  const audience = d.audience && d.audience !== 'All' && findEvent(d.audience) ? clean(d.audience) : 'All';
  const f = d.id ? findRow('notices', 'ID', d.id) : null;
  let photo = f ? String(f.r.Photo || '') : '';
  if (d.removePhoto) photo = '';
  if (isPhoto(d.photo)) photo = publicUrl(saveImage(subFolder(photoFolder(), 'Notices'), d.photo, fmt(new Date(), 'yyyy-MM-dd HHmm') + ' ' + title));
  const obj = { 'ID': f ? String(f.r.ID) : Utilities.getUuid().slice(0, 8), 'Title': title, 'Body': String(d.body || '').slice(0, 5000), 'Photo': photo,
                'Pinned': d.pinned ? 'Y' : 'N', 'Audience': audience, 'Expires': d.expires || '', 'Must acknowledge': d.mustAck ? 'Y' : 'N', 'Active': 'Y' };
  if (!f) { obj.Created = fmt(new Date(), 'yyyy-MM-dd'); obj.By = u.username; }
  logRow('notices', obj, f ? f.row : undefined);
  audit(u, f ? 'Edited notice' : 'Posted notice', title + (audience !== 'All' ? ' (' + audience + ')' : ''));
  return { ok: true, id: obj.ID };
}
// Who has and hasn't seen a notice.
function noticeAcks(d) {
  const n = noticeRows().filter(function (x) { return x.id === String(d.id); })[0];
  if (!n) return { ok: false, error: 'Notice not found.' };
  const seen = {};
  readRows('noticeAcks').forEach(function (a) { if (String(a['Notice ID']) === n.id) seen[String(a.Username)] = a.At ? fmt(a.At, 'd MMM HH:mm') : ''; });
  const who = noticeAudience(n, fmt(new Date(), 'yyyy-MM-dd'));
  const people = readRows('users').filter(function (r) { return isActive(r.Active) && (!who || who[String(r.Username)]); });
  return { ok: true,
    seen: people.filter(function (p) { return seen[String(p.Username)] !== undefined; }).map(function (p) { return { name: String(p.Name), at: seen[String(p.Username)] }; }),
    notSeen: people.filter(function (p) { return seen[String(p.Username)] === undefined; }).map(function (p) { return String(p.Name); }) };
}

// ---------------------------------------------------------------- handbook (SOP)

function handbookList(u) {
  const mine = {};
  readRows('bookAcks').forEach(function (a) {
    if (String(a.Username) === u.username) mine[String(a['Section ID'])] = Math.max(mine[String(a['Section ID'])] || 0, Number(a.Version) || 0);
  });
  const sections = readRows('handbook').filter(function (h) { return h.ID && isActive(h.Active); }).map(function (h) {
    const v = Number(h.Version) || 1;
    return { id: String(h.ID), order: Number(h.Order) || 0, section: String(h.Section || 'General'), title: String(h.Title), body: String(h.Body || ''),
             photos: String(h.Photos || '').split('\n').filter(String), pointers: parsePointers(h.Pointers), version: v, updated: dstr(h.Updated || ''), updatedBy: h['Updated by'] ? nameOf(h['Updated by']) : '',
             read: (mine[String(h.ID)] || 0) >= v, readBefore: !!mine[String(h.ID)] };
  }).sort(function (a, b) { return a.order - b.order; });
  return { ok: true, sections: sections, toRead: sections.filter(function (s) { return !s.read; }).length, canEdit: isMgr(u) };
}
function parsePointers(v) { try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (err) { return []; } }
function handbookAck(u, d) {
  const f = findRow('handbook', 'ID', d.id);
  if (!f) return { ok: false, error: 'Section not found.' };
  logRow('bookAcks', { 'Section ID': String(f.r.ID), 'Version': Number(f.r.Version) || 1, 'Username': u.username, 'At': new Date() });
  return { ok: true };
}
function handbookSave(u, d) {
  const f = d.id ? findRow('handbook', 'ID', d.id) : null;
  if (d.remove) {
    if (!f) return { ok: false, error: 'Section not found.' };
    logRow('handbook', { 'Active': 'N' }, f.row);
    audit(u, 'Removed handbook section', String(f.r.Title));
    return { ok: true };
  }
  const title = clean(d.title);
  if (!title) return { ok: false, error: 'Give the section a title.' };
  const keep = (Array.isArray(d.photos) ? d.photos : []).filter(function (p) { return /^(https:|data:image)/.test(String(p)); });
  // Pointers: [{ t: text, p: photo }]. A new photo arrives as image data and is saved to Drive here.
  const pointers = (Array.isArray(d.pointers) ? d.pointers : []).filter(function (x) { return x && (clean(x.t) || x.p); }).map(function (x, i) {
    let p = String(x.p || '');
    if (isPhoto(p) && !(f && String(f.r.Pointers || '').indexOf(p) >= 0)) p = publicUrl(saveImage(subFolder(photoFolder(), 'Handbook'), p, title + ' ' + (i + 1)));
    return { t: String(x.t || '').trim().slice(0, 2000), p: /^(https:|data:image)/.test(p) ? p : '' };
  });
  const pjson = JSON.stringify(pointers);
  const order = d.order !== undefined && d.order !== '' ? Number(d.order) : (f ? Number(f.r.Order) : readRows('handbook').length + 1);
  const obj = { 'ID': f ? String(f.r.ID) : Utilities.getUuid().slice(0, 8), 'Order': order, 'Section': clean(d.section) || 'General', 'Title': title,
                'Body': String(d.body || '').slice(0, 20000), 'Photos': keep.join('\n'), 'Pointers': pjson, 'Updated': fmt(new Date(), 'yyyy-MM-dd'), 'Updated by': u.username, 'Active': 'Y',
                // A real content change asks everyone to re-read; fixing the order or section name doesn't.
                'Version': f ? (Number(f.r.Version) || 1) + (String(f.r.Body) !== String(d.body || '') || String(f.r.Photos || '') !== keep.join('\n') ||
                                String(f.r.Pointers || '[]') !== pjson ? 1 : 0) : 1 };
  logRow('handbook', obj, f ? f.row : undefined);
  audit(u, f ? 'Edited handbook' : 'Added handbook section', title);
  return { ok: true, id: obj.ID };
}

// ---------------------------------------------------------------- expense claims

function claimRow(c) {
  return { id: String(c.ID), submitted: dstr(c.Submitted), username: String(c.Username), name: nameOf(c.Username), date: dstr(c.Date), amount: Number(c.Amount) || 0,
           category: String(c.Category), where: String(c.Where || ''), description: String(c.Description || ''), receipt: String(c.Receipt || ''),
           status: String(c.Status || 'submitted'), decidedBy: c['Decided by'] ? nameOf(c['Decided by']) : '', decidedAt: dstr(c['Decided at'] || ''),
           reason: String(c.Reason || ''), paidNote: String(c['Paid note'] || '') };
}
function claimsMine(u) {
  const list = readRows('claims').filter(function (c) { return c.ID && String(c.Username) === u.username; }).map(claimRow).reverse();
  return { ok: true, claims: list, categories: CLAIM_CATEGORIES };
}
function claimSubmit(u, d) {
  const amount = Math.round(Number(d.amount) * 100) / 100;
  if (!(amount > 0)) return { ok: false, error: 'Enter the amount you spent.' };
  if (amount > 5000) return { ok: false, error: 'That amount looks too big for a claim. Check it, or talk to Jay or Hazel.' };
  if (!isDay(d.date)) return { ok: false, error: 'Pick the date you bought it.' };
  if (CLAIM_CATEGORIES.indexOf(d.category) < 0) return { ok: false, error: 'Pick a category.' };
  if (!clean(d.description)) return { ok: false, error: 'Say what you bought.' };
  if (!isPhoto(d.photo)) return { ok: false, error: 'Add a photo of the receipt.' };
  const now = new Date(), id = Utilities.getUuid().slice(0, 8);
  const receipt = publicUrl(saveImage(subFolder(photoFolder(), 'Receipts'), d.photo, fmt(now, 'yyyy-MM-dd HHmm') + ' ' + u.username + ' $' + amount.toFixed(2)));
  logRow('claims', { 'ID': id, 'Submitted': fmt(now, 'yyyy-MM-dd'), 'Username': u.username, 'Date': d.date, 'Amount': amount, 'Category': d.category,
                     'Where': clean(d.where), 'Description': clean(d.description), 'Receipt': receipt, 'Status': 'submitted' });
  return { ok: true, id: id };
}
function claimsAll(u) {
  const list = readRows('claims').filter(function (c) { return c.ID; }).map(claimRow).reverse();
  const sum = function (st) { return Math.round(list.filter(function (c) { return c.status === st; }).reduce(function (s, c) { return s + c.amount; }, 0) * 100) / 100; };
  return { ok: true, claims: list, pending: list.filter(function (c) { return c.status === 'submitted'; }).length,
           totals: { submitted: sum('submitted'), approved: sum('approved'), paid: sum('paid') }, me: u.username, role: u.role };
}
function claimDecide(u, d) {
  const f = findRow('claims', 'ID', d.id);
  if (!f) return { ok: false, error: 'Claim not found.' };
  if (String(f.r.Username) === u.username && u.role !== 'admin') return { ok: false, error: 'Someone else has to approve your own claim.' };
  if (String(f.r.Status) !== 'submitted') return { ok: false, error: 'This claim was already ' + f.r.Status + '.' };
  const approve = d.decision === 'approve', reason = clean(d.reason);
  if (!approve && !reason) return { ok: false, error: 'Say why it is rejected, so they know what to fix.' };
  logRow('claims', { 'Status': approve ? 'approved' : 'rejected', 'Decided by': u.username, 'Decided at': fmt(new Date(), 'yyyy-MM-dd'), 'Reason': reason }, f.row);
  audit(u, approve ? 'Approved claim' : 'Rejected claim', f.r.Username + ' $' + Number(f.r.Amount).toFixed(2) + ' ' + f.r.Description + (reason ? ' — ' + reason : ''));
  return { ok: true };
}
// Until payroll exists (phase 2), approved claims are marked paid by hand.
function claimPaid(u, d) {
  const f = findRow('claims', 'ID', d.id);
  if (!f) return { ok: false, error: 'Claim not found.' };
  if (String(f.r.Status) !== 'approved') return { ok: false, error: 'Only approved claims can be marked paid.' };
  if (String(f.r.Username) === u.username && u.role !== 'admin') return { ok: false, error: 'Someone else has to mark your own claim as paid.' };
  logRow('claims', { 'Status': 'paid', 'Paid note': clean(d.note) || ('Paid ' + fmt(new Date(), 'd MMM') + ' by ' + u.name) }, f.row);
  audit(u, 'Marked claim paid', f.r.Username + ' $' + Number(f.r.Amount).toFixed(2));
  return { ok: true };
}

// A viewable link for notice, handbook and receipt photos (anyone with the link can view; evidence photos stay private).
function publicUrl(file) {
  if (file.thumbUrl) return file.thumbUrl();          // demo mode stand-in
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { /* domain may block link sharing */ }
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200';
}

// ---------------------------------------------------------------- hours (timesheets)

function roundQ(h) { return Math.round((Number(h) || 0) * 4) / 4; }    // nearest 15 minutes
function isPeriod(p) { return /^\d{4}-\d{2}$/.test(String(p || '')); }
function periodLabel(p) { return fmt(new Date(p + '-15T12:00:00'), 'MMMM yyyy'); }
function published(period, username) {
  return readRows('payslips').some(function (r) { return String(r.Period) === period && String(r.Username) === username && String(r.Status) === 'published'; });
}

// Shifts by person for a month: [{ username, name, total, open, shifts: [{ row, date, event, in, out, hours, paid, flag }] }]
function hoursFor(period) {
  const byUser = {};
  readRows('timesheet').forEach(function (t, i) {
    if (dstr(t.Date).slice(0, 7) !== period || !t.Staff) return;
    const un = String(t.Staff), b = byUser[un] || (byUser[un] = { username: un, name: nameOf(un), total: 0, open: 0, shifts: [] });
    const closed = !!t['Clock out'], paid = closed ? roundQ(t.Hours) : 0;
    b.total += paid; if (!closed) b.open++;
    b.shifts.push({ row: i + 2, date: dstr(t.Date), event: String(t.Event), in: t['Clock in'] ? fmt(t['Clock in'], 'HH:mm') : '', out: closed ? fmt(t['Clock out'], 'HH:mm') : '',
                    hours: closed ? Number(t.Hours) : '', paid: paid, flag: [t['Late (min)'] ? 'late ' + t['Late (min)'] + ' min' : '', String(t['Clock-out flag'] || '')].filter(String).join('; ') });
  });
  return Object.keys(byUser).map(function (k) { byUser[k].total = Math.round(byUser[k].total * 100) / 100; return byUser[k]; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}
function hoursList(d) {
  const period = isPeriod(d.period) ? d.period : fmt(new Date(), 'yyyy-MM');
  return { ok: true, period: period, label: periodLabel(period), people: hoursFor(period) };
}

// Fix a clock-in/out time (or add a missing clock-out). Not your own, and not after that month's payslip is out.
function fixShift(u, d) {
  const sh = sheet('timesheet'), row = Number(d.row), rs = readRows('timesheet'), t = rs[row - 2];
  if (!t || !t['Clock in']) return { ok: false, error: 'Shift not found.' };
  const un = String(t.Staff), period = dstr(t.Date).slice(0, 7);
  if (un === u.username && u.role !== 'admin') return { ok: false, error: 'Someone else has to fix your own hours.' };
  if (published(period, un)) return { ok: false, error: periodLabel(period) + ' payslip is already published for ' + nameOf(un) + '. Add an adjustment line next month instead.' };
  const reason = clean(d.reason), inM = tmin(d.in), outM = tmin(d.out);
  if (!reason) return { ok: false, error: 'Say why you\'re changing it.' };
  if (inM === null || outM === null) return { ok: false, error: 'Enter both times, e.g. 14:00 and 22:05.' };
  const base = t['Clock in'], newIn = new Date(base.getTime() + (inM - minOfDay(base)) * 6e4);
  let newOut = new Date(base.getTime() + (outM - minOfDay(base)) * 6e4);
  if (newOut <= newIn) newOut = new Date(newOut.getTime() + 864e5);          // past midnight
  const hours = Math.round((newOut - newIn) / 36e5 * 100) / 100;
  if (hours > 16) return { ok: false, error: 'That makes a ' + hours + 'h shift. Check the times.' };
  const before = fmt(base, 'HH:mm') + '–' + (t['Clock out'] ? fmt(t['Clock out'], 'HH:mm') : '?');
  logRow('timesheet', { 'Clock in': newIn, 'Clock out': newOut, 'Hours': hours,
    'Note': [String(t.Note || ''), 'Edited by ' + u.name + ' (was ' + before + '): ' + reason].filter(String).join(' · ') }, row);
  fixTimeFormat();
  audit(u, 'Fixed hours', nameOf(un) + ' ' + dstr(t.Date) + ' ' + before + ' → ' + fmt(newIn, 'HH:mm') + '–' + fmt(newOut, 'HH:mm') + ' — ' + reason);
  return { ok: true, hours: hours };
}

// ---------------------------------------------------------------- payroll & payslips

function sumLines(a) { return Math.round((a || []).reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0) * 100) / 100; }
function parseJson(v, dflt) { try { const x = JSON.parse(String(v || '')); return x == null ? dflt : x; } catch (err) { return dflt; } }
function money2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function payslipRow(period, un) {
  return findRow('payslips', 'ID', period + '-' + un);
}
// Builds one person's payslip for a month. Published payslips are frozen; drafts are recalculated with saved extras.
function payslipFor(period, user, hours) {
  const f = payslipRow(period, user.username);
  if (f && String(f.r.Status) === 'published') return payslipFromRow(f.r);
  const saved = f ? f.r : {};
  const allowances = parseJson(saved.Allowances, []), deductions = parseJson(saved.Deductions, []);
  const claims = readRows('claims').filter(function (c) { return String(c.Username) === user.username && String(c.Status) === 'approved'; })
    .map(function (c) { return { id: String(c.ID), label: String(c.Description) + ' (' + dstr(c.Date) + ')', amount: Number(c.Amount) || 0 }; });
  const h = hours ? hours.total : 0, rate = Number(user.rate) || 0;
  const basic = money2(user.payType === 'monthly' ? rate : rate * h);
  const cpfEe = money2(saved['CPF employee']), cpfEr = money2(saved['CPF employer']);
  const gross = money2(basic + sumLines(allowances)), net = money2(gross - sumLines(deductions) - cpfEe);
  return { id: period + '-' + user.username, period: period, label: periodLabel(period), username: user.username, name: user.name, status: 'draft',
           payType: user.payType || 'hourly', rate: rate, hours: h, open: hours ? hours.open : 0, basic: basic, allowances: allowances, deductions: deductions,
           claims: claims, cpfEmployee: cpfEe, cpfEmployer: cpfEr, gross: gross, net: net, total: money2(net + sumLines(claims)),
           notes: String(saved.Notes || ''), payDate: '', noRate: !rate };
}
function payslipFromRow(r) {
  return { id: String(r.ID), period: String(r.Period), label: periodLabel(String(r.Period)), username: String(r.Username), name: String(r.Name), status: String(r.Status),
           payType: String(r['Pay type']), rate: Number(r.Rate) || 0, hours: Number(r.Hours) || 0, open: 0, basic: Number(r.Basic) || 0,
           allowances: parseJson(r.Allowances, []), deductions: parseJson(r.Deductions, []), claims: parseJson(r.Claims, []),
           cpfEmployee: Number(r['CPF employee']) || 0, cpfEmployer: Number(r['CPF employer']) || 0, gross: Number(r.Gross) || 0, net: Number(r.Net) || 0,
           total: Number(r['Total paid']) || 0, notes: String(r.Notes || ''), payDate: dstr(r['Pay date'] || ''), publishedBy: r['Published by'] ? nameOf(r['Published by']) : '' };
}
function payrollList(u, d) {
  const period = isPeriod(d.period) ? d.period : fmt(new Date(), 'yyyy-MM');
  const hours = {}; hoursFor(period).forEach(function (h) { hours[h.username] = h; });
  const people = readRows('users').filter(function (r) { return isActive(r.Active) || hours[String(r.Username)]; }).map(function (r) { return findUser(r.Username); });
  const slips = people.map(function (p) { return payslipFor(period, p, hours[p.username]); })
    .filter(function (s) { return s.status === 'published' || s.hours > 0 || s.payType === 'monthly' && s.rate > 0 || s.claims.length; });
  return { ok: true, period: period, label: periodLabel(period), payslips: slips, me: u.username, role: u.role, company: setting('Company name') || 'Kwazy Korndog',
           totals: { gross: money2(slips.reduce(function (s, x) { return s + x.gross; }, 0)), total: money2(slips.reduce(function (s, x) { return s + x.total; }, 0)),
                     cpfEr: money2(slips.reduce(function (s, x) { return s + x.cpfEmployer; }, 0)) } };
}
function cleanLines(a) {
  return (Array.isArray(a) ? a : []).filter(function (x) { return x && clean(x.label) && Number(x.amount); })
    .map(function (x) { return { label: clean(x.label).slice(0, 80), amount: money2(x.amount) }; });
}
function payslipSave(u, d) {
  const un = String(d.username || ''), period = String(d.period || '');
  if (!isPeriod(period) || !findUser(un)) return { ok: false, error: 'Payslip not found.' };
  if (un === u.username && u.role !== 'admin') return { ok: false, error: 'An admin prepares your own payslip.' };
  const f = payslipRow(period, un);
  if (f && String(f.r.Status) === 'published') return { ok: false, error: 'This payslip is already published.' };
  logRow('payslips', { 'ID': period + '-' + un, 'Period': period, 'Username': un, 'Name': nameOf(un), 'Status': 'draft',
    'Allowances': JSON.stringify(cleanLines(d.allowances)), 'Deductions': JSON.stringify(cleanLines(d.deductions)),
    'CPF employee': money2(d.cpfEmployee), 'CPF employer': money2(d.cpfEmployer), 'Notes': clean(d.notes) }, f ? f.row : undefined);
  return { ok: true };
}
// Freezes the drafts, marks the included claims as paid. Managers can't publish their own payslip.
function payrollPublish(u, d) {
  const list = payrollList(u, d), skipped = [];
  let n = 0;
  list.payslips.forEach(function (s) {
    if (s.status === 'published') return;
    if (Array.isArray(d.usernames) && d.usernames.indexOf(s.username) < 0) return;
    if (s.username === u.username && u.role !== 'admin') { skipped.push('your own payslip (an admin publishes it)'); return; }
    if (s.open) { skipped.push(s.name + ' (has a shift with no clock-out)'); return; }
    const f = payslipRow(list.period, s.username);
    logRow('payslips', { 'ID': s.id, 'Period': s.period, 'Username': s.username, 'Name': s.name, 'Status': 'published', 'Pay type': s.payType, 'Rate': s.rate,
      'Hours': s.hours, 'Basic': s.basic, 'Allowances': JSON.stringify(s.allowances), 'Claims': JSON.stringify(s.claims), 'Deductions': JSON.stringify(s.deductions),
      'CPF employee': s.cpfEmployee, 'CPF employer': s.cpfEmployer, 'Gross': s.gross, 'Net': s.net, 'Total paid': s.total, 'Notes': s.notes,
      'Pay date': fmt(new Date(), 'yyyy-MM-dd'), 'Published by': u.username, 'Published at': new Date() }, f ? f.row : undefined);
    s.claims.forEach(function (c) {
      const cf = findRow('claims', 'ID', c.id);
      if (cf && String(cf.r.Status) === 'approved') logRow('claims', { 'Status': 'paid', 'Paid note': 'Paid with ' + s.label + ' payslip' }, cf.row);
    });
    n++;
  });
  audit(u, 'Published payslips', list.label + ' (' + n + ')');
  return { ok: true, published: n, skipped: skipped };
}
function myPayslips(u) {
  return { ok: true, company: setting('Company name') || 'Kwazy Korndog',
           payslips: readRows('payslips').filter(function (r) { return String(r.Username) === u.username && String(r.Status) === 'published'; }).map(payslipFromRow).reverse() };
}

// ---------------------------------------------------------------- cash bags (closing → handed to a manager → banked)

function bagRow(r) {
  return { id: String(r.ID), date: dstr(r.Date), event: String(r.Event), closedBy: nameOf(r['Closed by']), amount: Number(r.Amount) || 0, status: String(r.Status),
           receivedBy: r['Received by'] ? nameOf(r['Received by']) : '', receivedAt: r['Received at'] ? fmt(r['Received at'], 'd MMM HH:mm') : '',
           receivedAmount: r['Received amount'] === '' ? '' : Number(r['Received amount']), bankedBy: r['Banked by'] ? nameOf(r['Banked by']) : '',
           bankedAt: r['Banked at'] ? fmt(r['Banked at'], 'd MMM') : '', bankedAmount: r['Banked amount'] === '' ? '' : Number(r['Banked amount']),
           slip: String(r.Slip || ''), notes: String(r.Notes || ''), method: String(r.Method || ''), closedByUser: String(r['Closed by']),
           verifiedBy: r['Verified by'] ? nameOf(r['Verified by']) : '', due: cashDue(r), overdue: cashOverdue(r),
           checked: r['Sales checked by'] !== '' && r['Sales checked by'] !== undefined, checkedBy: r['Sales checked by'] ? nameOf(r['Sales checked by']) : '',
           sales: { total: numOrBlank(r['HitPay total sales']), cash: numOrBlank(r['HitPay cash sales']), paynow: numOrBlank(r['PayNow sales']), orders: numOrBlank(r.Orders) },
           diff: numOrBlank(r['Cash difference']), query: String(r.Query || ''), reply: String(r.Reply || ''), resolved: String(r['Query resolved'] || '') };
}
// Crew must hand the bag over or bank it within N days of closing.
function cashDue(r) { return addDays(dstr(r.Date), Number(setting('Cash hand-in days')) || 3); }
function cashOverdue(r) {
  if (String(r.Status) !== 'with closer') return 0;
  const today = fmt(new Date(), 'yyyy-MM-dd'), due = cashDue(r);
  return today > due ? Math.round((new Date(today + 'T12:00:00') - new Date(due + 'T12:00:00')) / 864e5) : 0;
}
function cashList() {
  const bags = readRows('cash').filter(function (r) { return r.ID; }).map(bagRow).reverse();
  const holders = {};
  bags.forEach(function (b) {
    if (b.status === 'banked' || b.status === 'deposited') return;
    const who = b.status === 'received' ? b.receivedBy : b.closedBy, amt = b.status === 'received' && b.receivedAmount !== '' ? b.receivedAmount : b.amount;
    holders[who] = money2((holders[who] || 0) + amt);
  });
  const notBanked = money2(Object.keys(holders).reduce(function (s, k) { return s + holders[k]; }, 0));
  const deposited = bags.filter(function (b) { return b.status === 'deposited'; });
  return { ok: true, bags: bags.slice(0, 120), notBanked: notBanked, holders: Object.keys(holders).map(function (k) { return { name: k, amount: holders[k] }; }),
           toReceive: bags.filter(function (b) { return b.status === 'with closer'; }).length,
           overdue: bags.filter(function (b) { return b.overdue > 0; }).map(function (b) { return { name: b.closedBy, amount: b.amount, days: b.overdue, event: b.event, date: b.date }; }),
           toCheck: bags.filter(function (b) { return !b.checked; }).length,
           queries: bags.filter(function (b) { return b.query && !b.resolved; }).length,
           toVerify: deposited.map(function (b) { return b.slip; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).length, awaitingCheck: money2(deposited.reduce(function (s, b) { return s + b.amount; }, 0)) };
}
function cashReceive(u, d) {
  const f = findRow('cash', 'ID', d.id);
  if (!f) return { ok: false, error: 'Cash bag not found.' };
  if (String(f.r.Status) !== 'with closer') return { ok: false, error: 'This bag was already received.' };
  const amt = money2(d.amount === '' || d.amount === undefined ? f.r.Amount : d.amount), expected = Number(f.r.Amount) || 0, note = clean(d.note);
  if (Math.abs(amt - expected) > 0.005 && !note) return { ok: false, error: 'The bag should have $' + expected.toFixed(2) + '. Say why it\'s different.' };
  logRow('cash', { 'Status': 'received', 'Received by': u.username, 'Received at': new Date(), 'Received amount': amt,
                   'Notes': [String(f.r.Notes || ''), note].filter(String).join(' · ') }, f.row);
  if (Math.abs(amt - expected) > 0.005) addAlert(String(f.r.Event), dstr(f.r.Date), 'Cash bag received with $' + amt.toFixed(2) + ' instead of $' + expected.toFixed(2) + ': ' + note);
  audit(u, 'Received cash bag', f.r.Event + ' ' + dstr(f.r.Date) + ' $' + amt.toFixed(2));
  return { ok: true };
}
// One bank deposit can cover several bags.
function cashBank(u, d) {
  const ids = Array.isArray(d.ids) ? d.ids : [], rows = ids.map(function (id) { return findRow('cash', 'ID', id); }).filter(Boolean);
  if (!rows.length) return { ok: false, error: 'Pick the cash bags you banked.' };
  if (rows.some(function (f) { return ['banked', 'deposited'].indexOf(String(f.r.Status)) >= 0; })) return { ok: false, error: 'One of those bags is already banked.' };
  if (!isPhoto(d.slip)) return { ok: false, error: 'Add a photo of the deposit slip.' };
  const expected = money2(rows.reduce(function (s, f) { return s + (f.r['Received amount'] !== '' ? Number(f.r['Received amount']) : Number(f.r.Amount)); }, 0));
  const amt = money2(d.amount), note = clean(d.note);
  if (!(amt > 0)) return { ok: false, error: 'Enter the amount on the deposit slip.' };
  if (Math.abs(amt - expected) > 0.005 && !note) return { ok: false, error: 'Those bags add up to $' + expected.toFixed(2) + '. Say why the deposit is different.' };
  const slip = publicUrl(saveImage(subFolder(photoFolder(), 'Deposit slips'), d.slip, fmt(new Date(), 'yyyy-MM-dd') + ' deposit $' + amt.toFixed(2)));
  rows.forEach(function (f, i) {
    logRow('cash', { 'Status': 'banked', 'Banked by': u.username, 'Banked at': new Date(), 'Slip': slip, 'Method': 'Bank deposit', 'Verified by': u.username, 'Verified at': new Date(),
      'Banked amount': i === 0 ? amt : 0, 'Notes': [String(f.r.Notes || ''), i === 0 ? 'Deposit $' + amt.toFixed(2) + ' for ' + rows.length + ' bag(s)' + (note ? ': ' + note : '') : 'Banked with ' + rows[0].r.Event + ' ' + dstr(rows[0].r.Date)].filter(String).join(' · ') }, f.row);
  });
  if (Math.abs(amt - expected) > 0.005) addAlert(String(rows[0].r.Event), fmt(new Date(), 'yyyy-MM-dd'), 'Bank deposit $' + amt.toFixed(2) + ' vs $' + expected.toFixed(2) + ' in the bags: ' + note);
  audit(u, 'Banked cash', '$' + amt.toFixed(2) + ' (' + rows.length + ' bags)');
  return { ok: true };
}

// A manager enters HitPay's day totals for a closing and checks the cash in the bag against cash sales.
function cashSalesCheck(u, d) {
  const f = findRow('cash', 'ID', d.id);
  if (!f) return { ok: false, error: 'Closing not found.' };
  if (String(f.r['Closed by']) === u.username && u.role !== 'admin') return { ok: false, error: 'Someone else has to check your own closing.' };
  const n = function (k) { return d[k] === '' || d[k] === undefined || d[k] === null || !(Number(d[k]) >= 0) ? null : Number(d[k]); };
  const tot = n('total'), cash = n('cash'), pn = n('paynow'), ord = n('orders');            // orders are optional
  if ([tot, cash, pn].some(function (x) { return x === null; })) return { ok: false, error: 'Enter total sales, cash sales and PayNow sales from HitPay.' };
  const bag = Number(f.r.Amount) || 0, diff = money2(bag - cash), tol = Number(setting('Cash tolerance ($)')) || 5, off = Math.abs(diff) > tol;
  const query = off ? 'Cash in the bag $' + bag.toFixed(2) + ' vs HitPay cash sales $' + cash.toFixed(2) + ' (' + (diff < 0 ? 'short' : 'over') + ' $' + Math.abs(diff).toFixed(2) + ')' : '';
  logRow('cash', { 'HitPay total sales': tot, 'HitPay cash sales': cash, 'PayNow sales': pn, 'Orders': ord === null ? '' : ord, 'Sales checked by': u.username, 'Sales checked at': new Date(),
                   'Cash difference': diff, 'Query': query, 'Reply': off ? String(f.r.Reply || '') : '', 'Query resolved': off ? '' : String(f.r['Query resolved'] || '') }, f.row);
  if (off) addAlert(String(f.r.Event), dstr(f.r.Date), query + '. Asked ' + nameOf(f.r['Closed by']) + ' to explain.');
  audit(u, 'Checked closing cash', f.r.Event + ' ' + dstr(f.r.Date) + ': ' + (off ? query : 'matches'));
  return { ok: true, diff: diff, flagged: off };
}
function cashReply(u, d) {
  const f = findRow('cash', 'ID', d.id);
  if (!f || String(f.r['Closed by']) !== u.username || !f.r.Query) return { ok: false, error: 'Nothing to reply to.' };
  if (!clean(d.reply)) return { ok: false, error: 'Write what happened.' };
  logRow('cash', { 'Reply': clean(d.reply) + ' (' + fmt(new Date(), 'd MMM HH:mm') + ')' }, f.row);
  return { ok: true };
}
function cashResolve(u, d) {
  const f = findRow('cash', 'ID', d.id);
  if (!f || !f.r.Query) return { ok: false, error: 'Nothing to resolve.' };
  if (!clean(d.note)) return { ok: false, error: 'Add a short note on how it was sorted.' };
  logRow('cash', { 'Query resolved': clean(d.note) + ' — ' + u.name }, f.row);
  audit(u, 'Resolved cash query', f.r.Event + ' ' + dstr(f.r.Date) + ': ' + clean(d.note));
  return { ok: true };
}

// The cash bags this person is holding (or has banked, waiting for a manager to check), plus any cash count questions.
function myCash(u) {
  const all = readRows('cash').filter(function (r) { return r.ID && String(r['Closed by']) === u.username; });
  const mine = all.filter(function (r) { return ['with closer', 'deposited'].indexOf(String(r.Status)) >= 0; }).map(bagRow);
  const queries = all.filter(function (r) { return r.Query && !r['Query resolved']; }).map(bagRow);
  const holding = mine.filter(function (b) { return b.status === 'with closer'; });
  return { ok: true, bags: mine, holding: money2(holding.reduce(function (s, b) { return s + b.amount; }, 0)),
           due: holding.length ? holding.map(function (b) { return b.due; }).sort()[0] : '', overdue: Math.max.apply(null, [0].concat(holding.map(function (b) { return b.overdue; }))),
           pending: money2(mine.filter(function (b) { return b.status === 'deposited'; }).reduce(function (s, b) { return s + b.amount; }, 0)),
           days: Number(setting('Cash hand-in days')) || 3, transferDetails: String(setting('Bank transfer details') || ''), queries: queries };
}
// Crew banked the cash or transferred it to the company: proof photo, then a manager verifies.
function cashDeposit(u, d) {
  const ids = Array.isArray(d.ids) ? d.ids : [], rows = ids.map(function (id) { return findRow('cash', 'ID', id); }).filter(Boolean);
  if (!rows.length) return { ok: false, error: 'Pick the cash you banked.' };
  if (rows.some(function (f) { return String(f.r['Closed by']) !== u.username || String(f.r.Status) !== 'with closer'; })) return { ok: false, error: 'You can only bank cash you\'re holding.' };
  const method = d.method === 'Bank transfer' ? 'Bank transfer' : 'Bank deposit';
  if (!isPhoto(d.proof)) return { ok: false, error: method === 'Bank transfer' ? 'Add a screenshot of the transfer.' : 'Add a photo of the deposit slip.' };
  const amt = money2(d.amount), expected = money2(rows.reduce(function (s, f) { return s + Number(f.r.Amount); }, 0)), note = clean(d.note);
  if (!(amt > 0)) return { ok: false, error: 'Enter the amount you ' + (method === 'Bank transfer' ? 'transferred.' : 'banked.') };
  if (Math.abs(amt - expected) > 0.005 && !note) return { ok: false, error: 'You were holding $' + expected.toFixed(2) + '. Say why the amount is different.' };
  const proof = publicUrl(saveImage(subFolder(photoFolder(), 'Deposit slips'), d.proof, fmt(new Date(), 'yyyy-MM-dd') + ' ' + u.username + ' ' + method + ' $' + amt.toFixed(2)));
  rows.forEach(function (f, i) {
    logRow('cash', { 'Status': 'deposited', 'Banked by': u.username, 'Banked at': new Date(), 'Banked amount': i === 0 ? amt : 0, 'Slip': proof, 'Method': method,
      'Notes': [String(f.r.Notes || ''), method + ' by ' + u.name + (i === 0 ? ' $' + amt.toFixed(2) + (rows.length > 1 ? ' for ' + rows.length + ' bags' : '') + (note ? ': ' + note : '') : '')].filter(String).join(' · ') }, f.row);
  });
  audit(u, 'Banked own cash', method + ' $' + amt.toFixed(2) + ' (' + rows.length + ' bag' + (rows.length > 1 ? 's' : '') + ')');
  return { ok: true };
}
// A manager checks a crew deposit against the bank. Bags banked together are verified together.
function cashVerify(u, d) {
  const f = findRow('cash', 'ID', d.id);
  if (!f || String(f.r.Status) !== 'deposited') return { ok: false, error: 'Nothing to verify.' };
  if (String(f.r['Banked by']) === u.username) return { ok: false, error: 'Someone else has to verify your own deposit.' };
  const group = readRows('cash').map(function (r, i) { return { r: r, row: i + 2 }; })
    .filter(function (x) { return String(x.r.Status) === 'deposited' && String(x.r.Slip) === String(f.r.Slip); });
  const expected = money2(group.reduce(function (s, x) { return s + Number(x.r.Amount); }, 0));
  const banked = money2(group.reduce(function (s, x) { return s + (Number(x.r['Banked amount']) || 0); }, 0));
  const seen = d.amount === '' || d.amount === undefined ? banked : money2(d.amount), note = clean(d.note);
  if (Math.abs(seen - expected) > 0.005 && !note) return { ok: false, error: 'The bag' + (group.length > 1 ? 's' : '') + ' had $' + expected.toFixed(2) + '. Say what you found.' };
  group.forEach(function (x) { logRow('cash', { 'Status': 'banked', 'Verified by': u.username, 'Verified at': new Date(), 'Notes': [String(x.r.Notes || ''), note].filter(String).join(' · ') }, x.row); });
  if (Math.abs(seen - expected) > 0.005) addAlert(String(f.r.Event), dstr(f.r.Date), nameOf(f.r['Banked by']) + '\'s ' + String(f.r.Method).toLowerCase() + ' was $' + seen.toFixed(2) + ', not $' + expected.toFixed(2) + ': ' + note);
  audit(u, 'Verified cash deposit', nameOf(f.r['Banked by']) + ' $' + seen.toFixed(2));
  return { ok: true };
}

// ---------------------------------------------------------------- sales (from the HitPay totals entered at closing)

function salesSummary(d) {
  const today = fmt(new Date(), 'yyyy-MM-dd');
  const from = isDay(d.from) ? d.from : addDays(today, -6), to = isDay(d.to) ? d.to : today;
  const days = {};
  readRows('cash').forEach(function (r) {
    const day = dstr(r.Date);
    if (day < from || day > to || r['HitPay total sales'] === '' || r['HitPay total sales'] === undefined) return;
    days[day + '|' + r.Event] = { date: day, event: String(r.Event), total: Number(r['HitPay total sales']) || 0, cash: Number(r['HitPay cash sales']) || 0,
                                  paynow: Number(r['PayNow sales']) || 0, orders: Number(r.Orders) || 0 };      // latest submission wins
  });
  const rows = Object.keys(days).map(function (k) { return days[k]; }).sort(function (a, b) { return a.date.localeCompare(b.date) || a.event.localeCompare(b.event); });
  const colour = {}; eventsList(false).forEach(function (e) { colour[e.name] = e.colour; });
  rows.forEach(function (r) { r.colour = colour[r.event] || 'grey'; });
  const unchecked = readRows('cash').filter(function (r) { const day = dstr(r.Date); return day >= from && day <= to && (r['HitPay total sales'] === '' || r['HitPay total sales'] === undefined); }).length;
  return { ok: true, from: from, to: to, rows: rows, unchecked: unchecked };
}

// ---------------------------------------------------------------- stock on hand, minimums and templates

function numOrBlank(v) { return v === '' || v === null || v === undefined || isNaN(Number(v)) ? '' : Number(v); }
function templateRows() {
  return readRows('stockTpl').filter(function (r) { return r.Template && r.Item; }).map(function (r) {
    return { template: String(r.Template).trim(), category: String(r.Category).trim(), item: String(r.Item).trim(), min: numOrBlank(r.Minimum), top: numOrBlank(r['Top up']) };
  });
}
// The items an event carries, with its minimum and top-up level. No levels set yet = every item at the default minimum.
function eventLevels(event) {
  const lv = {};
  readRows('eventStock').forEach(function (r) { if (String(r.Event) === event) lv[String(r.Category).trim() + '|' + String(r.Item).trim()] = r; });
  return stockRows().filter(function (s) { const r = lv[s.category + '|' + s.item]; return !r || numOrBlank(r.Minimum) !== ''; }).map(function (s) {
    const r = lv[s.category + '|' + s.item], min = r ? numOrBlank(r.Minimum) : s.min, top = r ? numOrBlank(r['Top up']) : '';
    return { category: s.category, item: s.item, unit: s.unit, na: s.na, min: min, top: top === '' ? min : Math.max(top, min) };
  });
}
function setEventLevels(event, rows) {
  deleteWhere('eventStock', function (r) { return String(r.Event) === event; });
  const sh = sheet('eventStock'), out = rows.map(function (r) { return [event, r.category, r.item, r.min, r.top]; });
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  _cache.eventStock = null;
}
function cleanLevels(rows) {
  const out = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i], min = numOrBlank(r.min), top = numOrBlank(r.top);
    if ((min !== '' && min < 0) || (top !== '' && top < 0)) return { error: 'Levels can\'t be negative (' + r.item + ').' };
    if (min !== '' && top !== '' && top < min) return { error: r.item + ': the top-up level is below the minimum.' };
    out.push({ category: String(r.category), item: String(r.item), min: min, top: min === '' ? '' : (top === '' ? min : top) });
  }
  return { rows: out };
}

function stockLevelsSave(u, d) {
  const event = clean(d.event);
  if (!findEvent(event)) return { ok: false, error: 'Event not found.' };
  const c = cleanLevels(d.rows);
  if (c.error) return { ok: false, error: c.error };
  setEventLevels(event, c.rows);
  if (d.template) logRow('events', { 'Stock template': clean(d.template) }, findEvent(event).row);
  clearRestock();
  audit(u, 'Set stock levels', event + (d.template ? ' (from ' + d.template + ')' : ''));
  return { ok: true };
}

function templatesList() {
  const names = [], rows = templateRows();
  rows.forEach(function (r) { if (names.indexOf(r.template) < 0) names.push(r.template); });
  return { ok: true, templates: names.map(function (n) { return { name: n, rows: rows.filter(function (r) { return r.template === n; }) }; }), items: stockRows() };
}
function templateSave(u, d) {
  const name = clean(d.name), old = clean(d.originalName);
  if (d.remove) { deleteWhere('stockTpl', function (r) { return String(r.Template) === old; }); audit(u, 'Removed stock template', old); return { ok: true }; }
  if (!name) return { ok: false, error: 'Give the template a name, e.g. Bazaar.' };
  if (name !== old && templateRows().some(function (t) { return t.template === name; })) return { ok: false, error: 'A template with that name already exists.' };
  const c = cleanLevels(d.rows);
  if (c.error) return { ok: false, error: c.error };
  deleteWhere('stockTpl', function (r) { return String(r.Template) === (old || name); });
  const sh = sheet('stockTpl'), out = c.rows.map(function (r) { return [name, r.category, r.item, r.min, r.top]; });
  if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  _cache.stockTpl = null;
  audit(u, old ? 'Edited stock template' : 'Added stock template', name);
  return { ok: true };
}

// What the manager packed and sent to an event.
function openingStock(u, d) {
  const event = clean(d.event);
  if (!findEvent(event)) return { ok: false, error: 'Event not found.' };
  const lv = {}; eventLevels(event).forEach(function (s) { lv[s.category + '|' + s.item] = s; });
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd');
  const out = (Array.isArray(d.counts) ? d.counts : []).filter(function (c) { return c.count !== '' && c.count !== null && !isNaN(Number(c.count)) && lv[c.category + '|' + c.item]; })
    .map(function (c) { const s = lv[c.category + '|' + c.item]; return [now, day, event, u.username, s.category, s.item, s.unit, Number(c.count), s.min, Number(c.count) < s.min ? 'Y' : '', 'opening']; });
  if (!out.length) return { ok: false, error: 'Enter at least one quantity.' };
  ensureCols('stockLog');
  const sh = sheet('stockLog');
  sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
  _cache.stockLog = null;
  clearRestock();
  audit(u, 'Entered opening stock', event + ' (' + out.length + ' items)');
  return { ok: true, saved: out.length };
}

// On hand at each current event = the latest count per item (opening stock or closing stock take).
function stockOverview() {
  const today = fmt(new Date(), 'yyyy-MM-dd');
  const events = eventsList(true).filter(function (e) { return (!e.start || e.start <= addDays(today, 3)) && (!e.end || e.end >= addDays(today, -1)); });
  const log = readRows('stockLog');
  return { ok: true, events: events.map(function (e) {
    const have = {}; let last = null;
    log.forEach(function (r) {
      if (String(r.Event) !== e.name) return;
      have[String(r.Category) + '|' + String(r.Item)] = { count: r.Count, when: r.Timestamp };
      last = { time: r.Timestamp ? fmt(r.Timestamp, 'd MMM HH:mm') : '', by: nameOf(r.Staff), type: r.Type === 'opening' ? 'Opening stock' : 'Closing count' };
    });
    const items = eventLevels(e.name).map(function (s) {
      const h = have[s.category + '|' + s.item], n = h && h.count !== 'N/A' && h.count !== '' ? Number(h.count) : null;
      return { category: s.category, item: s.item, unit: s.unit, min: s.min, top: s.top, onHand: h ? (h.count === 'N/A' ? 'N/A' : n) : null,
               need: n !== null && s.min !== '' && n < s.min ? Math.max(0, s.top - n) : 0 };
    });
    return { name: e.name, colour: e.colour, start: e.start, end: e.end, template: e.template, last: last, items: items,
             needCount: items.filter(function (i) { return i.need > 0; }).length, counted: !!last };
  }) };
}

function restockCount() {
  const cache = CacheService.getScriptCache(), hit = cache.get('restock');
  if (hit !== null) return Number(hit);
  const n = stockOverview().events.filter(function (e) { return e.needCount; }).length;
  cache.put('restock', String(n), 300);
  return n;
}
function clearRestock() { CacheService.getScriptCache().remove('restock'); }

// Deletes rows matching fn (bottom-up so row numbers stay right).
function deleteWhere(key, fn) {
  const sh = sheet(key), rs = readRows(key);
  for (let i = rs.length - 1; i >= 0; i--) if (fn(rs[i])) sh.deleteRow(i + 2);
  _cache[key] = null;
}
// Adds any header columns a tab is missing (for tabs written with setValues rather than logRow).
function ensureCols(key) {
  const sh = sheet(key), head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  TABS[key].forEach(function (h, i) { if (head[i] !== h) sh.getRange(1, i + 1).setValue(h).setFontWeight('bold'); });
}

// ---------------------------------------------------------------- evidence photos (saved the moment they are taken)

function savePhotoItem(name, event, d) {
  const shift = ['Opening', 'Closing', 'Stock'].indexOf(d.shift) >= 0 ? d.shift : 'Opening';
  if (!isPhoto(d.photo)) return { ok: false, error: 'Photo is missing or too big. Please retake it.' };
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd');
  if (shift !== 'Opening' && !(dayRow(event, day, false) || { r: {} }).r['Stop sale']) {
    return { ok: false, error: 'Tap Stop sale on the hub before uploading closing evidence.' };
  }
  const folder = subFolder(dayFolder(now), event + ' · ' + shift);
  const file = saveImage(folder, d.photo, fmt(now, 'HHmm') + ' ' + clean(d.step) + ' — ' + name);
  logRow('photoLog', { 'Timestamp': now, 'Date': day, 'Event': event, 'Shift': shift, 'Staff': name,
                       'Step': clean(d.step), 'Item': clean(d.item), 'File ID': file.getId(), 'Link': file.getUrl() });
  return { ok: true, id: file.getId(), time: fmt(now, 'HH:mm') };
}

// ---------------------------------------------------------------- checklists: Opening, Closing, Stock

function saveChecklist(name, event, d, mgr) {
  const shift = ['Opening', 'Closing', 'Stock'].indexOf(d.shift) >= 0 ? d.shift : 'Opening';
  const now = new Date(), day = fmt(now, 'yyyy-MM-dd'), dl = dayRow(event, day, true);
  if (shift !== 'Opening' && !dl.r['Stop sale']) return { ok: false, error: 'Tap Stop sale on the hub first.' };

  const r = evaluate(shift, d, event, day);
  if (r.error) return r;
  const folderUrl = r.photos.length ? subFolder(dayFolder(now), event + ' · ' + shift).getUrl() : '';
  const t = fmt(now, 'HH:mm');
  let low = [];

  if (shift === 'Opening') {
    logRow('openLog', Object.assign({ 'Timestamp': now, 'Date': day, 'Event': event, 'Staff': name,
      'Skipped': r.skipped.join('; '), 'Photos': folderUrl, 'Notes': clean(d.notes) }, r.answers));
    logRow('dayLog', { 'Opening done': t, 'Opening by': name, 'Opening photos': folderUrl }, dl.row);
  } else if (shift === 'Stock') {
    const sh = sheet('stockLog');
    ensureCols('stockLog');
    const out = r.stock.map(function (s) { return [now, day, event, name, s.category, s.item, s.unit, s.count, s.min, s.low ? 'Y' : '', 'closing']; });
    if (out.length) { sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out); _cache.stockLog = null; }
    low = r.stock.filter(function (s) { return s.low; }).map(function (s) { return s.item + ' (' + s.category.replace(/ \(.*\)/, '') + ') ' + s.count + '/' + s.min; });
    logRow('dayLog', { 'Stock take done': t, 'Stock take by': name }, dl.row);
    clearRestock();
  } else {
    const mins = minOfDay(now) - tmin(dl.r['Stop sale']);
    logRow('closeLog', Object.assign({ 'Timestamp': now, 'Date': day, 'Event': event, 'Staff': name,
      'Skipped': r.skipped.join('; '), 'Photos': folderUrl, 'Remarks': clean(d.notes) }, r.cash || {}, r.answers));
    logRow('dayLog', { 'Closing done': t, 'Closing by': name, 'Mins stop sale → closing': mins, 'Closing photos': folderUrl }, dl.row);
    if (r.cash) {                                   // the cash bag starts with the closer until a manager receives it
      const bag = readRows('cash').filter(function (b) { return String(b.Event) === event && dstr(b.Date) === day; })[0];
      const bf = bag ? findRow('cash', 'ID', bag.ID) : null;
      if (!bf || String(bf.r.Status) === 'with closer') {
        logRow('cash', { 'ID': bf ? String(bf.r.ID) : Utilities.getUuid().slice(0, 8), 'Date': day, 'Event': event, 'Closed by': name,
                         'Amount': r.cash['Cash deposit'], 'Status': 'with closer' }, bf ? bf.row : undefined);
      }
    }
  }
  r.alerts.forEach(function (a) { addAlert(event, day, a); });
  return { ok: true, time: t, alerts: r.alerts, low: mgr ? low : [], cashBag: r.cash ? r.cash['Cash deposit'] : null,
           cashDue: r.cash ? addDays(day, Number(setting('Cash hand-in days')) || 3) : '' };
}

// d.items: [{ step, item, value, note }]. Value by type: tick true/false · yesno 'Yes'/'No' · choice option text ·
// text string · photo { id } from savePhotoItem · cash { hitpay, deposit } · stock [{ category, item, count }].
function evaluate(shift, d, event, day) {
  const got = {};
  (Array.isArray(d.items) ? d.items : []).forEach(function (x) { got[x.step + '|' + x.item] = x; });
  const list = checklistRows().filter(function (t) { return t.shift === shift; });
  if (!list.length) return { ok: false, error: 'Nothing set up for ' + shift + ' in the Checklist tab.' };
  const uploaded = {};
  readRows('photoLog').forEach(function (p) { if (String(p.Event) === event && dstr(p.Date) === day) uploaded[p['File ID']] = true; });

  const problems = [], skipped = [], alerts = [], photos = [], answers = {}, out = { stock: [], cash: null };
  list.forEach(function (t) {
    if (!shown(t, got)) return;                        // e.g. "Oil changed?" only when "Oil OK? = No"
    const x = got[t.step + '|' + t.item] || {}, v = x.value, note = clean(x.note);
    const flagged = t.flagIf && String(v).toLowerCase() === t.flagIf.toLowerCase();
    if (t.type === 'photo') {
      if (!(v && uploaded[v.id])) problems.push('photo for ' + t.step); else photos.push(v.id);
    } else if (t.type === 'yesno') {
      if (v !== 'Yes' && v !== 'No') problems.push('answer "' + t.item + '"');
      else if (flagged && !note) problems.push('details for "' + t.item + '"');
      else {
        answers[t.item] = v + (note ? ' — ' + note : '');
        if (flagged) alerts.push(t.item.replace(/\?$/, '') + ': ' + v + ' — ' + note);
      }
    } else if (t.type === 'choice') {
      if (t.options.indexOf(String(v)) < 0) problems.push('pick "' + t.item + '"');
      else { answers[t.item] = v; if (flagged) alerts.push(t.item + ': ' + v); }
    } else if (t.type === 'text') {
      if (!clean(v)) { if (t.critical) problems.push('"' + t.item + '"'); } else answers[t.item] = clean(v);
    } else if (t.type === 'stock') {
      const res = countStock(v, event);
      if (res.error) problems.push(res.error); else out.stock = res.rows;
    } else if (t.type === 'cash') {
      // Crew count the cash in the bag. A manager checks it against HitPay's cash sales afterwards (Manage → Cash).
      const dep = v && v.deposit !== '' && v.deposit !== undefined && v.deposit !== null && Number(v.deposit) >= 0 ? Number(v.deposit) : null;
      if (dep === null) problems.push('the cash in the bag');
      else out.cash = { 'Cash deposit': dep };
    } else {
      if (v === true) answers[t.item] = '✓';
      else if (t.critical) problems.push('"' + t.item + '"');
      else skipped.push(t.item);
    }
  });
  if (problems.length) return { ok: false, error: 'Still needed: ' + problems.join(', ') };
  return { photos: photos, answers: answers, skipped: skipped, alerts: alerts, stock: out.stock, cash: out.cash };
}

function countStock(counts, event) {
  const got = {};
  (Array.isArray(counts) ? counts : []).forEach(function (c) { got[c.category + '|' + c.item] = c.count; });
  const missing = [], rowsOut = [];
  eventLevels(event).forEach(function (s) {
    const c = got[s.category + '|' + s.item];
    if (c === 'N/A' && s.na) { rowsOut.push(Object.assign({ count: 'N/A', low: false }, s)); return; }
    const n = Number(c);
    if (c === undefined || c === '' || c === null || isNaN(n) || n < 0) { missing.push(s.item); return; }
    rowsOut.push(Object.assign({ count: n, low: s.min !== '' && n < s.min }, s));
  });
  if (missing.length) return { error: 'stock count for ' + missing.join(', ') };
  return { rows: rowsOut };
}

// "Show if" rule like "Oil OK? = No": the item only applies when that answer was given (same step).
function shown(t, got) {
  if (!t.showIf) return true;
  const m = t.showIf.match(/^(.*?)=(.*)$/);
  if (!m) return true;
  const x = got[t.step + '|' + m[1].trim()];
  return !!x && String(x.value).toLowerCase() === m[2].trim().toLowerCase();
}

// ---------------------------------------------------------------- daily report email

function reportTo() { return String(setting('Report email to') || '').trim() || Session.getEffectiveUser().getEmail(); }

function sendReport(event, day) {
  const dl = dayRow(event, day, false);
  if (!dl || dl.r['Report sent']) return;
  const r = dl.r, e = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  const roster = rosterFor(day).filter(function (x) { return x.event === event; });
  const shifts = readRows('timesheet').filter(function (t) { return String(t.Event) === event && dstr(t.Date) === day; });
  const raised = alertsFor(event, day);
  const alerts = raised.filter(function (a) { return !a.resolvedBy; }).map(function (a) { return a.text; });
  const resolved = raised.filter(function (a) { return a.resolvedBy; });

  shifts.forEach(function (t) {
    const n = nameOf(t.Staff);
    if (t['Late (min)']) alerts.push(n + ' late by ' + t['Late (min)'] + ' min');
    if (/^(Not rostered|Rostered at)/.test(String(t.Roster))) alerts.push(n + ': ' + t.Roster);
    String(t['Clock-out flag'] || '').split('; ').filter(function (f) { return /early|No clock-out/.test(f); })
      .forEach(function (f) { alerts.push(n + ': ' + f); });
    if (!t['Clock out']) alerts.push(n + ' never clocked out');
  });
  roster.forEach(function (x) {
    if (shifts.some(function (t) { return t.Staff === x.staff; })) return;
    const went = readRows('timesheet').filter(function (t) { return t.Staff === x.staff && dstr(t.Date) === day; })[0];
    alerts.push(nameOf(x.staff) + (went ? ' rostered here ' + hm(x.start) + '–' + hm(x.end) + ' but clocked in at ' + went.Event
                                        : ' no-show (rostered ' + hm(x.start) + '–' + hm(x.end) + ')'));
  });
  if (!roster.length) alerts.push('No roster set for this event, so lateness could not be checked');
  if (!r['Opening done']) alerts.push('Opening evidence not submitted');
  if (!r['Stock take done']) alerts.push('Stock take not submitted');
  if (!r['Closing done']) alerts.push('Closing evidence not submitted');
  if (r['Stop sale'] && r['Last clock-out'] && tmin(r['Last clock-out']) - tmin(r['Stop sale']) > (Number(setting('Closing target (min)')) || 30)) {
    alerts.push('Closing took ' + (tmin(r['Last clock-out']) - tmin(r['Stop sale'])) + ' min from stop sale (target ' + (Number(setting('Closing target (min)')) || 30) + ')');
  }
  const low = latestStock(event, day).filter(function (s) { return s.low; });
  if (low.length) alerts.push('Low stock: ' + low.map(function (s) { return s.item + ' (' + s.category.replace(/ \(.*\)/, '') + ') ' + s.count + '/' + s.min; }).join(', '));

  const row = function (k, v) { return '<tr><td style="color:#8f7f87;padding:3px 14px 3px 0;vertical-align:top">' + e(k) + '</td><td>' + v + '</td></tr>'; };
  let html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#2a1a22;max-width:600px">';
  html += alerts.length
    ? '<div style="background:#fff3d4;border-radius:10px;padding:12px 14px;margin-bottom:14px"><b style="color:#a86400">⚠ ' + alerts.length + ' alert' +
      (alerts.length > 1 ? 's' : '') + '</b><ul style="margin:6px 0 0 18px;padding:0">' + alerts.map(function (a) { return '<li>' + e(a) + '</li>'; }).join('') + '</ul></div>'
    : '<div style="background:#e2f5ec;border-radius:10px;padding:12px 14px;margin-bottom:14px;color:#1b8f61"><b>✓ No alerts</b></div>';
  if (resolved.length) html += '<p style="color:#1b8f61;margin:0 0 12px">' + resolved.map(function (a) { return '✓ ' + e(a.text) + ' — sorted by ' + e(a.resolvedBy) + ': ' + e(a.note); }).join('<br>') + '</p>';

  const who = function (k) { return r[k] ? nameOf(r[k]) : ''; };
  html += '<h3 style="margin:16px 0 6px">Timeline</h3><table style="border-collapse:collapse">';
  html += row('First clock-in', e(r['First clock-in'] || '–'));
  html += row('Opening evidence', r['Opening done'] ? e(r['Opening done'] + ' by ' + who('Opening by')) : '<b style="color:#d23349">missing</b>');
  html += row('Stop sale', r['Stop sale'] ? e(r['Stop sale'] + ' by ' + who('Stop sale by') + (r['Early stop reason'] ? ' (early: ' + r['Early stop reason'] + ')' : '')) : '–');
  html += row('Stock take', r['Stock take done'] ? e(r['Stock take done'] + ' by ' + who('Stock take by')) : '<b style="color:#d23349">missing</b>');
  html += row('Closing evidence', r['Closing done'] ? e(r['Closing done'] + ' by ' + who('Closing by') + ' · ' + r['Mins stop sale → closing'] + ' min after stop sale') : '<b style="color:#d23349">missing</b>');
  html += row('Last clock-out', e(r['Last clock-out'] || '–'));
  if (r['Stop sale'] && r['Last clock-out']) {
    const took = tmin(r['Last clock-out']) - tmin(r['Stop sale']), target = Number(setting('Closing target (min)')) || 30;
    html += row('Closing took', e(took + ' min (target ' + target + ')') + (took > target ? ' <b style="color:#d23349">over</b>' : ' ✓'));
  }
  html += '</table>';

  html += '<h3 style="margin:16px 0 6px">Crew</h3><table style="border-collapse:collapse;font-size:13px">' +
    '<tr style="color:#8f7f87"><td style="padding:2px 14px 2px 0">Name</td><td style="padding:2px 14px 2px 0">Roster</td><td style="padding:2px 14px 2px 0">In</td><td style="padding:2px 14px 2px 0">Out</td><td>Flags</td></tr>';
  shifts.forEach(function (t) {
    const fl = [t['Late (min)'] ? 'late ' + t['Late (min)'] + ' min' : '', t['Clock-out flag']].filter(String).join('; ');
    html += '<tr><td style="padding:2px 14px 2px 0"><b>' + e(nameOf(t.Staff)) + '</b></td><td style="padding:2px 14px 2px 0">' + e(t.Roster) +
      '</td><td style="padding:2px 14px 2px 0">' + e(t['Clock in'] ? fmt(t['Clock in'], 'HH:mm') : '') + '</td><td style="padding:2px 14px 2px 0">' +
      e(t['Clock out'] ? fmt(t['Clock out'], 'HH:mm') : '–') + '</td><td style="color:#a86400">' + e(fl) + '</td></tr>';
  });
  html += '</table>';

  const close = lastRow('closeLog', event, day);
  if (close) {
    html += '<h3 style="margin:16px 0 6px">Closing answers</h3><table style="border-collapse:collapse">';
    ['HitPay total sales', 'HitPay cash sales', 'PayNow sales', 'Orders', 'Cash deposit', 'Cash difference'].forEach(function (k) {
      if (close[k] !== '' && close[k] !== undefined) html += row(k, k === 'Orders' ? e(close[k]) : '$' + Number(close[k]).toFixed(2));
    });
    Object.keys(close).forEach(function (k) {
      if (TABS.closeLog.indexOf(k) < 0 && close[k] !== '' && close[k] !== '✓') html += row(k, e(close[k]));
    });
    if (close.Skipped) html += row('Skipped', e(close.Skipped));
    if (close.Remarks) html += row('Remarks', e(close.Remarks));
    html += '</table>';
  }
  const links = [['Opening photos', r['Opening photos']], ['Closing photos', r['Closing photos']]].filter(function (l) { return l[1]; });
  if (links.length) html += '<p>' + links.map(function (l) { return '📷 <a href="' + l[1] + '">' + l[0] + '</a>'; }).join(' &nbsp; ') + '</p>';

  const stock = latestStock(event, day);
  if (stock.length) {
    html += '<h3 style="margin:16px 0 6px">Stock take</h3><table style="border-collapse:collapse;font-size:13px">';
    let cat = '';
    stock.forEach(function (s) {
      if (s.category !== cat) { cat = s.category; html += '<tr><td colspan="3" style="padding:8px 0 2px;font-weight:bold">' + e(cat) + '</td></tr>'; }
      html += '<tr style="' + (s.low ? 'background:#fff3d4' : '') + '"><td style="padding:2px 14px 2px 0">' + e(s.item) + '</td><td style="padding:2px 14px 2px 0"><b>' +
        e(s.count) + '</b> ' + e(s.count === 'N/A' ? '' : s.unit) + '</td><td style="color:#8f7f87">min ' + e(s.min) + (s.low ? ' ⚠' : '') + '</td></tr>';
    });
    html += '</table>';
  }
  html += '</div>';

  MailApp.sendEmail({
    to: reportTo(),
    subject: (alerts.length ? '⚠ ' : '✅ ') + event + ' · ' + fmt(new Date(day + 'T12:00:00'), 'd MMM') + ' · ' +
             (r['Closing done'] ? 'closed' : 'NOT closed') + (alerts.length ? ' · ' + alerts.length + ' alert' + (alerts.length > 1 ? 's' : '') : ''),
    htmlBody: html,
  });
  logRow('dayLog', { 'Report sent': fmt(new Date(), 'yyyy-MM-dd HH:mm') }, dl.row);
}

function lastRow(key, event, day) {
  const rs = readRows(key).filter(function (r) { return String(r.Event) === event && dstr(r.Date) === day; });
  return rs.length ? rs[rs.length - 1] : null;
}
// The most recent stock take submission for an event + day.
function latestStock(event, day) {
  const rs = readRows('stockLog').filter(function (r) { return String(r.Event) === event && dstr(r.Date) === day && r.Type !== 'opening'; });
  if (!rs.length) return [];
  const last = String(rs[rs.length - 1].Timestamp);
  return rs.filter(function (r) { return String(r.Timestamp) === last; }).map(function (r) {
    return { category: String(r.Category), item: String(r.Item), unit: String(r.Unit), count: r.Count, min: r.Minimum, low: r['Below minimum'] === 'Y' };
  });
}

// ---------------------------------------------------------------- photos & Drive

function savePhoto(dataUrl, when, name, event, type) {
  return saveImage(dayFolder(when), dataUrl, fmt(when, 'HHmm') + ' ' + name + ' · ' + event + ' · clock ' + type).getUrl();
}
function dayFolder(when) { return subFolder(photoFolder(), fmt(when, 'yyyy-MM-dd')); }
function subFolder(parent, name) { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : parent.createFolder(name); }
function saveImage(folder, dataUrl, baseName) {
  const m = String(dataUrl).match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
  return folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1],
    baseName.replace(/[\/\\]/g, '-') + (m[1] === 'image/png' ? '.png' : '.jpg')));
}
function isPhoto(v) { return /^data:image\/(jpeg|png);base64,/.test(String(v || '')) && String(v).length <= MAX_PHOTO_CHARS; }
function photoFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* deleted — make a new one */ } }
  const f = DriveApp.createFolder(PHOTO_FOLDER);
  props.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}

// ---------------------------------------------------------------- helpers

// Writes obj into a tab by column name (adding any missing column at the end). New row unless rowNum given.
function logRow(key, obj, rowNum) {
  const sh = sheet(key);
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  Object.keys(obj).forEach(function (k) {
    if (head.indexOf(k) < 0) { head.push(k); sh.getRange(1, head.length).setValue(k).setFontWeight('bold'); }
  });
  const r = rowNum || sh.getLastRow() + 1;
  const cur = rowNum ? sh.getRange(r, 1, 1, head.length).getValues()[0] : head.map(function () { return ''; });
  head.forEach(function (h, i) { if (Object.prototype.hasOwnProperty.call(obj, h)) cur[i] = obj[h]; });
  sh.getRange(r, 1, 1, head.length).setValues([cur]);
  _cache[key] = null;
  return r;
}
function findRow(key, col, value) {
  const rs = readRows(key);
  for (let i = 0; i < rs.length; i++) if (String(rs[i][col]) === String(value)) return { r: rs[i], row: i + 2 };
  return null;
}

const _cache = {};                                  // per-request cache of tab contents
function readRows(key) {
  if (_cache[key]) return _cache[key];
  const v = sheet(key).getDataRange().getValues();
  const head = v.shift().map(function (h) { return String(h).trim(); });
  return (_cache[key] = v.map(function (r) { const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; }));
}
function settingsMap() { const s = {}; readRows('settings').forEach(function (r) { if (r.Setting) s[r.Setting] = r.Value; }); return s; }
function setting(name) { const v = settingsMap()[name]; return v === undefined ? '' : v; }
// Gets a tab, creating it (with headers and starter rows) if it's missing, e.g. after an upgrade adds a new tab.
function sheet(key) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(NAMES[key]);
  if (sh) return sh;
  sh = ss.insertSheet(NAMES[key]);
  if (TEXT_TABS.indexOf(key) >= 0) sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
  sh.getRange(1, 1, 1, TABS[key].length).setValues([TABS[key]]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (STARTER[key]) {
    const w = TABS[key].length;
    const data = STARTER[key].map(function (r) { const x = r.slice(0, w); while (x.length < w) x.push(''); return x; });
    sh.getRange(2, 1, data.length, w).setValues(data);
  }
  return sh;
}
function isActive(v) { return !(v === false || /^(n|no|false)$/i.test(String(v).trim())); }
function isYes(v) { return v === true || /^(y|yes|true)$/i.test(String(v).trim()); }
function isDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function addDays(day, n) { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return fmt(d, 'yyyy-MM-dd'); }
function dstr(v) { return v instanceof Date ? fmt(v, 'yyyy-MM-dd') : String(v).trim(); }
// Minutes after midnight from a time cell (Date) or text like "14:00", "2pm", "11.30AM". null if blank.
function tmin(v) {
  if (v instanceof Date) return minOfDay(v);
  const m = String(v || '').trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]) % (m[3] ? 12 : 24);
  if (m[3] === 'pm') h += 12;
  return h * 60 + Number(m[2] || 0);
}
function minOfDay(d) { return Number(fmt(d, 'H')) * 60 + Number(fmt(d, 'm')); }
function dur(min) { return min < 60 ? min + ' min' : Math.floor(min / 60) + 'h ' + (min % 60) + 'm'; }
function hm(min) { return min === null || min === undefined ? '' : ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2); }
function clean(s) { return String(s == null ? '' : s).trim().slice(0, 500).replace(/^[=+\-@]/, "'$&"); }  // no formula injection
function fmt(d, f) { return Utilities.formatDate(d instanceof Date ? d : new Date(d), TZ, f); }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
