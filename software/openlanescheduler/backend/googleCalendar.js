const { google } = require('googleapis');

class GoogleCalendarClient {
  constructor(serviceAccountJson, calendarId) {
    if (!serviceAccountJson) {
      throw new Error('Service account credentials not provided');
    }

    try {
      const credentials = typeof serviceAccountJson === 'string'
        ? JSON.parse(serviceAccountJson)
        : serviceAccountJson;

      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });

      this.calendar = google.calendar({ version: 'v3', auth: this.auth });
      this.calendarId = calendarId || 'primary';
    } catch (error) {
      throw new Error(`Failed to initialize Google Calendar client: ${error.message}`);
    }
  }

  /**
   * Format reservation data into Google Calendar event format
   */
  formatReservationToEvent(reservation) {
    const { date, start, end, lane, party, contact, guests, type, hours, games } = reservation;

    // Parse date and time (handle both 'start' and 'startTime' for compatibility)
    const startTime = start || reservation.startTime;
    const endTime = end || reservation.endTime;

    const startDateTime = new Date(`${date}T${startTime}`);
    const endDateTime = new Date(`${date}T${endTime}`);

    // Format description with reservation details
    const description = [
      `guests: ${guests || 0}`,
      `type: ${type || 'per-game'}`,
      hours !== undefined ? `hours: ${hours}` : null,
      games !== undefined ? `games: ${games}` : null,
      contact ? `contact: ${contact}` : null,
      `paid: false`
    ].filter(Boolean).join('\n');

    return {
      summary: `Lane ${lane} - ${party}`,
      description,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'America/Chicago',
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'America/Chicago',
      },
      colorId: '9', // Blue color to differentiate from manual entries
    };
  }

  /**
   * Create a new calendar event
   */
  async createEvent(reservation) {
    try {
      console.log(`[GCal] Creating event for lane ${reservation.lane}, party: ${reservation.party}`);
      const event = this.formatReservationToEvent(reservation);
      console.log(`[GCal] Event formatted, calling API with calendarId: ${this.calendarId}`);

      // Add timeout wrapper to prevent hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Google Calendar API timeout (30s)')), 30000)
      );

      const insertPromise = this.calendar.events.insert({
        calendarId: this.calendarId,
        resource: event,
      });

      const response = await Promise.race([insertPromise, timeoutPromise]);

      console.log(`[GCal] Created Google Calendar event: ${response.data.id}`);
      return {
        success: true,
        eventId: response.data.id,
        event: response.data,
      };
    } catch (error) {
      console.error('[GCal] Failed to create Google Calendar event:', error.message);
      console.error('[GCal] Error details:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Update an existing calendar event
   */
  async updateEvent(eventId, reservation) {
    try {
      const event = this.formatReservationToEvent(reservation);

      const response = await this.calendar.events.update({
        calendarId: this.calendarId,
        eventId,
        resource: event,
      });

      console.log(`Updated Google Calendar event: ${response.data.id}`);
      return {
        success: true,
        event: response.data,
      };
    } catch (error) {
      console.error('Failed to update Google Calendar event:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Delete a calendar event
   */
  async deleteEvent(eventId) {
    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId,
      });

      console.log(`Deleted Google Calendar event: ${eventId}`);
      return {
        success: true,
      };
    } catch (error) {
      // If event not found, consider it a success (already deleted)
      if (error.code === 404 || error.message.includes('Not Found')) {
        console.log(`Event ${eventId} not found (already deleted)`);
        return {
          success: true,
        };
      }

      console.error('Failed to delete Google Calendar event:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get events within a date range (for conflict checking)
   */
  async getEvents(timeMin, timeMax) {
    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return {
        success: true,
        events: response.data.items || [],
      };
    } catch (error) {
      console.error('Failed to fetch Google Calendar events:', error.message);
      return {
        success: false,
        error: error.message,
        events: [],
      };
    }
  }
}

module.exports = GoogleCalendarClient;
