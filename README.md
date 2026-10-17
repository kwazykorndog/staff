# Kwazy Korndog — staff app

Phone-first staff app for event crew. Plain HTML pages + one Google Apps Script backend (`Code.gs`), no build step.
Staff scan the booth QR, log in once on their phone, and use the hub.

## Roles

| Role | Can do |
|---|---|
| **Crew** | Clock in/out (selfie prompt), opening/closing evidence, stop sale, stock take, own roster and hours (My shifts), notices, handbook, expense claims |
| **Manager** (Rebecca) | Everything an admin can do, **except**: approve their own claims or fix their own hours, add/edit managers and admins or change roles, reset an admin's password, change settings or delete history |
| **Admin** (Jay, Hazel) | Everything |

Logins are username + password. New people get a temporary password from the app and must set their own at first
login. Admins and managers reset forgotten passwords (managers for crew only). Passwords are stored hashed. Sessions
last 30 days per phone. A password reset, role change or deactivation logs that person out everywhere. 5 wrong
passwords lock the account for 10 minutes.

## Pages

A tab bar along the bottom: **Today · Notices · Learn · Me**, plus **Manage** for managers and admins.
Expense claims and (soon) payslips live under **Me**. Live view, roster, people and events live under **Manage**.


| Page | Who | What |
|---|---|---|
| `login.html` | everyone | Log in, set own password |
| `index.html` | everyone | **Today** tab: big Clock in card; once clocked in, your next step + today's shift. "Needs you" lists new notices, handbook updates, claims to approve |
| `clock.html` | everyone | Clock in (event + selfie prompt, lateness vs roster) and clock out (last person must close first) |
| `checklist.html?shift=Opening/Stock/Closing` | everyone | Evidence tiles in any order (each with a 📖 How to link), photos saved as taken, stock take |
| `notices.html` | everyone | Read notices, tap "Got it" on must-read ones. Managers/admins post, pin, target an event, set expiry, see who's read it |
| `handbook.html` | everyone | **Learn** tab: handbook / SOPs as numbered pointers, each with an optional photo reference. Searchable, "New/Updated" badges. Managers/admins add, reorder and edit pointers |
| `claims.html` | everyone | Submit expense claims with a receipt photo, track status. Managers/admins approve, reject, mark paid |
| `me.html` | everyone | Upcoming shifts, this month's hours, recent clock-ins, change password |
| `live.html` | manager, admin | Who's on site / late / missing, progress, alerts, standby, fix clock-outs |
| `admin.html` | manager, admin | Roster builder, People, Events + QR codes (pick a stock template when creating), Audit trail |
| `payroll.html` | manager, admin | **Hours** per person per month (rounded to 15 min, fix a time with a reason) and **Payslips**: allowances, deductions, CPF, publish, CSV export |
| `payslips.html` | everyone | Your published payslips, itemised (Me → Payslips) |
| `cash.html` | manager, admin | Cash bags from closing: **received** from the closer → **banked** with a deposit slip photo. Shows what's not banked and who's holding it |
| `sales.html` | manager, admin | Sales by day and event from the HitPay totals entered at closing: total, orders, average order, cash vs PayNow |
| `stock.html` | manager, admin | Stock on hand at each running event, restock list with **Copy order for WhatsApp**, enter opening stock, edit an event's minimums, manage stock templates |

The handbook starts pre-filled from the **Event Crew Handbook v1.0**, with the clock-in and closing steps updated
for this app. Edit it in the app.

## Money

- **Pay setup**: in Manage → People, set each person to hourly (rate per hour) or monthly salary. **Only admins** set or
  change pay; managers can see it but not edit it.
- **Hours** = clock-in to clock-out, breaks paid, each shift rounded to the nearest 15 minutes. No overtime rate.
  Managers can fix a time with a reason (logged), but not their own, and not once that month's payslip is published.
- **Payroll** runs by calendar month: publish by the 7th of the next month. Basic pay = hours × rate (or the monthly
  salary), plus allowance lines, minus deduction lines and CPF employee (typed in from the CPF calculator). Approved
  expense claims are added as reimbursements and marked paid when the payslip is published. Published payslips are
  frozen. Managers can't prepare or publish their own payslip. Set `Company name` in Settings to your registered name.
  **Have your accountant check the first payslip** against MOM's itemised payslip requirements.
- **Cash the crew hold**: the closer holds the cash bag. Within **3 days** (`Cash hand-in days` in Settings) they must
  either hand it to a manager (who taps **Received** and checks the amount) or bank it in or transfer it themselves and
  upload the slip or screenshot under **Me** (a manager then verifies it). Until then it's a red card at the top of their
  Today screen. Once overdue it pulses, and managers see a red "chase it" card too. Put the company's bank/PayNow details
  in `Bank transfer details` so crew know where to send it.
