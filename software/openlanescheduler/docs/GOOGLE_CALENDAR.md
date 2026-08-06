# Google Calendar Integration

Lunar Lanes can sync reservations from Google Calendar. Events on your calendar automatically appear as lane reservations on the status board.

## Setup (Google Workspace)

You'll need to create a free Google Cloud project to get an API key. This uses your existing Workspace login — no separate account, no billing, and no credit card required.

### Step 1: Create a Google Cloud Project

1. Sign into your Workspace account and go to [console.cloudhttps://console.cloud.google.com/.google.com]()
2. You'll be prompted to agree to the Terms of Service — check the box and click **Agree and Continue**
3. Click the project dropdown at the top left of the page (it may say "Select a project")
4. Click **New Project**
5. Name it something like `Lunar Lanes` and click **Create**
6. Make sure your new project is selected in the dropdown

> **Note:** If you see an error that project creation is restricted, your Workspace admin needs to allow it. Ask them to enable project creation for your account, or have them create the project for you.

### Step 2: Enable the Calendar API

1. In the left sidebar, go to **APIs & Services > Library** (or search "Library" in the top search bar)
2. Search for **Google Calendar API**
3. Click it, then click **Enable**

### Step 3: Create an API Key

1. In the left sidebar, go to **APIs & Services > Credentials**
2. Click **+ Create Credentials** at the top, then **API key**
3. A dialog will show your new key — copy it and save it somewhere safe
4. Click **Edit API key** (or click the key name in the list)
5. Under **API restrictions**, select **Restrict key** and choose **Google Calendar API** only
6. Click **Save**

That's it for the Google Cloud side. You won't need to go back there.

### Step 4: Create a Calendar for Reservations

You can use an existing calendar, but a dedicated one is recommended so it stays clean.

1. Open [calendar.google.com](https://calendar.google.com)
2. On the left sidebar under "Other calendars", click **+** > **Create new calendar**
3. Name it something like `Lane Reservations`
4. Click **Create calendar**

### Step 5: Make the Calendar Public

The API key method reads the calendar as a public resource, so it needs to be shared publicly.

1. In Google Calendar, find your new calendar in the left sidebar
2. Click the three dots next to it > **Settings and sharing**
3. Scroll to **Access permissions for events**
4. Check **Make available to public** and choose **See all event details**

> **Workspace note:** If this option is grayed out, your Workspace admin has disabled public calendar sharing. Ask them to enable it under **Admin Console > Apps > Google Workspace > Calendar > Sharing settings > External sharing options**. They should select "Share all information, and outsiders can change calendars".

5. Scroll down to **Integrate calendar**
6. Copy the **Calendar ID** — it will look like `your-org.com_abc123@group.calendar.google.com`

### Step 6: Configure Lunar Lanes

Edit `docker-compose.yml` and uncomment/fill in the calendar environment variables:

```yaml
backend:
  environment:
    - PORT=3001
    - REDIS_URL=redis://redis:6379
    - GCAL_API_KEY=AIzaSy...your-key-here
    - GCAL_MODE=single
    - GCAL_CALENDAR_ID=your-org.com_abc123@group.calendar.google.com
    - GCAL_SYNC_INTERVAL=120000
```

Then restart the backend:

```
docker compose up -d backend
```

Check the logs to confirm it connected:

```
docker compose logs backend --tail 20
```

You should see `GCal sync enabled (every 120s)` with no errors.

## Creating Reservation Events

### Event Title Format

For single-calendar mode, the event title tells Lunar Lanes which lane the reservation is for:

```
Lane 3 - Smith Party
```

The format is **Lane [number] - [party name]**. Events that don't match this pattern are ignored, so your other calendar events won't interfere.

### Event Time

The start and end time of the calendar event map directly to the reservation time block on the board. Just create the event at the time the lane is reserved.

### Optional Details

Add any of these to the event **description** to override defaults:

```
guests: 6
type: hourly
hours: 2
paid: false
```

| Field | Default | Notes |
|---|---|---|
| `guests` | `4` | Number of guests in the party |
| `type` | `hourly` | `hourly` or `per-game` |
| `hours` | *(from event duration)* | Override for hourly reservations |
| `games` | `2` | Number of games for per-game reservations |
| `paid` | `false` | Whether the reservation is pre-paid |

If you leave the description blank, Lunar Lanes will default to 4 guests, hourly type, and infer the duration from the event start/end times. That's usually all you need.

## Keeping 8 Lanes Organized on One Calendar

### Color-Code by Lane

Assign a consistent Google Calendar color to each lane so you can visually scan the calendar:

| Lane | Color |
|---|---|
| 1 | Tomato (red) |
| 2 | Flamingo (pink) |
| 3 | Tangerine (orange) |
| 4 | Banana (yellow) |
| 5 | Sage (light green) |
| 6 | Basil (dark green) |
| 7 | Blueberry (blue) |
| 8 | Lavender (purple) |

To set an event's color: click the event, click the edit pencil, then click the colored circle next to the title.

### Daily View is Your Friend

Switch Google Calendar to **Day view** when managing reservations. You'll see all 8 lanes stacked as time blocks, color-coded, making conflicts immediately visible.

### Quick-Add Shortcut

In Google Calendar, press **Q** to quick-add an event. Type something like:

```
Lane 4 - Birthday Party 2pm-5pm today
```

Google will parse the time automatically and create the event.

## Alternative: Multi-Calendar Mode

If you prefer a separate calendar per lane (cleaner, but more setup), create 8 calendars and configure multi mode:

```yaml
- GCAL_MODE=multi
- GCAL_CALENDAR_IDS=cal-id-lane1,cal-id-lane2,cal-id-lane3,cal-id-lane4,cal-id-lane5,cal-id-lane6,cal-id-lane7,cal-id-lane8
```

Each calendar maps to a lane in order. Event titles are just the party name — no "Lane X" prefix needed.

## Syncing

Lunar Lanes polls the calendar every 2 minutes by default (configurable via `GCAL_SYNC_INTERVAL`).

To force an immediate sync after making calendar changes:

```
curl -X POST http://localhost:3001/api/sync
```

Or from another device on your network:

```
curl -X POST http://<your-ip>:3001/api/sync
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "GCal fetch error" in logs | Double-check your API key and calendar ID. Make sure the Calendar API is enabled. |
| Events not appearing | Verify the calendar is public. Check the event title matches `Lane X - Name` format. |
| Can't make calendar public | Your Workspace admin needs to enable external sharing (see Step 5 above). |
| "Project creation restricted" | Ask your Workspace admin to create the Cloud project or grant you permission. |
| Sync is slow | Lower `GCAL_SYNC_INTERVAL` (e.g., `60000` for 1 minute). Don't go below 30 seconds. |
