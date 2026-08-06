# OpenLane Scheduler User Manual
**For Counter Staff**

---

## Quick Start

**Opening the Manager Dashboard:**
1. Open your web browser
2. Navigate to the manager dashboard (typically `http://localhost:8080` or your server address)
3. The dashboard will show all 8 lanes in real-time

**What You'll See:**
- **Lanes View** - Current status of all lanes at a glance
- **Timeline View** - Visual schedule of reservations throughout the day
- **Reservation Form** - Create new bookings

---

## Managing Walk-Ins

### Opening a Walk-In Session

1. Click the **"OPEN WALK-IN"** button on the lane card
2. Choose the billing type:
   - **Hourly** - Customer pays by the hour (1-4 hours)
   - **Per-Game** - Customer pays per game (1-20 games)
3. Set the number of bowlers (1-8 people)
4. Click **"OPEN"**

**The lane will now show:**
- Active status (green)
- Countdown timer (for hourly bookings)
- Number of bowlers
- Billing type

### Closing a Walk-In Session

1. When the customer is done, click **"CLOSE WALK-IN"** on the lane card
2. The lane returns to idle (gray) and is ready for the next customer

### Payment Tracking

- Click **"MARK PAID"** when the customer pays
- The indicator will turn green
- You can toggle this on/off if needed

---

## Managing Reservations

### Creating a New Reservation

1. Click **"NEW RESERVATION"** at the top right
2. Follow the 4-step process:

**Step 1: Select Date & Duration**
- Click a date on the calendar
- Dates with existing reservations show blue dots
- Choose duration (2, 3, or 4 hours)

**Step 2: Select Time**
- Pick the start time from available slots
- Unavailable times are grayed out (conflicts with other bookings)

**Step 3: Select Lane(s)**
- Click one or more lanes for the party
- Select multiple lanes for large groups
- Unavailable lanes show why (walk-in, reservation, maintenance)

**Step 4: Party Details**
- Enter party name (e.g., "Smith Birthday")
- Enter contact info (phone or email)
- Select number of guests (10, 20, 30, 40, or 50)
- Click **"CREATE RESERVATION"**

**Important:** Reservations automatically sync to Google Calendar!

### Viewing Reservations

**In Lanes View:**
- Upcoming reservations show below each lane
- Shows party name and start time

**In Timeline View:**
- Click **"TIMELINE"** at the top
- Choose view mode:
  - **Hour** - Current time window (2-4 hours)
  - **Day** - Full business day (9 AM - 8 PM)
  - **Week** - 7-day overview with reservation counts
  - **Month** - Calendar view with daily totals

### Marking Arrival

When a reservation party arrives:
1. Find their lane card
2. Click **"MARK ARRIVED"**
3. The indicator turns green

### Canceling a Reservation

1. Click **"CANCEL"** on the lane card
2. The reservation grays out but stays visible
3. The lane becomes available for other bookings

### Deleting a Reservation

1. Click **"DELETE"** on the lane card
2. **Warning:** This permanently removes the booking from both the system AND Google Calendar
3. Use "Cancel" instead if you want to keep the record

---

## Lane Maintenance

### Putting a Lane in Maintenance Mode

1. Click **"MAINT"** on the lane card
2. The lane shows orange "MAINTENANCE" status
3. Lane becomes unavailable for walk-ins and reservations
4. Kiosk displays show caution stripes

### Taking a Lane Out of Maintenance

1. Click **"MAINT"** again to toggle off
2. Lane returns to idle (gray) and becomes available

**Note:** Close any active walk-ins before putting a lane in maintenance

---

## Responding to Service Calls

### When a Kiosk Service Call Comes In

**You'll see:**
- Lane card shows yellow "SERVICE CALL" status
- Timestamp of when the call was made

**To Respond:**
1. Click **"ACKNOWLEDGE"** on the lane card
2. Status changes to "STAFF RESPONDING" (amber, pulsing)
3. Head to the lane to assist the customer
4. After fixing the issue, click **"RESOLVE"** to clear the call

### Initiating a Service Call from Manager

If you notice an issue:
1. Click **"SERVICE CALL"** on the lane card
2. This alerts staff that the lane needs attention
3. Follow the same process to acknowledge and resolve

---

## Understanding Lane Status

### Status Colors

- **Gray (IDLE)** - Lane is empty and available
- **Green (ACTIVE)** - Walk-in session in progress
- **Blue (RESERVATION)** - Party has a booking
- **Yellow (SERVICE CALL)** - Help requested, not yet acknowledged
- **Amber (STAFF RESPONDING)** - Help acknowledged, staff en route
- **Orange (MAINTENANCE)** - Lane offline for repairs

