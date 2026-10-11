const APPOINTMENT_MINUTES = 60;
const DRIVE_BUFFER_MINUTES = 10;
const SLOT_STEP_MINUTES = 15;
const SEARCH_DAYS = 14;

function findAvailableSlots(busy, now, callStartedAt, maxSlots = 3) {
  const earliestStart = new Date(now.getTime() + DRIVE_BUFFER_MINUTES * 60_000);
  const latestStart = new Date(now.getTime() + SEARCH_DAYS * 24 * 60 * 60_000);
  const appointmentMs = APPOINTMENT_MINUTES * 60_000;
  const driveBufferMs = DRIVE_BUFFER_MINUTES * 60_000;
  const slots = [];

  for (
    let start = Math.ceil(earliestStart.getTime() / (SLOT_STEP_MINUTES * 60_000)) *
      SLOT_STEP_MINUTES * 60_000;
    start < latestStart.getTime() && slots.length < maxSlots;
    start += SLOT_STEP_MINUTES * 60_000
  ) {
    const end = start + appointmentMs;
    const conflict = busy.some((period) =>
      start < new Date(period.end).getTime() + driveBufferMs &&
      end > new Date(period.start).getTime() - driveBufferMs,
    );
    if (!conflict) {
      slots.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        withinOneHour: start <= callStartedAt.getTime() + 60 * 60_000,
      });
    }
  }

  if (slots.some((slot) => slot.withinOneHour)) {
    return slots.filter((slot) => slot.withinOneHour);
  }
  return slots;
}

function formatSlot(slot) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(slot.start));
}

module.exports = { APPOINTMENT_MINUTES, DRIVE_BUFFER_MINUTES, findAvailableSlots, formatSlot };