- **Cash count at closing**: there's no float. Crew don't see HitPay, so they only count the cash in the bag. A manager
  or admin then enters that day's **HitPay totals** (total, cash, PayNow, orders) under Manage → Cash → **Check sales**.
  If cash sales and the bag differ by more than `Cash tolerance ($)`, the closer gets a **question on their Today
  screen** to explain, and it stays open until a manager marks it sorted. The Sales dashboard uses these checked totals.

## Stock

- **Templates** (Bazaar, 3-day event, 1-day event, or your own) set a **minimum** (flag when below) and a **top-up level**
  (order up to this) per item. A blank minimum means the item isn't carried at that kind of event. The starter numbers
  are placeholders: Bazaar and 3-day use the handbook minimums, 1-day halves the corndog minimums, and top-up is
  double the minimum for corndogs or minimum + 1 for supplies. Edit them.
- **Creating an event** copies a template's levels to that event. Change any number per event; editing a template
  later doesn't touch existing events.
- **Opening stock** is entered by the manager when stock is sent. Each **closing stock take** by the crew updates what's
  on hand. **Restock = top-up level − on hand** for anything below its minimum.

## Who does the checklist

On the roster, mark one shift **⭐ In charge**. That person does the opening and closing checklist; everyone else just
clocks in and out (their Today screen says who's in charge). If nobody is marked, or the person in charge isn't on site,
anyone clocked in can do it. The last person on site still has to close. When the closer clocks out, they're told how
long closing took from stop sale: under `Closing target (min)` (30) is "Good job!", over it gets a nudge, and the report
email flags it.

Managers and admins see a **Live today** panel on their Today screen: who's on shift, who's in charge, who's late, and
who's on standby as backup.

## A shift day

Clock in → opening evidence → **Stop sale** (unlocks 30 min before the latest roster end; earlier needs a reason) →
stock take → closing evidence → clock out. The **last person clocked in** at an event can't clock out until stock take
and closing evidence are in (or they give a reason, which is flagged). The roster only creates flags (late, no-show,
left early), so roster changes on the day never lock anyone in. The **daily report email** goes when the last person
clocks out (or at 3am if nobody did).

## Set up (about 15 minutes)

1. Create a Google Sheet called **KK Staff** → **Extensions → Apps Script** → paste all of `Code.gs` → 💾 Save.
2. Run `setup` and allow the permissions (Sheets, Drive for photos, Gmail for reports, triggers for the 3am sweep).
3. Open **Execution log**. It shows `username: jay  temporary password: ……`. That's your first admin login.
4. **Deploy → New deployment → Web app**, Execute as **Me**, access **Anyone** → copy the `/exec` URL into `KK_API` in `kk.js`.
5. Put the site online (below), log in as `jay`, set your password, then in **Admin**:
   - **Events**: add your events (dates, colour).
   - **People**: add Hazel (admin), Rebecca (manager) and the crew. Send each one the message the app gives you.
   - **Roster**: tap cells to add shifts, or **Copy last week**.
   - **Events → QR code**: print one for each booth.
6. In the Sheet's **Settings** tab, put report email addresses next to `Report email to`.

Changed `Code.gs` later? **Deploy → Manage deployments → ✏️ → New version → Deploy** (same URL). Any new tabs an
update needs are created automatically the first time they're used.

## Put it online (GitHub Pages, free)

Upload all the `.html` files plus `kk.js`, `kk.css`, `demo.js` and `Code.gs` to a public GitHub repo → Settings → Pages → Deploy from `main`.

## Still edited in the Sheet (for now)

Checklist items, stock items and minimums, selfie prompts, and settings (`Late after (min)`, `Stop sale before end (min)`,
`Cash tolerance ($)`, `Report email to`). Editing these in the app is planned for phase 3.

Logs to read in the Sheet: Timesheet, Day Log, Alerts, Opening / Closing Log, Stock Count Log, Photo Log, Audit,
Notices / Notice Acks, Handbook / Handbook Acks, Expense Claims.

Notice, handbook and receipt photos are shared as "anyone with the link can view" so they show in the app. Evidence
and clock-in selfies stay private in your Drive.

## Demo mode

With `KK_API` blank, the app runs the real `Code.gs` inside the browser against a pretend spreadsheet saved on that
phone (`demo.js`). Demo logins: `jay` / `hazel` (admin), `rebecca` (manager), `khin` (crew), password `demo123`. "Reset demo" in
the yellow bar starts over.