### Lane Cards Show

- Current status
- Active walk-in details (bowlers, time, type)
- Current reservation (party name, time)
- Upcoming reservation (if scheduled today)
- Payment status
- Service call status

---

## Common Scenarios

### Large Party (Multiple Lanes)

**For Walk-Ins:**
1. Open walk-in on first lane
2. Open walk-in on second lane (same settings)
3. Treat as separate bookings (they can pay separately)

**For Reservations:**
1. During lane selection (Step 3), click multiple lanes
2. System creates linked reservations
3. All lanes show same party name

### Customer Wants to Extend Time

**For Hourly Walk-Ins:**
1. Close the current session
2. Open a new walk-in with additional hours
3. Or just let the timer run - counter will track total time

**For Reservations:**
1. Check if lane is available after their end time
2. Create a new reservation for the extended period
3. Or cancel and recreate with longer duration

### Handling No-Shows

1. Wait 15 minutes past start time
2. If party doesn't arrive, click **"CANCEL"**
3. Lane becomes available for walk-ins
4. Reservation stays visible but grayed out

### Double-Booking Prevention

The system automatically prevents conflicts:
- Can't book a time slot that overlaps with existing reservation
- Can't book a lane with an active walk-in (unless walk-in ends before reservation starts)
- Can't book a lane in maintenance mode

### Timer Expired on Hourly Walk-In

When the countdown reaches 00:00:00:
- **Kiosk shows:** Red "⚠️ TIME EXPIRED ⚠️" warning
- **Buttons disabled:** Customer can't request service or cycle pinsetter
- **Action:** Visit the lane to either close session or extend time

---

## Timeline Views Explained

### Hour View (Current)
- Shows 2-4 hour window around current time
- Yellow line = current time
- Great for "what's happening right now"

### Day View (9 AM - 8 PM)
- Full business day schedule
- Navigate: Prev Day / Today / Next Day
- See all reservations for selected date

### Week View (7-Day Grid)
- Sunday through Saturday
- Number in each cell = reservation count for that lane/day
- Click any cell to jump to Day View for details

### Month View (Calendar)
- Full month calendar
- Number on each date = total reservations (all lanes)
- Today's date highlighted in green
- Click any date to jump to Day View

---

## Troubleshooting

### "Lane currently has a walk-in" error
- Someone is actively using the lane
- Wait until walk-in closes OR
- If walk-in time is almost up, book reservation for after estimated close time

### Reservation not appearing
- Check you're viewing the correct date
- Verify it's not marked as cancelled
- Switch to Timeline view and navigate to the booking date

### Can't mark payment/arrival
- Make sure you're clicking the correct lane card
- Buttons only appear when there's an active booking

### Google Calendar not syncing
- Reservations may take 1-2 minutes to appear in calendar
- Check backend logs if sync fails after 5 minutes
- Contact technical support

### Kiosk not responding
- Check that backend server is running
- Kiosks auto-reconnect if connection drops
- Refresh kiosk browser if needed (F5)

---

## Tips for Smooth Operation

✅ **Check Timeline view at shift start** - Know what's coming up

✅ **Mark arrivals promptly** - Helps track which parties are present

✅ **Acknowledge service calls quickly** - Customers see "STAFF RESPONDING" on kiosk

✅ **Use cancellation instead of deletion** - Keeps booking history

✅ **Close walk-ins when customers leave** - Keeps lane status accurate

✅ **Verify contact info** - Important for communicating with reservation parties

✅ **Use maintenance mode properly** - Prevents bookings on broken lanes

---

## Quick Reference

| Task | Action |
|------|--------|
| Start walk-in | OPEN WALK-IN → Choose type → Set bowlers → OPEN |
| End walk-in | CLOSE WALK-IN |
| New booking | NEW RESERVATION → Date → Time → Lane(s) → Details |
| Mark paid | MARK PAID (toggle on lane card) |
| Party arrived | MARK ARRIVED (toggle on lane card) |
| Cancel booking | CANCEL (keeps record) |
| Remove booking | DELETE (permanent, removes from calendar) |
| Lane broken | MAINT (toggle on lane card) |
| Respond to call | ACKNOWLEDGE → RESOLVE |
| View schedule | TIMELINE → Choose Hour/Day/Week/Month |

---

## Support

**If you encounter issues:**
1. Note exactly what you were doing
2. Check if error message appears (bottom right)
3. Try refreshing the browser (F5)
4. Contact technical support with details

**Remember:** The system syncs in real-time. Changes you make appear instantly on all displays, including kiosks.

---

**Last Updated:** February 2026
**Version:** 1.0
